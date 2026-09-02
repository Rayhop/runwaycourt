import "server-only"

import { getAdapter, getConfiguredKind, getSimulator } from "@/lib/filecoin"
import type { VerdictExecution } from "@/lib/filecoin/types"
import { getServiceClient } from "@/lib/supabase/server"
import type { FileRow } from "@/lib/supabase/types"
import type { AgentScope } from "./scope"
import { narrateSession, narrateVerdict } from "./narrate"
import { budgetPerEpoch, rankFiles, scoreFile } from "./scoring"
import { decideVerdicts, spendPerEpoch } from "./verdicts"

export { decideVerdicts } from "./verdicts"

/**
 * A court session, start to finish:
 *
 *   1. read vitals          -- the agent's real runway
 *   2. score every file     -- Survival Score
 *   3. rank                 -- best-defended first
 *   4. spend down a budget  -- KEEP until the money runs out
 *   5. verdict the rest     -- DOWNGRADE if salvageable, else DROP
 *   6. execute              -- through the Filecoin adapter
 *   7. narrate              -- one line per verdict, one summary per session
 *
 * Steps 4-5 are where the autonomy is visible, so they stay simple and are
 * recorded verbatim in the DB for the dashboard to replay.
 */

export interface SessionResult {
  sessionId: number
  triggered: boolean
  reason: string
  runwayBeforeEpochs: number
  runwayAfterEpochs: number
  kept: number
  downgraded: number
  dropped: number
  narration: string
}

/** Count retrievals per file in the last 7 days. */
async function accessCounts(fileIds: string[]): Promise<Map<string, number>> {
  const supabase = getServiceClient()
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

  const counts = new Map<string, number>()
  if (fileIds.length === 0) return counts

  const { data, error } = await supabase
    .from("access_events")
    .select("file_id")
    .gte("occurred_at", since)
    .in("file_id", fileIds)

  if (error) throw new Error(`Failed to read access_events: ${error.message}`)

  for (const row of (data ?? []) as { file_id: string }[]) {
    counts.set(row.file_id, (counts.get(row.file_id) ?? 0) + 1)
  }
  return counts
}

/**
 * Run a session.
 *
 * @param force  Open a session even if runway is above the threshold. This is
 *               the "Convene court" button -- a judge shouldn't have to wait for
 *               the balance to drain to see the mechanic.
 */
