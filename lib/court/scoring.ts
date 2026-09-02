import { EPOCHS_PER_DAY, USDFC_UNIT } from "@/lib/epochs"
import type { FilePriority, FileRow, ScoreBreakdown } from "@/lib/supabase/types"

/**
 * The Survival Score.
 *
 *   score = access_weight   * accesses_last_7d
 *         + recency_weight  * recency_factor
 *         + priority_weight * user_tag_priority
 *         - cost_weight     * storage_cost_per_epoch
 *
 * Deliberately linear and legible: a judge has to be able to read the four
 * terms off the dashboard and understand the verdict in ten seconds. Resist
 * adding cleverness here -- explainability is the point, not accuracy.
 */

export const WEIGHTS = {
  access: 1.0,
  recency: 40.0,
  priority: 25.0,
  cost: 30.0,
} as const

/** Manual tags are an input to the score, never an override. */
export const PRIORITY_VALUES: Record<FilePriority, number> = {
  critical: 2.0,
  normal: 1.0,
  archive: 0.25,
  junk: -0.5,
}

/** A file goes fully cold after this long untouched. */
const RECENCY_HALF_LIFE_DAYS = 7

/**
 * Cost is normalised against this so the penalty term stays on the same scale
 * as the others regardless of how the account's pricing is denominated.
 */
const COST_REFERENCE_PER_EPOCH = USDFC_UNIT / 10_000n // 0.0001 USDFC/epoch

export interface ScoredFile {
  file: FileRow
  score: number
  breakdown: ScoreBreakdown
}

/**
 * Exponential decay on time since last retrieval. 1.0 = touched just now,
 * ~0.5 at one half-life, approaching 0 for long-abandoned files.
 */
export function recencyFactor(lastAccessedAt: string | null, now: Date): number {
  if (!lastAccessedAt) return 0

  const days = (now.getTime() - new Date(lastAccessedAt).getTime()) / (1000 * 60 * 60 * 24)
  if (days <= 0) return 1

  return Math.pow(0.5, days / RECENCY_HALF_LIFE_DAYS)
}

export function daysSince(iso: string | null, now: Date): number | null {
  if (!iso) return null
  return (now.getTime() - new Date(iso).getTime()) / (1000 * 60 * 60 * 24)
}

/** Cost per epoch as a unitless multiple of the reference rate. */
export function normalisedCost(costPerEpoch: bigint): number {
  if (COST_REFERENCE_PER_EPOCH === 0n) return 0
  // Scale up before dividing so sub-reference costs don't floor to zero.
  return Number((costPerEpoch * 1000n) / COST_REFERENCE_PER_EPOCH) / 1000
}

export function scoreFile(
  file: FileRow,
  accessesLast7d: number,
  now: Date = new Date(),
): ScoredFile {
  const recency = recencyFactor(file.last_accessed_at, now)
  const priority = PRIORITY_VALUES[file.priority] ?? PRIORITY_VALUES.normal
  const cost = normalisedCost(BigInt(file.cost_per_epoch))

  const accessTerm = WEIGHTS.access * accessesLast7d
  const recencyTerm = WEIGHTS.recency * recency
  const priorityTerm = WEIGHTS.priority * priority
  const costPenalty = WEIGHTS.cost * cost

  return {
    file,
    score: accessTerm + recencyTerm + priorityTerm - costPenalty,
    breakdown: {
      accessTerm,
      recencyTerm,
      priorityTerm,
      costPenalty,
      accessesLast7d,
      daysSinceAccess: daysSince(file.last_accessed_at, now),
      costPerEpoch: file.cost_per_epoch,
    },
  }
}

/** Highest score first. Ties broken by cheaper-is-better, then by name. */
export function rankFiles(scored: ScoredFile[]): ScoredFile[] {
  return [...scored].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score

    const costA = BigInt(a.file.cost_per_epoch)
    const costB = BigInt(b.file.cost_per_epoch)
    if (costA !== costB) return costA < costB ? -1 : 1

    return a.file.name.localeCompare(b.file.name)
  })
}

/**
 * Per-epoch spend the court is allowed to sustain in order to reach
 * `targetRunwayEpochs` on the funds available.
 */
export function budgetPerEpoch(availableFunds: bigint, targetRunwayEpochs: number): bigint {
  const target = BigInt(Math.max(1, Math.round(targetRunwayEpochs)))
  return availableFunds / target
}

export { EPOCHS_PER_DAY }
