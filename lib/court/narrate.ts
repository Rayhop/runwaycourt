import { formatRunway } from "@/lib/epochs"
import type { VerdictKind } from "@/lib/supabase/types"
import type { ScoredFile } from "./scoring"
import type { VerdictReason } from "./verdicts"

/**
 * Plain-English narration.
 *
 * Every verdict gets one sentence naming the actual reason it went that way,
 * derived from whichever score term dominated. This is deterministic on
 * purpose: the Case Log has to be reproducible and defensible, and it renders
 * live during a session with no model call in the hot path.
 *
 * (An LLM pass can rewrite these for flavour later, but the dashboard should
 * never block on one.)
 */

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`
}

function describeAccess(scored: ScoredFile): string | null {
  const { accessesLast7d } = scored.breakdown
  if (accessesLast7d >= 20) return `${accessesLast7d} retrievals this week`
  if (accessesLast7d >= 5) return `${accessesLast7d} recent retrievals`
  if (accessesLast7d === 0) return "no retrievals in 7 days"
  return `only ${accessesLast7d} retrieval${accessesLast7d === 1 ? "" : "s"} this week`
}

function describeRecency(scored: ScoredFile): string | null {
  const days = scored.breakdown.daysSinceAccess
  if (days === null) return "never retrieved"
  if (days < 1) return "touched today"
  if (days < 3) return `last touched ${plural(Math.round(days), "day")} ago`
  if (days > 14) return `untouched ${plural(Math.round(days), "day")}`
  return `last touched ${plural(Math.round(days), "day")} ago`
}

function describeCost(scored: ScoredFile, medianPenalty: number): string | null {
  const { costPenalty } = scored.breakdown
  if (costPenalty > medianPenalty * 1.5) return "expensive to hold"
  if (costPenalty < medianPenalty * 0.5) return "cheap to hold"
  return null
}

/** One sentence explaining a single verdict. */
export function narrateVerdict(
  scored: ScoredFile,
  verdict: VerdictKind,
  medianPenalty: number,
  reason: VerdictReason = "budget",
): string {
  const { file } = scored
  const reasons: string[] = []

  const access = describeAccess(scored)
  const recency = describeRecency(scored)
  const cost = describeCost(scored, medianPenalty)

  if (verdict === "KEEP") {
    if (scored.breakdown.accessesLast7d > 0 && access) reasons.push(access)
    else if (recency) reasons.push(recency)
    if (cost === "cheap to hold") reasons.push(cost)
    if (file.priority === "critical") reasons.push("tagged critical")

    return `Kept ${file.name} (${reasons.slice(0, 2).join(", ") || "scored above the funding line"}).`
  }

  if (verdict === "DOWNGRADE") {
    if (recency) reasons.push(recency)
    if (cost) reasons.push(cost)

    return (
      `Downgraded ${file.name} to single-copy storage ` +
      `(${reasons.slice(0, 2).join(", ") || "marginal score"}) — ` +
      `40% of the rate keeps it alive inside the budget.`
    )
  }

  // A file dropped on merit lost on its own numbers; one dropped on budget was
  // outbid. Saying which is the difference between a verdict a judge can follow
  // and one that looks arbitrary.
  if (reason === "merit") {
    if (recency) reasons.push(recency)
    if (cost === "expensive to hold") reasons.push(cost)
    if (file.priority === "junk") reasons.push("tagged junk")

    return (
      `Dropped ${file.name} (${reasons.slice(0, 2).join(", ") || "no case made"}) — ` +
      `score ${scored.score.toFixed(1)} went negative, so it could not justify its rail at any budget.`
    )
  }

  if (cost === "expensive to hold") reasons.push(cost)
  if (recency) reasons.push(recency)

  return (
    `Dropped ${file.name} (${reasons.slice(0, 2).join(", ") || "outbid"}) — ` +
    `scored ${scored.score.toFixed(1)} but the budget bought cheaper files instead.`
  )
}

/** The session summary that heads the Case Log entry. */
export function narrateSession(params: {
  sessionNumber: number
  runwayBeforeEpochs: number
  runwayAfterEpochs: number
  triggerRunwayEpochs: number
  kept: number
  downgraded: number
  dropped: number
}): string {
  const { sessionNumber, runwayBeforeEpochs, runwayAfterEpochs, kept, downgraded, dropped } = params

  const actions: string[] = [`kept ${kept}`]
  if (downgraded > 0) actions.push(`downgraded ${downgraded}`)
  if (dropped > 0) actions.push(`dropped ${dropped}`)

  const verb =
    runwayAfterEpochs > runwayBeforeEpochs
      ? `Runway extended to ${formatRunway(runwayAfterEpochs)}`
      : `Runway now ${formatRunway(runwayAfterEpochs)}`

  return (
    `Session #${sessionNumber} — Runway at ${formatRunway(runwayBeforeEpochs)} triggered a review. ` +
    `Court ${actions.join(", ")}. ${verb}.`
  )
}
