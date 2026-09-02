import type { VerdictKind } from "@/lib/supabase/types"
import type { ScoredFile } from "./scoring"

/**
 * The verdict rule, kept free of any server/DB imports so it can be reasoned
 * about and tested on its own. This is the part a judge is asked to follow, so
 * it must stay readable end to end.
 */

/** Single-copy storage costs 40% of warm. */
export const COLD_NUMERATOR = 2n
export const COLD_DENOMINATOR = 5n

export function discountedCost(costPerEpoch: bigint): bigint {
  return (costPerEpoch * COLD_NUMERATOR) / COLD_DENOMINATOR
}

/** Why a file got the verdict it did. Drives the wording in the Case Log. */
export type VerdictReason = "merit" | "budget" | "afforded"

export interface Decision {
  scored: ScoredFile
  verdict: VerdictKind
  reason: VerdictReason
}

/**
 * Walk the ranking and spend the budget.
 *
 * Two independent tests, in this order:
 *
 *   1. Merit.  A file with a negative Survival Score has argued itself out --
 *      it costs more than its access, recency and priority justify. It is
 *      dropped regardless of how much budget is left, so cheap junk can never
 *      outlive a file that scored above it.
 *
 *   2. Budget. Surviving files are funded top-down. When the full warm rate no
 *      longer fits, single-copy storage at 40% is tried before dropping.
 *
 * The walk deliberately continues past a file it could not afford: a cheap
 * high-scorer further down should still get funded rather than being punished
 * for what an expensive neighbour cost. That can leave a higher-scoring file
 * dropped while a lower-scoring cheaper one survives -- which is correct
 * budgeting, and the narration says so explicitly rather than hiding it.
 */
export function decideVerdicts(ranked: ScoredFile[], budget: bigint): Decision[] {
  const results: Decision[] = []
  let spent = 0n

  for (const scored of ranked) {
    const cost = BigInt(scored.file.cost_per_epoch)

    // 1. Merit.
    if (scored.score < 0) {
      results.push({ scored, verdict: "DROP", reason: "merit" })
      continue
    }

    // 2. Budget.
    if (spent + cost <= budget) {
      spent += cost
      results.push({ scored, verdict: "KEEP", reason: "afforded" })
      continue
    }

    const cheaper = discountedCost(cost)
    if (scored.file.tier === "warm" && spent + cheaper <= budget) {
      spent += cheaper
      results.push({ scored, verdict: "DOWNGRADE", reason: "budget" })
      continue
    }

    results.push({ scored, verdict: "DROP", reason: "budget" })
  }

  return results
}

/** Per-epoch spend implied by a set of decisions. */
export function spendPerEpoch(decisions: Decision[]): bigint {
  return decisions.reduce((sum, d) => {
    const cost = BigInt(d.scored.file.cost_per_epoch)
    if (d.verdict === "DROP") return sum
    return sum + (d.verdict === "DOWNGRADE" ? discountedCost(cost) : cost)
  }, 0n)
}
