"use client"

import { ScrollText } from "lucide-react"

import { formatRunway } from "@/lib/epochs"
import type { CourtSessionRow, VerdictRow } from "@/lib/supabase/types"
import { cn } from "@/lib/utils"

/**
 * The Case Log.
 *
 * Scrolling feed of past sessions, each with its plain-English summary and the
 * per-file rationales underneath. This doubles as the public showcase artefact
 * and as the README's evidence -- it should read as prose, not as a data dump.
 */

export interface CaseLogSession extends CourtSessionRow {
  verdicts: VerdictRow[]
}

interface CaseLogPanelProps {
  sessions: CaseLogSession[]
  loading: boolean
}

const VERDICT_DOT = {
  KEEP: "bg-emerald-400",
  DOWNGRADE: "bg-amber-400",
  DROP: "bg-red-400",
} as const

function timestamp(iso: string): string {
  return new Date(iso).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
}

function SessionEntry({ session }: { session: CaseLogSession }) {
  const before = session.runway_before_epochs
  const after = session.runway_after_epochs
  const gained = before !== null && after !== null && after > before

  return (
    <li className="relative border-l border-white/10 pl-4">
      <span className="absolute -left-[3px] top-2 h-1.5 w-1.5 rounded-full bg-white/40" />

      <div className="flex items-baseline gap-2">
        <span className="font-mono text-xs text-white/40">{timestamp(session.opened_at)}</span>
        <span className="text-xs font-medium text-white/60">Session #{session.id}</span>
        <span className="rounded border border-white/10 px-1 text-[10px] uppercase tracking-wider text-white/30">
          {session.chain_source}
        </span>
      </div>

      <p className="mt-1.5 text-sm leading-relaxed text-white/80">
        {session.narration ?? "Session in progress…"}
      </p>

      {before !== null && after !== null ? (
        <p className="mt-1 font-mono text-[11px] text-white/40">
          {formatRunway(before)} →{" "}
          <span className={gained ? "text-emerald-300" : "text-white/60"}>
            {formatRunway(after)}
          </span>
        </p>
      ) : null}

      {session.verdicts.length > 0 ? (
        <ul className="mt-2 space-y-1">
          {session.verdicts.map((verdict) => (
            <li key={verdict.id} className="flex items-start gap-2 text-xs text-white/50">
              <span
                className={cn(
                  "mt-1.5 h-1 w-1 shrink-0 rounded-full",
                  VERDICT_DOT[verdict.verdict],
                )}
              />
              <span className="leading-relaxed">
                {verdict.rationale}
                <span className="ml-1.5 font-mono text-white/25">
                  ({verdict.score.toFixed(1)})
                </span>
                {!verdict.executed && verdict.execution_note ? (
                  <span className="ml-1.5 text-amber-300/60" title={verdict.execution_note}>
                    · not settled
                  </span>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  )
}

export function CaseLogPanel({ sessions, loading }: CaseLogPanelProps) {
  return (
    <section className="flex h-full flex-col rounded-xl border border-white/10 bg-black/50 p-5 backdrop-blur-sm">
      <div className="flex items-center gap-2">
        <ScrollText className="h-4 w-4 text-white/40" />
        <h2 className="text-sm font-medium uppercase tracking-wider text-white/60">Case Log</h2>
      </div>

      {sessions.length === 0 ? (
        <p className="mt-4 text-sm text-white/40">
          {loading
            ? "Loading…"
            : "No sessions yet. Convene the court to put the inventory on trial."}
        </p>
      ) : (
        <ol className="mt-4 max-h-[32rem] space-y-4 overflow-y-auto pr-1">
          {sessions.map((session) => (
            <SessionEntry key={session.id} session={session} />
          ))}
        </ol>
      )}
    </section>
  )
}
