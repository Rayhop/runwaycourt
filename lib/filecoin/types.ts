/**
 * The seam between RunwayCourt's decision logic and Filecoin.
 *
 * Everything above this interface (scoring, ranking, verdicts, narration, UI)
 * is identical whether we are reading a simulated account or a real one on
 * Calibration. Only the implementations below differ.
 */

export type AdapterKind = "simulator" | "synapse"

/** Live account health, mirroring Filecoin Pay's getAccountSummary output. */
export interface Vitals {
  /** Epochs of runway remaining before the account enters deficit. */
  runwayInEpochs: number
  /** Epochs covered ignoring existing debt -- always >= runwayInEpochs. */
  grossCoverageInEpochs: number
  /** Total deposited funds, atomic USDFC. */
  funds: bigint
  /** Funds not already locked up, atomic USDFC. */
  availableFunds: bigint
  /** Outstanding debt to providers, atomic USDFC. */
  debt: bigint
  /** Current burn rate, atomic USDFC per epoch. */
  lockupRatePerEpoch: bigint
  /** Chain epoch this reading was taken at. */
  epoch: number
  /** Which implementation produced this reading. */
  source: AdapterKind
  /** True once runway is exhausted: uploads fail, rails can be terminated. */
  inDeficit: boolean
}

/** Per-epoch storage pricing, pulled from Warm Storage. */
export interface StoragePricing {
  /** Atomic USDFC per TiB per epoch, warm (replicated) storage. */
  warmPerTiBPerEpoch: bigint
  /** Atomic USDFC per TiB per epoch, single-copy storage (the DOWNGRADE tier). */
  coldPerTiBPerEpoch: bigint
  source: AdapterKind
}

export type VerdictKind = "KEEP" | "DOWNGRADE" | "DROP"

/** A verdict the court wants the adapter to actually carry out. */
export interface VerdictExecution {
  fileId: string
  fileName: string
  pieceCid: string | null
  /**
   * FWSS data set this file belongs to. Required to terminate the agreement
   * onchain -- null for simulator rows and for files not yet linked to a real
   * data set by `npm run sync:filecoin`.
   */
  dataSetId: string | null
  verdict: VerdictKind
}

/** What the adapter did about it. */
export interface ExecutionReceipt {
  fileId: string
  verdict: VerdictKind
  ok: boolean
  /** Transaction hash when the action touched chain, null for no-ops. */
  txHash: string | null
  /** Human-readable detail, surfaced in the Case Log when something failed. */
  detail: string
}

export interface FilecoinAdapter {
  readonly kind: AdapterKind

  /** Read the agent's own balance and runway. */
  getVitals(): Promise<Vitals>

  /** Read current Warm Storage pricing. */
  getPricing(): Promise<StoragePricing>

  /**
   * Carry out the court's verdicts.
   *
   * KEEP      -- keep paying; extend the rail if needed.
   * DOWNGRADE -- move to cheaper single-copy storage.
   * DROP      -- stop paying; let the rail lapse and release the piece.
   */
  applyVerdicts(verdicts: VerdictExecution[]): Promise<ExecutionReceipt[]>
}
