import { NextResponse } from "next/server"

import { getScope } from "@/lib/court/scope"
import { readFunding } from "@/lib/filecoin/funding"
import { getCurrentUser } from "@/lib/supabase/auth"
import { isServerSupabaseConfigured } from "@/lib/supabase/server"

/**
 * What the user's wallet holds, and what Filecoin Pay will let the agent spend.
 *
 * GET -> balances, allowances and the approval state of the linked wallet.
 *
 * Read-only on purpose. Depositing moves the USER's tokens, so those
 * transactions are signed by their wallet in the browser -- the server has no
 * authority over them and should not pretend otherwise. See funding-panel.tsx.
 */

export const dynamic = "force-dynamic"

export async function GET() {
  if (!isServerSupabaseConfigured()) {
    return NextResponse.json(
      { error: "supabase_not_configured", message: "Set Supabase env vars." },
      { status: 503 },
    )
  }

  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json(
      { error: "unauthenticated", message: "Sign in first." },
      { status: 401 },
    )
  }

  try {
    const scope = await getScope(user.id)
    return NextResponse.json(await readFunding(scope.walletAddress))
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error"
    return NextResponse.json({ error: "funding_read_failed", message }, { status: 500 })
  }
}
