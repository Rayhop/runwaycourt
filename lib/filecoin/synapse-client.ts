import "server-only"

import type { Synapse } from "@filoz/synapse-sdk"

/**
 * Shared Synapse instance for the real-chain paths.
 *
 * Synapse.create() wires payments, warm storage and the provider registry off a
 * single account. Everything that writes to chain -- onboarding, upload,
 * terminate -- goes through here so there is exactly one place that decides
 * which network and which key are in play.
 *
 * Loaded dynamically: the SDK is ESM-only and pulls in the whole chain stack,
 * which a project running in simulator mode should never pay for.
 */

/** Cached per identity: one entry per user, plus "env" for script usage. */
const cache = new Map<string, Promise<Synapse>>()

export class WalletNotConfiguredError extends Error {
  constructor() {
    super(
      "FILECOIN_PRIVATE_KEY is not set. Required to deposit, upload, or " +
        "terminate. Reads work without it -- see .env.example.",
    )
    this.name = "WalletNotConfiguredError"
  }
}

export function hasWallet(): boolean {
  return Boolean(process.env.FILECOIN_PRIVATE_KEY || process.env.RUNWAYCOURT_SESSION_SECRET)
}

/**
 * @param userId  Sign with this user's delegated session key. Omit to use
 *                FILECOIN_PRIVATE_KEY, which is how the CLI scripts run.
 */
export async function getSynapse(userId?: string): Promise<Synapse> {
  const id = userId ?? "env"
  let entry = cache.get(id)
  if (!entry) {
    entry = create(userId)
    cache.set(id, entry)
  }
  return entry
}

async function create(userId?: string): Promise<Synapse> {
  const privateKey = process.env.FILECOIN_PRIVATE_KEY
  if (!userId && !privateKey) throw new WalletNotConfiguredError()

  const [{ Synapse }, chains, viem, { privateKeyToAccount }] = await Promise.all([
    import("@filoz/synapse-sdk"),
    import("@filoz/synapse-core/chains"),
    import("viem"),
    import("viem/accounts"),
  ])

  const network = process.env.FILECOIN_NETWORK ?? "calibration"
  const chain = network === "mainnet" ? chains.mainnet : chains.calibration

  // A user's court is signed by their delegated key -- never by their own, and
  // never by the server's. Scripts fall back to the env key.
  const account = userId
    ? privateKeyToAccount((await import("./session-key")).deriveSessionPrivateKey(userId))
    : privateKeyToAccount(
        (privateKey!.startsWith("0x") ? privateKey! : `0x${privateKey!}`) as `0x${string}`,
      )

  const rpcUrl = process.env.FILECOIN_RPC_URL

  return Synapse.create({
    account,
    chain,
    transport: rpcUrl ? viem.http(rpcUrl) : viem.http(),
    // Tag onchain activity so it is identifiable in explorers.
    source: "runwaycourt",
  })
}
