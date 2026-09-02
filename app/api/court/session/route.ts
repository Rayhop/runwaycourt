import { NextResponse } from "next/server"

import { getScope } from "@/lib/court/scope"
import { runCourtSession } from "@/lib/court/session"
import { getCurrentUser } from "@/lib/supabase/auth"
import { isServerSupabaseConfigured } from "@/lib/supabase/server"

/**
 * Convene the court for the signed-in user.
 *
 * POST { force?: boolean }
 *
 * Without `force` this no-ops unless runway is below the account's threshold,
 * which is what makes it safe to call on a timer.
 */

export const dynamic = "force-dynamic"

export async function POST(request: Request) {
  if (!isServerSupabaseConfigured()) {
    return NextResponse.json(
      { error: "supabase_not_configured", message: "Set Supabase env vars -- see .env.example." },
      { status: 503 },
    )
  }

  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json(
      { error: "unauthenticated", message: "Sign in to convene your court." },
      { status: 401 },
    )
  }

  let force = false
  try {
    force = Boolean((await request.json())?.force)
  } catch {
    // No body is fine -- treat as a scheduled, non-forced check.
  }

  try {
    const scope = await getScope(user.id)
    return NextResponse.json(await runCourtSession(scope, force))
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error"
    return NextResponse.json({ error: "session_failed", message }, { status: 500 })
  }
}
