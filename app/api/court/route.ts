import { NextResponse } from "next/server"

import { getCourtPreview } from "@/lib/court/preview"
import { getScope } from "@/lib/court/scope"
import { getCurrentUser } from "@/lib/supabase/auth"
import { isServerSupabaseConfigured } from "@/lib/supabase/server"

/** Live vitals + this user's scored/ranked inventory. Polled by the dashboard. */

export const dynamic = "force-dynamic"
export const revalidate = 0

export async function GET() {
  if (!isServerSupabaseConfigured()) {
    return NextResponse.json(
      { error: "supabase_not_configured", message: "Set Supabase env vars -- see .env.example." },
      { status: 503 },
    )
  }

  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json(
      { error: "unauthenticated", message: "Sign in to view your court." },
      { status: 401 },
    )
  }

  try {
    const scope = await getScope(user.id)
    return NextResponse.json(await getCourtPreview(scope))
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error"
    return NextResponse.json({ error: "preview_failed", message }, { status: 500 })
  }
}
