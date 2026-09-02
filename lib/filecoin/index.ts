import "server-only"

import { SimulatorAdapter } from "./simulator"
import { SynapseAdapter } from "./synapse"
import type { AdapterKind, FilecoinAdapter } from "./types"

export * from "./types"
export { SimulatorAdapter } from "./simulator"
export { SynapseAdapter } from "./synapse"

/**
 * Pick the chain implementation from env.
 *
 *   RUNWAYCOURT_CHAIN=simulator  (default) -- self-contained, no wallet needed
 *   RUNWAYCOURT_CHAIN=synapse              -- real Filecoin Pay / Warm Storage
 */
export function getConfiguredKind(): AdapterKind {
  return process.env.RUNWAYCOURT_CHAIN === "synapse" ? "synapse" : "simulator"
}

/**
 * Build the adapter for one user's court.
 *
 * Not cached: each user has a different wallet and a different delegated
 * signer, so a shared instance would leak one court's identity into another.
 */
export function getAdapter(
  scope: { userId: string; walletAddress: string | null },
  kind: AdapterKind = getConfiguredKind(),
): FilecoinAdapter {
  return kind === "synapse"
    ? new SynapseAdapter(scope.userId, scope.walletAddress)
    : new SimulatorAdapter(scope.userId)
}

/** The simulator exposes settle(), which the generic interface does not. */
export function getSimulator(userId: string): SimulatorAdapter {
  return new SimulatorAdapter(userId)
}
