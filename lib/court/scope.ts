import "server-only"

import { getServiceClient } from "@/lib/supabase/server"
import type { AgentAccountRow } from "@/lib/supabase/types"
import { deriveSessionAddress, readGrant, type GrantState } from "@/lib/filecoin/session-key"

/**
 * Who the court is acting for.
 *
 * Every read and write below the API layer takes one of these, so a user's
 * scope is established once -- from the verified auth cookie -- and then flows
 * through explicitly. Nothing further down reads "the account"; there is no
 * such thing any more.
 */

export interface AgentScope {
  userId: string
  account: AgentAccountRow
  walletAddress: string | null
  grant: GrantState
  /** The signer address the user would authorise; shown before they grant. */
  proposedSessionAddress: string | null
  /** Why no signer could be derived. Null when everything is fine. */
  delegationUnavailable: string | null
}

/** Default policy for a brand new account: 3-day trigger, 10-day target. */
const DEFAULT_THRESHOLD_EPOCHS = 8_640
const DEFAULT_TARGET_EPOCHS = 28_800

/**
 * Fetch this user's account, creating it on first sign-in.
 *
 * Uses the service client, so the caller MUST have established `userId` from a
 * verified session first -- this function trusts its argument completely.
 */
export async function getScope(userId: string): Promise<AgentScope> {
  const supabase = getServiceClient()

  let { data, error } = await supabase
    .from("agent_account")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle()

  if (error) throw new Error(`Failed to read agent_account: ${error.message}`)

  if (!data) {
    const created = await supabase
      .from("agent_account")
      .insert({
        user_id: userId,
        funds: "0",
        debt: "0",
        runway_threshold_epochs: DEFAULT_THRESHOLD_EPOCHS,
        target_runway_epochs: DEFAULT_TARGET_EPOCHS,
      })
      .select("*")
      .single()

    if (created.error) {
      throw new Error(`Failed to create agent_account: ${created.error.message}`)
    }
    data = created.data
  }

  const account = data as AgentAccountRow

  // Delegation being unavailable must not break the dashboard -- but it must
  // not fail silently either, or the grant button is just mysteriously dead.
  let proposedSessionAddress: string | null = null
  let delegationUnavailable: string | null = null
  try {
    proposedSessionAddress = await deriveSessionAddress(userId)
  } catch (error) {
    delegationUnavailable =
      error instanceof Error ? error.message : "Could not derive an agent signer."
  }

  return {
    userId,
    account,
    walletAddress: account.wallet_address,
    grant: readGrant(account),
    proposedSessionAddress,
    delegationUnavailable,
  }
}
