import { NextResponse } from "next/server"

import { getScope } from "@/lib/court/scope"
import { LINK_MAX_AGE_MS, linkMessage } from "@/lib/filecoin/wallet-link"
import { getCurrentUser } from "@/lib/supabase/auth"
import { getServiceClient, isServerSupabaseConfigured } from "@/lib/supabase/server"

/**
 * Link an EVM wallet to this account.
 *
 * Ownership is PROVED, not asserted: the browser signs a message naming the
 * user id and a timestamp, and the server recovers the address from that
 * signature. Simply POSTing an address would let anyone claim any wallet and
 * watch its runway.
 *
 * Works for Google users too -- signing in and owning a wallet are separate
 * things, and either sign-in method can link one.
 */

export const dynamic = "force-dynamic"

export async function GET() {
  if (!isServerSupabaseConfigured()) {
    return NextResponse.json({ error: "supabase_not_configured" }, { status: 503 })
  }

  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 })
  }

  const scope = await getScope(user.id)
  return NextResponse.json({ walletAddress: scope.walletAddress })
}

export async function POST(request: Request) {
  if (!isServerSupabaseConfigured()) {
    return NextResponse.json({ error: "supabase_not_configured" }, { status: 503 })
  }

  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json(
      { error: "unauthenticated", message: "Sign in first." },
      { status: 401 },
    )
  }

  let body: { address?: string; signature?: string; issuedAt?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json(
      { error: "bad_request", message: "Expected JSON body." },
      { status: 400 },
    )
  }

  const { address, signature, issuedAt } = body

  if (!address || !signature || !issuedAt) {
    return NextResponse.json(
      { error: "bad_request", message: "address, signature and issuedAt are required." },
      { status: 400 },
    )
  }

  const age = Date.now() - new Date(issuedAt).getTime()
  if (!Number.isFinite(age) || age < -60_000 || age > LINK_MAX_AGE_MS) {
    return NextResponse.json(
      { error: "stale", message: "Signature expired. Try linking again." },
      { status: 400 },
    )
  }

  try {
    const { verifyMessage, isAddress } = await import("viem")

    if (!isAddress(address)) {
      return NextResponse.json(
        { error: "bad_request", message: "Not a valid EVM address." },
        { status: 400 },
      )
    }

    // The message is bound to the SESSION's user id, so a signature captured
    // for one account cannot be replayed against another.
    const valid = await verifyMessage({
      address: address as `0x${string}`,
      message: linkMessage(user.id, address, issuedAt),
      signature: signature as `0x${string}`,
    })

    if (!valid) {
      return NextResponse.json(
        { error: "bad_signature", message: "Signature does not match that address." },
        { status: 400 },
      )
    }

    await getScope(user.id) // ensure the account row exists

    const supabase = getServiceClient()
    const { error } = await supabase
      .from("agent_account")
      .update({ wallet_address: address.toLowerCase() })
      .eq("user_id", user.id)

    if (error) throw new Error(error.message)

    return NextResponse.json({ ok: true, walletAddress: address.toLowerCase() })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error"
    return NextResponse.json({ error: "link_failed", message }, { status: 500 })
  }
}
