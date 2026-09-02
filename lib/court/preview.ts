import "server-only"

import { getAdapter } from "@/lib/filecoin"
import { SynapseAdapter } from "@/lib/filecoin/synapse"
import { getProofStatuses, type ProofStatus } from "@/lib/filecoin/pdp"
import type { Vitals } from "@/lib/filecoin/types"
import { getServiceClient } from "@/lib/supabase/server"
import type { FileRow, VerdictKind } from "@/lib/supabase/types"
import type { AgentScope } from "./scope"
import { budgetPerEpoch, rankFiles, scoreFile, type ScoredFile } from "./scoring"
import { decideVerdicts, type VerdictReason } from "./verdicts"

/**
 * What the court WOULD do right now, without doing it.
 *
 * Drives the Courtroom panel: every file shows its live Survival Score and the
 * verdict it is currently heading for, so the ranking visibly reorders as
 * runway drains and files get retrieved. Read-only -- nothing is executed and
 * nothing is written.
 */

export interface PreviewFile {
  id: string
  name: string
  sizeBytes: number
  tier: string
  priority: string
  status: string
  costPerEpoch: string
  score: number
  breakdown: ScoredFile["breakdown"]
  projectedVerdict: VerdictKind
  verdictReason: VerdictReason
  rank: number
  dataSetId: string | null
  /** Null in simulator mode, or when the file has no data set. */
  proof: ProofStatus | null
}

export interface CourtPreview {
  vitals: {
    runwayInEpochs: number
    grossCoverageInEpochs: number
    funds: string
    availableFunds: string
    debt: string
    lockupRatePerEpoch: string
    epoch: number
    source: string
    inDeficit: boolean
  }
  thresholdEpochs: number
  targetRunwayEpochs: number
  belowThreshold: boolean
  budgetPerEpoch: string
  files: PreviewFile[]
  /** Synapse mode with no wallet linked: there is no account to read. */
  needsWallet: boolean
  walletAddress: string | null
}

function serialiseVitals(vitals: Vitals): CourtPreview["vitals"] {
  return {
    // JSON has no Infinity; the UI treats -1 as "unlimited".
    runwayInEpochs: Number.isFinite(vitals.runwayInEpochs) ? vitals.runwayInEpochs : -1,
    grossCoverageInEpochs: Number.isFinite(vitals.grossCoverageInEpochs)
      ? vitals.grossCoverageInEpochs
      : -1,
    funds: vitals.funds.toString(),
    availableFunds: vitals.availableFunds.toString(),
    debt: vitals.debt.toString(),
    lockupRatePerEpoch: vitals.lockupRatePerEpoch.toString(),
    epoch: vitals.epoch,
    source: vitals.source,
    inDeficit: vitals.inDeficit,
  }
}

export async function getCourtPreview(scope: AgentScope): Promise<CourtPreview> {
  const supabase = getServiceClient()
  const adapter = getAdapter(scope)
  const account = scope.account

  const { data: filesData, error: filesError } = await supabase
    .from("files")
    .select("*")
    .eq("user_id", scope.userId)
    .neq("status", "dropped")

  if (filesError) throw new Error(`Failed to read files: ${filesError.message}`)

  const files = (filesData ?? []) as FileRow[]

  // In synapse mode the vitals come from the user's own Filecoin Pay account.
  // Without a linked wallet there is simply nothing to read -- report that as a
  // state the UI can act on, rather than failing the whole request.
  let vitals: Awaited<ReturnType<typeof adapter.getVitals>>
  try {
    vitals = await adapter.getVitals()
  } catch (error) {
    if (!scope.walletAddress) {
      return {
        vitals: {
          runwayInEpochs: -1,
          grossCoverageInEpochs: -1,
          funds: "0",
          availableFunds: "0",
          debt: "0",
          lockupRatePerEpoch: "0",
          epoch: 0,
          source: adapter.kind,
          inDeficit: false,
        },
        thresholdEpochs: account.runway_threshold_epochs,
        targetRunwayEpochs: account.target_runway_epochs,
        belowThreshold: false,
        budgetPerEpoch: "0",
        files: [],
        needsWallet: true,
        walletAddress: null,
      }
    }
    throw error
  }

  // Access counts over the last 7 days.
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
  const counts = new Map<string, number>()

  if (files.length > 0) {
    const { data: events, error: eventsError } = await supabase
      .from("access_events")
      .select("file_id")
      .gte("occurred_at", since)
      .in(
        "file_id",
        files.map((f) => f.id),
      )

    if (eventsError) throw new Error(`Failed to read access_events: ${eventsError.message}`)

    for (const row of (events ?? []) as { file_id: string }[]) {
      counts.set(row.file_id, (counts.get(row.file_id) ?? 0) + 1)
    }
  }

  const now = new Date()
  const ranked = rankFiles(files.map((f) => scoreFile(f, counts.get(f.id) ?? 0, now)))
  const budget = budgetPerEpoch(vitals.availableFunds, account.target_runway_epochs)
  const decisions = decideVerdicts(ranked, budget)

  // PDP status, when there is a real chain to ask. A provider that has missed
  // a proof is storage you are paying for but cannot rely on.
  let proofs = new Map<string, ProofStatus>()
  if (adapter instanceof SynapseAdapter) {
    const ids = files.map((f) => f.data_set_id).filter((id): id is string => Boolean(id))
    if (ids.length > 0) {
      try {
        proofs = await getProofStatuses(await adapter.getReadClient(), ids)
      } catch {
        // Proof status is supplementary; never fail the whole dashboard for it.
      }
    }
  }

  return {
    vitals: serialiseVitals(vitals),
    thresholdEpochs: account.runway_threshold_epochs,
    targetRunwayEpochs: account.target_runway_epochs,
    belowThreshold: vitals.runwayInEpochs < account.runway_threshold_epochs,
    budgetPerEpoch: budget.toString(),
    needsWallet: false,
    walletAddress: scope.walletAddress,
    files: decisions.map((d, index) => ({
      id: d.scored.file.id,
      name: d.scored.file.name,
      sizeBytes: d.scored.file.size_bytes,
      tier: d.scored.file.tier,
      priority: d.scored.file.priority,
      status: d.scored.file.status,
      costPerEpoch: d.scored.file.cost_per_epoch,
      score: d.scored.score,
      breakdown: d.scored.breakdown,
      projectedVerdict: d.verdict,
      verdictReason: d.reason,
      rank: index + 1,
      dataSetId: d.scored.file.data_set_id,
      proof: d.scored.file.data_set_id
        ? (proofs.get(d.scored.file.data_set_id) ?? null)
        : null,
    })),
  }
}
