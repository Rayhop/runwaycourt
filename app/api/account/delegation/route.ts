import { NextResponse } from "next/server"

import { getScope } from "@/lib/court/scope"
import {
  COURT_PERMISSIONS,
  DEFAULT_GRANT_DAYS,
  deriveSessionAddress,
} from "@/lib/filecoin/session-key"
import { getCurrentUser } from "@/lib/supabase/auth"
import { getServiceClient, isServerSupabaseConfigured } from "@/lib/supabase/server"

/**
 * The delegation the user gives the agent.
 *
 * GET  -- what signer address to authorise, and the state of any existing grant.
 * POST -- record a grant the user's wallet has just made onchain.
 * DELETE -- forget the grant locally.
 *
 * The authorising transaction itself is sent by the USER's wallet in the
 * browser (session key registry login()). The server only records the outcome:
 * it cannot grant itself authority, which is the entire point.
 */

export const dynamic = "force-dynamic"

async function guard() {
  if (!isServerSupabaseConfigured()) {
    return {
      response: NextResponse.json(
        { error: "supabase_not_configured", message: "Set Supabase env vars." },
        { status: 503 },
      ),
    }
  }
  const user = await getCurrentUser()
  if (!user) {
    return {
      response: NextResponse.json(
        { error: "unauthenticated", message: "Sign in first." },
        { status: 401 },
      ),
    }
  }
  return { user }
}

export async function GET() {
  const { user, response } = await guard()
  if (response) return response

  try {
    const scope = await getScope(user!.id)

    return NextResponse.json({
      walletAddress: scope.walletAddress,
      // What the user should authorise. Shown before they sign.
      signerAddress: scope.proposedSessionAddress,
      unavailable: scope.delegationUnavailable,
      permissions: COURT_PERMISSIONS,
      defaultGrantDays: DEFAULT_GRANT_DAYS,
      grant: {
        address: scope.grant.address,
        expiresAt: scope.grant.expiresAt?.toISOString() ?? null,
        permissions: scope.grant.permissions,
        active: scope.grant.active,
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error"
    return NextResponse.json({ error: "delegation_read_failed", message }, { status: 500 })
  }
}

export async function POST(request: Request) {
  const { user, response } = await guard()
  if (response) return response

  let body: { txHash?: string; expiresAt?: string; walletAddress?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json(
      { error: "bad_request", message: "Expected JSON body." },
      { status: 400 },
    )
  }

  try {
    // Derive rather than trust: the signer is a function of the user id, so a
    // caller cannot nominate an address the agent does not control.
    const signerAddress = await deriveSessionAddress(user!.id)

    const expiresAt =
      body.expiresAt ??
      new Date(Date.now() + DEFAULT_GRANT_DAYS * 86_400_000).toISOString()

    const supabase = getServiceClient()
    const { error } = await supabase
      .from("agent_account")
      .update({
        session_key_address: signerAddress,
        session_key_expires_at: expiresAt,
        session_key_permissions: COURT_PERMISSIONS,
        session_key_tx: body.txHash ?? null,
        ...(body.walletAddress ? { wallet_address: body.walletAddress.toLowerCase() } : {}),
      })
      .eq("user_id", user!.id)

    if (error) throw new Error(error.message)

    return NextResponse.json({ ok: true, signerAddress, expiresAt })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error"
    return NextResponse.json({ error: "delegation_write_failed", message }, { status: 500 })
  }
}

export async function DELETE() {
  const { user, response } = await guard()
  if (response) return response

  try {
    const supabase = getServiceClient()
    const { error } = await supabase
      .from("agent_account")
      .update({
        session_key_address: null,
        session_key_expires_at: null,
        session_key_permissions: [],
        session_key_tx: null,
      })
      .eq("user_id", user!.id)

    if (error) throw new Error(error.message)

    // Local only. The onchain authorisation still stands until it expires or
    // the user revokes it in the registry -- say so rather than implying
    // the agent's authority is gone.
    return NextResponse.json({
      ok: true,
      note:
        "Forgotten locally. The onchain grant remains until it expires or you " +
        "revoke it in the session key registry.",
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error"
    return NextResponse.json({ error: "delegation_clear_failed", message }, { status: 500 })
  }
}
