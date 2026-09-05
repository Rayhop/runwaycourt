import "server-only"

import type { Synapse } from "@filoz/synapse-sdk"

import {
  ESSENTIAL_UPLOAD_PERMISSIONS,
  deriveSessionPrivateKey,
  resolvePermissions,
  type PermissionName,
} from "./session-key"

/**
 * Shared Synapse instance for the real-chain paths.
 *
 * Synapse.create() wires payments, warm storage and the provider registry off a
 * single account. Everything that writes to chain -- onboarding, upload,
 * terminate -- goes through here so there is exactly one place that decides
 * which network and which key are in play.
 *
 * Two distinct identities exist here, and conflating them is the bug this file
 * exists to avoid:
 *
 *   payer  -- the user's linked wallet. Filecoin Pay bills THIS address, so it
 *             is the one that must hold deposited USDFC and have approved FWSS.
 *   signer -- the derived session key. It signs, and pays gas, but never holds
 *             storage funds.
 *
 * The SDK models that split with the `sessionKey` option: `account` names the
 * payer, `sessionKey` names the delegated signer. Passing the derived key as
 * `account` instead would silently make it its own payer -- an address nothing
 * ever funds, so every upload fails with InsufficientLockupFunds.
 *
 * Loaded dynamically: the SDK is ESM-only and pulls in the whole chain stack,
 * which a project running in simulator mode should never pay for.
 */

/** Who a Synapse instance acts for. Omit entirely to use FILECOIN_PRIVATE_KEY. */
export interface SynapseIdentity {
  userId: string
  /** The payer. Filecoin Pay bills this address, not the session key. */
  walletAddress: string
  /**
   * Permissions Synapse.create() insists are authorised and unexpired. Keep it
   * to what the caller actually does: a broader set fails the whole call over a
   * permission the operation would never have used.
   */
  permissions?: PermissionName[]
}

/**
 * Re-validate a delegation at least this often.
 *
 * Permissions are read from chain once, at create time. Without an expiry the
 * cached instance would keep believing in a grant the user has since let lapse
 * or revoked, and fail on chain instead of with a useful message.
 */
const CACHE_TTL_MS = 5 * 60 * 1000

interface CacheEntry {
  createdAt: number
  synapse: Promise<Synapse>
}

/** Keyed by identity: one entry per user+payer pair, plus "env" for scripts. */
const cache = new Map<string, CacheEntry>()

export class WalletNotConfiguredError extends Error {
  constructor() {
    super(
      "FILECOIN_PRIVATE_KEY is not set. Required to deposit, upload, or " +
        "terminate. Reads work without it -- see .env.example.",
    )
    this.name = "WalletNotConfiguredError"
  }
}

export class WalletNotLinkedError extends Error {
  constructor() {
    super(
      "No wallet is linked to this account. Filecoin Pay needs a payer address " +
        "to bill, so link a wallet before storing anything.",
    )
    this.name = "WalletNotLinkedError"
  }
}

export class DelegationInactiveError extends Error {
  constructor(detail: string) {
    super(detail)
    this.name = "DelegationInactiveError"
  }
}

/** True when the server can derive a signer for a user's delegation. */
export function hasDelegationSecret(): boolean {
  return Boolean(process.env.RUNWAYCOURT_SESSION_SECRET)
}

/**
 * @param identity  Act for this user, signing with their delegated session key
 *                  and billing their linked wallet. Omit to use
 *                  FILECOIN_PRIVATE_KEY directly, which is how the CLI scripts
 *                  run -- there the wallet is both payer and signer.
 */
export async function getSynapse(identity?: SynapseIdentity): Promise<Synapse> {
  const permissions = identity?.permissions ?? ESSENTIAL_UPLOAD_PERMISSIONS
  const id = identity
    ? `${identity.userId}:${identity.walletAddress.toLowerCase()}:${permissions.join(",")}`
    : "env"

  const entry = cache.get(id)
  if (entry && Date.now() - entry.createdAt < CACHE_TTL_MS) return entry.synapse

  const synapse = create(identity, permissions)
  cache.set(id, { createdAt: Date.now(), synapse })

  // A failed create must not be cached, or one bad grant poisons the entry for
  // the whole TTL even after the user fixes it.
  synapse.catch(() => {
    if (cache.get(id)?.synapse === synapse) cache.delete(id)
  })

  return synapse
}

async function create(
  identity: SynapseIdentity | undefined,
  permissions: PermissionName[],
): Promise<Synapse> {
  const privateKey = process.env.FILECOIN_PRIVATE_KEY
  if (!identity && !privateKey) throw new WalletNotConfiguredError()

  const [{ Synapse }, chains, viem, { privateKeyToAccount }] = await Promise.all([
    import("@filoz/synapse-sdk"),
    import("@filoz/synapse-core/chains"),
    import("viem"),
    import("viem/accounts"),
  ])

  const network = process.env.FILECOIN_NETWORK ?? "calibration"
  const chain = network === "mainnet" ? chains.mainnet : chains.calibration
  const rpcUrl = process.env.FILECOIN_RPC_URL
  const transport = rpcUrl ? viem.http(rpcUrl) : viem.http()

  // Scripts: the env wallet is both payer and signer, with no delegation.
  if (!identity) {
    return Synapse.create({
      account: privateKeyToAccount(
        (privateKey!.startsWith("0x") ? privateKey! : `0x${privateKey!}`) as `0x${string}`,
      ),
      chain,
      transport,
      source: "runwaycourt",
    })
  }

  if (!identity.walletAddress) throw new WalletNotLinkedError()

  const { fromSecp256k1 } = await import("@filoz/synapse-core/session-key")

  // The session key is rooted at the user's wallet, so every write it signs is
  // billed to that wallet -- which is what the user authorised onchain.
  const sessionKey = fromSecp256k1({
    privateKey: deriveSessionPrivateKey(identity.userId),
    root: identity.walletAddress as `0x${string}`,
    chain,
    transport,
  })

  // Permissions live onchain, not in our database. Read them before create(),
  // which validates against this local state and would otherwise see nothing.
  try {
    await sessionKey.syncExpirations()
  } catch (error) {
    throw new DelegationInactiveError(
      "Could not read the session key's onchain permissions: " +
        (error instanceof Error ? error.message : "unknown error"),
    )
  }

  // No gas check here on purpose: on the upload path the session key only
  // SIGNS (EIP-712 createDataSetAndAddPieces). The SDK then POSTs that
  // signature to the storage provider, which broadcasts and pays the gas. A
  // zero-balance signer uploads fine. Sending transactions directly -- as
  // terminateService does in synapse.ts -- is the case that needs gas.
  const required = await resolvePermissions(permissions)

  try {
    return Synapse.create({
      // The payer. NOT the session key -- see the note at the top of this file.
      account: identity.walletAddress as `0x${string}`,
      sessionKey,
      requiredPermissions: required,
      chain,
      transport,
      source: "runwaycourt",
    })
  } catch (error) {
    // create() throws a long SDK message when a permission is missing or
    // lapsed. That is a delegation problem, so name it as one.
    throw new DelegationInactiveError(
      error instanceof Error ? error.message : "Session key is not authorised.",
    )
  }
}
