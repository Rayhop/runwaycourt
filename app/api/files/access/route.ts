import { NextResponse } from "next/server"

import { getCurrentUser } from "@/lib/supabase/auth"
import { getServiceClient, isServerSupabaseConfigured } from "@/lib/supabase/server"

/**
 * Record a retrieval.
 *
 * POST { fileId: string }
 *
 * Both a real hook (call this from your retrieval path) and the demo's lever:
 * clicking "Retrieve" in the Courtroom panel bumps accesses_last_7d and resets
 * recency, so the file's Survival Score climbs and you can watch a defendant
 * argue its way back above the funding line in real time.
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
      { error: "unauthenticated", message: "Sign in first." },
      { status: 401 },
    )
  }

  let fileId: string | undefined
  try {
    fileId = (await request.json())?.fileId
  } catch {
    return NextResponse.json({ error: "bad_request", message: "Expected JSON body." }, { status: 400 })
  }

  if (!fileId || typeof fileId !== "string") {
    return NextResponse.json(
      { error: "bad_request", message: "fileId is required." },
      { status: 400 },
    )
  }

  try {
    const supabase = getServiceClient()
    const now = new Date().toISOString()

    // Ownership check: the service client bypasses RLS, so this is the only
    // thing stopping one user recording retrievals against another's file.
    const { data: owned, error: ownerError } = await supabase
      .from("files")
      .select("id")
      .eq("id", fileId)
      .eq("user_id", user.id)
      .maybeSingle()

    if (ownerError) throw new Error(ownerError.message)
    if (!owned) {
      return NextResponse.json(
        { error: "not_found", message: "No such file in your court." },
        { status: 404 },
      )
    }

    const { error: insertError } = await supabase
      .from("access_events")
      .insert({ file_id: fileId, occurred_at: now })

    if (insertError) throw new Error(insertError.message)

    const { error: updateError } = await supabase
      .from("files")
      .update({ last_accessed_at: now })
      .eq("id", fileId)
      .eq("user_id", user.id)

    if (updateError) throw new Error(updateError.message)

    return NextResponse.json({ ok: true, fileId, occurredAt: now })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error"
    return NextResponse.json({ error: "access_failed", message }, { status: 500 })
  }
}
