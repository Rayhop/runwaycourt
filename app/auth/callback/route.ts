import { NextResponse } from "next/server"

import { createServerSupabase } from "@/lib/supabase/auth"

/**
 * OAuth landing point.
 *
 * Google redirects here with a code; exchanging it sets the auth cookie. The
 * `next` param is validated as a relative path so this cannot be used as an
 * open redirect.
 */
export async function GET(request: Request) {
  const url = new URL(request.url)
  const code = url.searchParams.get("code")
  const next = url.searchParams.get("next") ?? "/"
  const safeNext = next.startsWith("/") && !next.startsWith("//") ? next : "/"

  if (!code) {
    return NextResponse.redirect(new URL("/?auth_error=missing_code", url.origin))
  }

  const supabase = await createServerSupabase()
  if (!supabase) {
    return NextResponse.redirect(new URL("/?auth_error=not_configured", url.origin))
  }

  const { error } = await supabase.auth.exchangeCodeForSession(code)
  if (error) {
    return NextResponse.redirect(
      new URL(`/?auth_error=${encodeURIComponent(error.message)}`, url.origin),
    )
  }

  return NextResponse.redirect(new URL(safeNext, url.origin))
}
