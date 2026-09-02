import "server-only"

import { EPOCHS_PER_MONTH } from "@/lib/epochs"
import type {
  ExecutionReceipt,
  FilecoinAdapter,
  StoragePricing,
  VerdictExecution,
  Vitals,
} from "./types"

/**
 * Live Filecoin Onchain Cloud adapter.
 *
 * Reads the agent's own account health straight off Filecoin Pay via
 * getAccountSummary(), which returns runwayInEpochs and grossCoverageInEpochs
 * directly -- no hand-rolled burn-rate arithmetic, which is where rounding bugs
 * come from.
 *
 * Verified live against Calibration (chain 314159): getPriceList and
 * getAccountSummary both return real values. See scripts/verify-filecoin.ts.
 *
 * The chain object comes from the SDK, NOT from viem/chains -- the SDK's
 * FilecoinChain carries the contract addresses (filecoinPay, fwss, fwssView,
 * usdfc) that every helper resolves through asChain(). viem's plain
 * `filecoinCalibration` has no `contracts` entry and every call fails.
 */

/**
 * Filecoin Pay returns type(uint256).max for runway when the account has no
 * active rails: nothing is being spent, so coverage is unbounded. Treated as
 * Infinity rather than 1.15e77.
 */
const UINT256_MAX = (1n << 256n) - 1n

/** Anything past this many epochs is unbounded for our purposes (~500 years). */
const RUNWAY_SENTINEL = 10n ** 12n

function toRunway(epochs: bigint): number {
  if (epochs >= RUNWAY_SENTINEL || epochs === UINT256_MAX) return Number.POSITIVE_INFINITY
  return Number(epochs)
}

export class SynapseAdapter implements FilecoinAdapter {
  readonly kind = "synapse" as const

  private contextPromise: Promise<SynapseContext> | null = null

  /**
   * @param userId         Whose court this is. Used to derive the delegated signer.
   * @param walletAddress  The user's own address, read from their SIWE sign-in.
   *                       Reads are always against this, never the server's key.
   */
  constructor(
    private readonly userId: string,
    private readonly walletAddress: string | null,
  ) {}

  private getContext(): Promise<SynapseContext> {
    if (!this.contextPromise) {
      this.contextPromise = createContext(this.userId, this.walletAddress)
    }
    return this.contextPromise
  }

  /** Read client, for callers that need extra chain reads (e.g. PDP status). */
  async getReadClient() {
    return (await this.getContext()).readClient
  }

  async getVitals(): Promise<Vitals> {
    const { readClient, address, usdfc } = await this.getContext()
    const { getAccountSummary } = await import("@filoz/synapse-core/pay")

    const summary = await getAccountSummary(readClient, { address, token: usdfc })

    const runwayInEpochs = toRunway(summary.runwayInEpochs)

    return {
      runwayInEpochs,
      grossCoverageInEpochs: toRunway(summary.grossCoverageInEpochs),
      funds: summary.funds,
      availableFunds: summary.availableFunds,
      debt: summary.debt,
      lockupRatePerEpoch: summary.lockupRatePerEpoch,
      epoch: Number(summary.epoch),
      source: this.kind,
      // Deficit is only meaningful when something is actually being paid for.
      inDeficit: summary.lockupRatePerEpoch > 0n && summary.availableFunds === 0n,
    }
  }

  async getPricing(): Promise<StoragePricing> {
    const { readClient } = await this.getContext()
    const { getPriceList } = await import("@filoz/synapse-core/warm-storage")

    // Warm Storage quotes per-TiB-per-month onchain; rails settle per-epoch.
    // Convert once, here, using the SDK's own figures.
    const prices = await getPriceList(readClient)
    const warmPerTiBPerEpoch = prices.rates.storagePerTibPerMonth / BigInt(EPOCHS_PER_MONTH)

    return {
      warmPerTiBPerEpoch,
      // FWSS exposes no cheaper single-copy product through getPriceList, so
      // DOWNGRADE has no distinct onchain rate to move to yet. Reported at the
      // conventional 40% so the court's arithmetic stays consistent with the
      // simulator; see applyVerdicts for what actually happens onchain.
      coldPerTiBPerEpoch: (warmPerTiBPerEpoch * 2n) / 5n,
      source: this.kind,
    }
  }

  /**
   * Read the wallet's real data sets, with the rail ids the payment system
   * settles against. This is what `npm run sync:filecoin` pulls into Supabase
   * so the court tries actual stored data rather than seed rows.
   */
  async listDataSets(): Promise<LiveDataSet[]> {
    const { readClient, address } = await this.getContext()
    const { getClientDataSets } = await import("@filoz/synapse-core/warm-storage")

    const page = await getClientDataSets(readClient, { address })

    return page.items.map((info) => ({
      dataSetId: info.dataSetId,
      pdpRailId: info.pdpRailId,
      cdnRailId: info.cdnRailId,
      payer: info.payer,
      serviceProvider: info.serviceProvider,
      pdpEndEpoch: info.pdpEndEpoch,
    }))
  }

