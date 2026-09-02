/**
 * The message a user signs to prove they control a wallet.
 *
 * Shared by the browser (which signs it) and the server (which recovers the
 * address from the signature). These MUST be byte-identical -- a stray space
 * makes every signature fail verification -- so there is exactly one copy.
 *
 * Bound to the session's user id, so a signature captured for one account
 * cannot be replayed against another.
 */
export function linkMessage(userId: string, address: string, issuedAt: string): string {
  return [
    "RunwayCourt wants to link this wallet.",
    "",
    "Signing proves you control the address. It does not authorise any spending.",
    "",
    `User: ${userId}`,
    `Address: ${address}`,
    `Issued: ${issuedAt}`,
  ].join("\n")
}

/** Signatures older than this are rejected, to limit replay. */
export const LINK_MAX_AGE_MS = 10 * 60 * 1000
