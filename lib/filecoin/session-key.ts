import "server-only"

import { hkdfSync } from "node:crypto"

import type { Address, Hex } from "viem"

/**
 * Delegated authority, without custody.
 *
 * RunwayCourt never holds a user's private key. Instead:
 *
 *   1. The agent derives a signer keypair for that user, deterministically,
 *      from a server secret. Nothing secret is written to the database.
 *   2. The USER's wallet calls the session key registry's login(), authorising
 *      that signer address for a named permission until an expiry.
 *   3. The agent then signs with the derived key -- but only for the permission
 *      granted, and only until it lapses.
 *
 * So the user hands over a leash, not the keys, and can revoke by letting the
 * grant expire. That is what makes it defensible to let an agent spend money.
 *
 * Deriving rather than storing means:
 *   - a database leak exposes no key material,
 *   - rotating RUNWAYCOURT_SESSION_SECRET invalidates every delegation at once.
 *
 * The trade-off is the obvious one: whoever holds the secret can act for every
 * user whose grant is still live. Keep it out of the repo, and prefer a short
 * expiry.
 */

/** Permission names as stored in agent_account.session_key_permissions. */
export type PermissionName =
  | "CreateDataSet"
  | "AddPieces"
  | "SchedulePieceRemovals"
  | "TerminateService"

/**
 * What the user delegates.
 *
 * TerminateService is the one the court strictly needs -- it is the authority
 * to stop paying. CreateDataSet and AddPieces are what the upload button needs.
 * SchedulePieceRemovals lets a drop release pieces rather than just ending the
 * agreement. Granting less still works; the agent reports what it could not do.
 */
export const COURT_PERMISSIONS: PermissionName[] = [
  "TerminateService",
  "CreateDataSet",
  "AddPieces",
  "SchedulePieceRemovals",
]

/** The single permission without which the court cannot act at all. */
export const ESSENTIAL_PERMISSION: PermissionName = "TerminateService"

/**
 * What storing a file needs. Kept narrow deliberately: Synapse.create()
 * rejects the whole call if any permission it is told to require is missing,
 * so demanding TerminateService here would block an upload over authority the
 * upload never uses.
 */
export const ESSENTIAL_UPLOAD_PERMISSIONS: PermissionName[] = ["CreateDataSet", "AddPieces"]

/** Default grant length. Short enough to be a real limit, long enough to demo. */
export const DEFAULT_GRANT_DAYS = 30

export class SessionSecretMissingError extends Error {
  constructor() {
    super(
      "RUNWAYCOURT_SESSION_SECRET is not set. Generate one with " +
        "`openssl rand -hex 32` and add it to .env.local.",
    )
    this.name = "SessionSecretMissingError"
  }
}

function secret(): string {
  const value = process.env.RUNWAYCOURT_SESSION_SECRET
  if (!value || value.length < 32) throw new SessionSecretMissingError()
  return value
}

/**
 * Derive this user's signer private key.
 *
 * HKDF with the user id as info, so each user gets an independent key and one
 * compromised delegation says nothing about any other.
 */
export function deriveSessionPrivateKey(userId: string): Hex {
  const bytes = hkdfSync(
    "sha256",
    Buffer.from(secret(), "utf8"),
    Buffer.from("runwaycourt-session-key-v1", "utf8"), // salt
    Buffer.from(userId, "utf8"), // info
    32,
  )
  return `0x${Buffer.from(bytes).toString("hex")}` as Hex
}

export async function deriveSessionAccount(userId: string) {
  const { privateKeyToAccount } = await import("viem/accounts")
  return privateKeyToAccount(deriveSessionPrivateKey(userId))
}

/** The public address to show the user before they authorise it. */
export async function deriveSessionAddress(userId: string): Promise<Address> {
  return (await deriveSessionAccount(userId)).address
}

/** Map our stored names onto the SDK's permission constants. */
export async function resolvePermissions(names: PermissionName[]): Promise<Hex[]> {
  const mod = await import("@filoz/synapse-core/session-key")

  const lookup: Record<PermissionName, Hex> = {
    CreateDataSet: mod.CreateDataSetPermission,
    AddPieces: mod.AddPiecesPermission,
    SchedulePieceRemovals: mod.SchedulePieceRemovalsPermission,
    TerminateService: mod.TerminateServicePermission,
  }

  return names.map((name) => lookup[name]).filter(Boolean)
}

export interface GrantState {
  address: Address | null
  expiresAt: Date | null
  permissions: PermissionName[]
  /** False when absent or lapsed -- the agent cannot act either way. */
  active: boolean
}

export function readGrant(row: {
  session_key_address: string | null
  session_key_expires_at: string | null
  session_key_permissions: string[] | null
}): GrantState {
  const expiresAt = row.session_key_expires_at ? new Date(row.session_key_expires_at) : null
  const permissions = (row.session_key_permissions ?? []) as PermissionName[]

  return {
    address: (row.session_key_address as Address) ?? null,
    expiresAt,
    permissions,
    active: Boolean(
      row.session_key_address && expiresAt && expiresAt.getTime() > Date.now(),
    ),
  }
}
