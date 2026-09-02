import { NextResponse } from "next/server"

import { createServerSupabase } from "@/lib/supabase/auth"

/** Clears the auth cookie and returns to the dashboard's signed-out state. */
export async function POST(request: Request) {
  const supabase = await createServerSupabase()
  if (supabase) await supabase.auth.signOut()
  return NextResponse.redirect(new URL("/", new URL(request.url).origin), { status: 303 })
}
