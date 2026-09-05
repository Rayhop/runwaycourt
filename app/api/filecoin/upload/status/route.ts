import { NextResponse } from "next/server"

import { UploadJobNotFoundError, advanceUpload } from "@/lib/filecoin/upload"
import { getCurrentUser } from "@/lib/supabase/auth"
import { isServerSupabaseConfigured } from "@/lib/supabase/server"

/**
 * Advance an in-flight upload by one step.
 *
 * GET ?jobId=<uuid> -> { jobId, state, outcome, ... }
 *
 * Each call makes one status request to the storage provider, and enrols the
 * file the moment the chain has confirmed the commit. The client polls this
 * until state is "done" or "failed" -- there is no server-side worker, so a
 * job only progresses while someone is watching it.
 */

export const dynamic = "force-dynamic"
// One provider status call plus, on the last poll, enrolment.
export const maxDuration = 60

export async function GET(request: Request) {
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

  const jobId = new URL(request.url).searchParams.get("jobId")
  if (!jobId) {
    return NextResponse.json(
      { error: "bad_request", message: "jobId is required." },
      { status: 400 },
    )
  }

  try {
    return NextResponse.json(await advanceUpload({ userId: user.id, jobId }))
  } catch (error) {
    if (error instanceof UploadJobNotFoundError) {
      return NextResponse.json({ error: "not_found", message: error.message }, { status: 404 })
    }

    const message = error instanceof Error ? error.message : "Unknown error"
    return NextResponse.json({ error: "status_failed", message }, { status: 500 })
  }
}
