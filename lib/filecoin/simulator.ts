import "server-only"

import { getServiceClient } from "@/lib/supabase/server"
import type { AgentAccountRow, FileRow } from "@/lib/supabase/types"
import { EPOCHS_PER_MONTH, SECONDS_PER_EPOCH, USDFC_UNIT } from "@/lib/epochs"
import type {
  ExecutionReceipt,
  FilecoinAdapter,
  StoragePricing,
  VerdictExecution,
  Vitals,
} from "./types"

/**
 * Simulated Filecoin account, scoped to one user.
 *
 * Not a mock returning canned values -- it models the real mechanic. The burn
 * rate is the summed per-epoch cost of that user's files, and funds are drawn
 * down by wall-clock time at 30s/epoch. So runway genuinely ticks toward zero
 * while you watch, and dropping a file genuinely extends it.
 *
 * Deficit behaviour matches Filecoin Pay: once funds are exhausted the shortfall
 * accrues as debt rather than the balance going negative.
 */
export class SimulatorAdapter implements FilecoinAdapter {
  readonly kind = "simulator" as const

  /** Warm storage list price, atomic USDFC per TiB per month, demo-scale. */
  private static readonly WARM_PER_TIB_PER_MONTH = 2n * USDFC_UNIT
  /** Single-copy storage costs ~40% of warm. This is what DOWNGRADE buys. */
  private static readonly COLD_NUMERATOR = 2n
  private static readonly COLD_DENOMINATOR = 5n

  constructor(private readonly userId: string) {}

  async getVitals(): Promise<Vitals> {
    const supabase = getServiceClient()

    const [{ data: account, error: accountError }, { data: files, error: filesError }] =
      await Promise.all([
        supabase.from("agent_account").select("*").eq("user_id", this.userId).single(),
        supabase.from("files").select("*").eq("user_id", this.userId).neq("status", "dropped"),
      ])

    if (accountError) throw new Error(`Failed to read agent_account: ${accountError.message}`)
    if (filesError) throw new Error(`Failed to read files: ${filesError.message}`)

    const row = account as AgentAccountRow
    const active = (files ?? []) as FileRow[]

    // Burn rate is whatever we are currently paying for, per epoch.
    const lockupRatePerEpoch = active.reduce((sum, file) => sum + BigInt(file.cost_per_epoch), 0n)

    // Settle lazily: charge for the epochs elapsed since the balance was last
    // written down. This is what makes runway move in real time.
    const elapsedMs = Date.now() - new Date(row.last_settled_at).getTime()
    const elapsedEpochs = BigInt(Math.max(0, Math.floor(elapsedMs / (SECONDS_PER_EPOCH * 1000))))

    const funds = BigInt(row.funds)
    const accrued = elapsedEpochs * lockupRatePerEpoch + BigInt(row.debt)

    const availableFunds = accrued >= funds ? 0n : funds - accrued
    const debt = accrued > funds ? accrued - funds : 0n

    const runwayInEpochs =
      lockupRatePerEpoch === 0n
        ? Number.POSITIVE_INFINITY
        : Number(availableFunds / lockupRatePerEpoch)

    return {
      runwayInEpochs,
      grossCoverageInEpochs:
        lockupRatePerEpoch === 0n ? Number.POSITIVE_INFINITY : Number(funds / lockupRatePerEpoch),
      funds,
      availableFunds,
      debt,
      lockupRatePerEpoch,
      epoch: Math.floor(Date.now() / (SECONDS_PER_EPOCH * 1000)),
      source: this.kind,
      inDeficit: availableFunds === 0n && lockupRatePerEpoch > 0n,
    }
  }

  async getPricing(): Promise<StoragePricing> {
    const warmPerTiBPerEpoch = SimulatorAdapter.WARM_PER_TIB_PER_MONTH / BigInt(EPOCHS_PER_MONTH)

    return {
      warmPerTiBPerEpoch,
      coldPerTiBPerEpoch:
        (warmPerTiBPerEpoch * SimulatorAdapter.COLD_NUMERATOR) / SimulatorAdapter.COLD_DENOMINATOR,
      source: this.kind,
    }
  }

  /**
   * Apply verdicts to the simulated account.
   *
   * The DB write is the "onchain" action here: a dropped file stops
   * contributing to the burn rate, which is exactly the effect that extends
   * runway. Every update is scoped by user_id as well as file id, so a
   * mis-plumbed caller cannot touch someone else's inventory.
   */
  async applyVerdicts(verdicts: VerdictExecution[]): Promise<ExecutionReceipt[]> {
    const supabase = getServiceClient()
    const receipts: ExecutionReceipt[] = []

    for (const item of verdicts) {
      try {
        if (item.verdict === "KEEP") {
          receipts.push({
            fileId: item.fileId,
            verdict: item.verdict,
            ok: true,
            txHash: null,
            detail: "Rail left running; no action required.",
          })
          continue
        }

        if (item.verdict === "DOWNGRADE") {
          const { data: current, error: readError } = await supabase
            .from("files")
            .select("cost_per_epoch, tier")
            .eq("id", item.fileId)
            .eq("user_id", this.userId)
            .single()

          if (readError) throw new Error(readError.message)

          if ((current as FileRow).tier === "cold") {
            receipts.push({
              fileId: item.fileId,
              verdict: item.verdict,
              ok: true,
              txHash: null,
              detail: "Already on single-copy storage.",
            })
            continue
          }

          const discounted =
            (BigInt((current as FileRow).cost_per_epoch) * SimulatorAdapter.COLD_NUMERATOR) /
            SimulatorAdapter.COLD_DENOMINATOR

          const { error } = await supabase
            .from("files")
            .update({
              tier: "cold",
              status: "downgraded",
              cost_per_epoch: discounted.toString(),
            })
            .eq("id", item.fileId)
            .eq("user_id", this.userId)

          if (error) throw new Error(error.message)

          receipts.push({
            fileId: item.fileId,
            verdict: item.verdict,
            ok: true,
            txHash: null,
            detail: "Rail repriced to single-copy storage.",
          })
          continue
        }

        // DROP -- stop paying entirely.
        const { error } = await supabase
          .from("files")
          .update({
            status: "dropped",
            cost_per_epoch: "0",
            dropped_at: new Date().toISOString(),
          })
          .eq("id", item.fileId)
          .eq("user_id", this.userId)

        if (error) throw new Error(error.message)

        receipts.push({
          fileId: item.fileId,
          verdict: item.verdict,
          ok: true,
          txHash: null,
          detail: "Rail lapsed; piece released.",
        })
      } catch (error) {
        receipts.push({
          fileId: item.fileId,
          verdict: item.verdict,
          ok: false,
          txHash: null,
          detail: error instanceof Error ? error.message : "Unknown execution failure.",
        })
      }
    }

    return receipts
  }

  /** Persist the drawn-down balance so the next reading starts from here. */
  async settle(): Promise<void> {
    const supabase = getServiceClient()
    const vitals = await this.getVitals()

    const { error } = await supabase
      .from("agent_account")
      .update({
        funds: vitals.availableFunds.toString(),
        debt: vitals.debt.toString(),
        last_settled_at: new Date().toISOString(),
      })
      .eq("user_id", this.userId)

    if (error) throw new Error(`Failed to settle simulated account: ${error.message}`)
  }
}