export async function runCourtSession(
  scope: AgentScope,
  force = false,
): Promise<SessionResult> {
  const supabase = getServiceClient()
  const adapter = getAdapter(scope)
  const kind = getConfiguredKind()
  const account = scope.account

  const vitalsBefore = await adapter.getVitals()
  const runwayBefore = vitalsBefore.runwayInEpochs

  // ---- 2. Trigger ---------------------------------------------------------
  const threshold = account.runway_threshold_epochs
  const belowThreshold = runwayBefore < threshold

  if (!force && !belowThreshold) {
    return {
      sessionId: 0,
      triggered: false,
      reason: `Runway ${Math.round(runwayBefore)} epochs is above the ${threshold}-epoch threshold. No session needed.`,
      runwayBeforeEpochs: runwayBefore,
      runwayAfterEpochs: runwayBefore,
      kept: 0,
      downgraded: 0,
      dropped: 0,
      narration: "",
    }
  }

  const { data: filesData, error: filesError } = await supabase
    .from("files")
    .select("*")
    .eq("user_id", scope.userId)
    .neq("status", "dropped")

  if (filesError) throw new Error(`Failed to read files: ${filesError.message}`)
  const files = (filesData ?? []) as FileRow[]

  if (files.length === 0) {
    return {
      sessionId: 0,
      triggered: false,
      reason: "No files under management -- nothing to try.",
      runwayBeforeEpochs: runwayBefore,
      runwayAfterEpochs: runwayBefore,
      kept: 0,
      downgraded: 0,
      dropped: 0,
      narration: "",
    }
  }

  // ---- 3. Score and rank --------------------------------------------------
  const counts = await accessCounts(files.map((f) => f.id))
  const now = new Date()
  const ranked = rankFiles(files.map((f) => scoreFile(f, counts.get(f.id) ?? 0, now)))

  // ---- 4/5. Budget and verdicts ------------------------------------------
  const budget = budgetPerEpoch(vitalsBefore.availableFunds, account.target_runway_epochs)
  const decisions = decideVerdicts(ranked, budget)

  const kept = decisions.filter((d) => d.verdict === "KEEP").length
  const downgraded = decisions.filter((d) => d.verdict === "DOWNGRADE").length
  const dropped = decisions.filter((d) => d.verdict === "DROP").length

  // Open the session row up front so the dashboard can show it live.
  const { data: sessionData, error: sessionError } = await supabase
    .from("court_sessions")
    .insert({
      status: "open",
      user_id: scope.userId,
      trigger_runway_epochs: Math.round(Math.min(runwayBefore, Number.MAX_SAFE_INTEGER)),
      runway_before_epochs: Math.round(Math.min(runwayBefore, Number.MAX_SAFE_INTEGER)),
      budget_per_epoch: budget.toString(),
      chain_source: kind,
    })
    .select("id")
    .single()

  if (sessionError) throw new Error(`Failed to open court session: ${sessionError.message}`)
  const sessionId = (sessionData as { id: number }).id

  // ---- 6. Execute ---------------------------------------------------------
  const executions: VerdictExecution[] = decisions.map((d) => ({
    fileId: d.scored.file.id,
    fileName: d.scored.file.name,
    pieceCid: d.scored.file.piece_cid,
    dataSetId: d.scored.file.data_set_id ?? null,
    verdict: d.verdict,
  }))

  const receipts = await adapter.applyVerdicts(executions)
  const receiptById = new Map(receipts.map((r) => [r.fileId, r]))

  // ---- 7. Record verdicts + narration ------------------------------------
  const penalties = decisions.map((d) => d.scored.breakdown.costPenalty).sort((a, b) => a - b)
  const medianPenalty = penalties[Math.floor(penalties.length / 2)] ?? 1

  const verdictRows = decisions.map((d, index) => {
    const receipt = receiptById.get(d.scored.file.id)
    return {
      session_id: sessionId,
      file_id: d.scored.file.id,
      file_name: d.scored.file.name,
      verdict: d.verdict,
      rank: index + 1,
      score: d.scored.score,
      score_breakdown: d.scored.breakdown,
      rationale: narrateVerdict(d.scored, d.verdict, medianPenalty, d.reason),
      tx_hash: receipt?.txHash ?? null,
      executed: receipt?.ok ?? false,
      execution_note: receipt?.detail ?? null,
    }
  })

  const { error: verdictError } = await supabase.from("verdicts").insert(verdictRows)
  if (verdictError) throw new Error(`Failed to record verdicts: ${verdictError.message}`)

  // Persist the drawn-down balance so runway reflects the new burn rate.
  if (kind === "simulator") {
    await getSimulator(scope.userId).settle()
  }

  const vitalsAfter = await adapter.getVitals()
  const runwayAfter = vitalsAfter.runwayInEpochs

  const spend = spendPerEpoch(decisions)

  const narration = narrateSession({
    sessionNumber: sessionId,
    runwayBeforeEpochs: runwayBefore,
    runwayAfterEpochs: runwayAfter,
    triggerRunwayEpochs: threshold,
    kept,
    downgraded,
    dropped,
  })

  const { error: closeError } = await supabase
    .from("court_sessions")
    .update({
      status: "closed",
      closed_at: new Date().toISOString(),
      runway_after_epochs: Math.round(Math.min(runwayAfter, Number.MAX_SAFE_INTEGER)),
      spend_per_epoch: spend.toString(),
      kept_count: kept,
      downgraded_count: downgraded,
      dropped_count: dropped,
      narration,
    })
    .eq("id", sessionId)

  if (closeError) throw new Error(`Failed to close court session: ${closeError.message}`)

  return {
    sessionId,
    triggered: true,
    reason: force && !belowThreshold ? "Session convened manually." : "Runway below threshold.",
    runwayBeforeEpochs: runwayBefore,
    runwayAfterEpochs: runwayAfter,
    kept,
    downgraded,
    dropped,
    narration,
  }
}