  /**
   * Execute verdicts onchain.
   *
   * DROP is a real state change: terminateService() ends the FWSS agreement for
   * that data set, which stops the PDP rail and releases the lockup. That is
   * the action that actually extends runway.
   *
   * KEEP is a deliberate no-op -- a funded rail keeps settling on its own; there
   * is nothing to submit.
   *
   * DOWNGRADE has no onchain counterpart yet. FWSS exposes no cheaper
   * replication tier to move a data set to, so rather than silently doing
   * nothing and reporting success, it reports ok:false with the reason. Treat a
   * DOWNGRADE verdict in synapse mode as advisory.
   */
  async applyVerdicts(verdicts: VerdictExecution[]): Promise<ExecutionReceipt[]> {
    const { walletClient } = await this.getContext()
    const receipts: ExecutionReceipt[] = []

    if (!walletClient) {
      return verdicts.map((item) => ({
        fileId: item.fileId,
        verdict: item.verdict,
        ok: false,
        txHash: null,
        detail: "Read-only: FILECOIN_PRIVATE_KEY not set, so no verdict was submitted.",
      }))
    }

    const { terminateService } = await import("@filoz/synapse-core/warm-storage")

    for (const item of verdicts) {
      if (item.verdict === "KEEP") {
        receipts.push({
          fileId: item.fileId,
          verdict: item.verdict,
          ok: true,
          txHash: null,
          detail: "Rail left running; no transaction required.",
        })
        continue
      }

      if (item.verdict === "DOWNGRADE") {
        receipts.push({
          fileId: item.fileId,
          verdict: item.verdict,
          ok: false,
          txHash: null,
          detail:
            "No cheaper FWSS tier to move to onchain. Verdict recorded as advisory; " +
            "the data set is still paying the full rate.",
        })
        continue
      }

      // DROP -- terminate the FWSS agreement for real.
      if (item.dataSetId === null || item.dataSetId === undefined) {
        receipts.push({
          fileId: item.fileId,
          verdict: item.verdict,
          ok: false,
          txHash: null,
          detail:
            "No data_set_id on this file, so there is no agreement to terminate. " +
            "Run `npm run sync:filecoin` to link files to real data sets.",
        })
        continue
      }

      try {
        const txHash = await terminateService(walletClient, {
          dataSetId: BigInt(item.dataSetId),
        })

        receipts.push({
          fileId: item.fileId,
          verdict: item.verdict,
          ok: true,
          txHash,
          detail: `terminateService(dataSetId=${item.dataSetId}) submitted.`,
        })
      } catch (error) {
        receipts.push({
          fileId: item.fileId,
          verdict: item.verdict,
          ok: false,
          txHash: null,
          detail: error instanceof Error ? error.message : "terminateService failed.",
        })
      }
    }

    return receipts
  }
}

export interface LiveDataSet {
  dataSetId: bigint
  pdpRailId: bigint
  cdnRailId: bigint
  payer: string
  serviceProvider: string
  pdpEndEpoch: bigint
}

interface SynapseContext {
  readClient: import("viem").Client<import("viem").Transport, import("viem").Chain>
  /** Null when no private key is configured -- reads still work. */
  walletClient:
    | import("viem").Client<import("viem").Transport, import("viem").Chain, import("viem").Account>
    | null
  address: `0x${string}`
  usdfc: `0x${string}`
}

/**
 * Build the viem clients.
 *
 * Reads need only an RPC endpoint. A private key is required only to submit
 * verdicts, so the dashboard can show live vitals for a watched address without
 * one -- set FILECOIN_ADDRESS to read someone else's account.
 */
async function createContext(
  userId: string,
  walletAddress: string | null,
): Promise<SynapseContext> {
  const [viem, chains] = await Promise.all([
    import("viem"),
    import("@filoz/synapse-core/chains"),
  ])

  const network = process.env.FILECOIN_NETWORK ?? "calibration"
  const chain = network === "mainnet" ? chains.mainnet : chains.calibration

  const rpcUrl = process.env.FILECOIN_RPC_URL
  const transport = rpcUrl ? viem.http(rpcUrl) : viem.http()

  const readClient = viem.createPublicClient({ chain, transport })

  // Reads are always against the USER's own address.
  const address = (walletAddress ??
    (process.env.FILECOIN_ADDRESS as `0x${string}` | undefined)) as `0x${string}` | undefined

  if (!address) {
    throw new Error(
      "No wallet linked to this account. Sign in with a wallet, or set " +
        "FILECOIN_ADDRESS to watch one read-only.",
    )
  }

  // Writes are signed by the DELEGATED key, which the user authorised through
  // the session key registry. The server never sees the user's own key.
  let walletClient: SynapseContext["walletClient"] = null
  try {
    const { deriveSessionAccount } = await import("./session-key")
    const sessionAccount = await deriveSessionAccount(userId)
    walletClient = viem.createWalletClient({ account: sessionAccount, chain, transport })
  } catch {
    // No session secret configured -- read-only, which applyVerdicts reports.
  }

  return {
    readClient,
    walletClient,
    address,
    usdfc: chain.contracts.usdfc.address,
  }
}
