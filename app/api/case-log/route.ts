import { NextResponse } from "next/server"

import { getCurrentUser } from "@/lib/supabase/auth"
import { getServiceClient, isServerSupabaseConfigured } from "@/lib/supabase/server"
import type { CourtSessionRow, VerdictRow } from "@/lib/supabase/types"

/** Past sessions with their verdicts, newest first. This is the Case Log. */

export const dynamic = "force-dynamic"
export const revalidate = 0

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
      { error: "unauthenticated", message: "Sign in to view your Case Log." },
      { status: 401 },
    )
  }

  const limit = Math.min(
    50,
    Math.max(1, Number(new URL(request.url).searchParams.get("limit") ?? 12)),
  )

  try {
    const supabase = getServiceClient()

    const { data: sessions, error: sessionError } = await supabase
      .from("court_sessions")
      .select("*")
      .eq("user_id", user.id)
      .order("opened_at", { ascending: false })
      .limit(limit)

    if (sessionError) throw new Error(sessionError.message)

    const rows = (sessions ?? []) as CourtSessionRow[]
    if (rows.length === 0) return NextResponse.json({ sessions: [] })

    const { data: verdicts, error: verdictError } = await supabase
      .from("verdicts")
      .select("*")
      .in(
        "session_id",
        rows.map((s) => s.id),
      )
      .order("rank", { ascending: true })

    if (verdictError) throw new Error(verdictError.message)

    const bySession = new Map<number, VerdictRow[]>()
    for (const verdict of (verdicts ?? []) as VerdictRow[]) {
      const list = bySession.get(verdict.session_id) ?? []
      list.push(verdict)
      bySession.set(verdict.session_id, list)
    }

    return NextResponse.json({
      sessions: rows.map((session) => ({
        ...session,
        verdicts: bySession.get(session.id) ?? [],
      })),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error"
    return NextResponse.json({ error: "case_log_failed", message }, { status: 500 })
  }
}
