"use client"

import { useCallback, useEffect, useRef, useState } from "react"

import type { CourtPreview } from "@/lib/court/preview"
import { CaseLogPanel, type CaseLogSession } from "./case-log-panel"
import { CourtroomPanel } from "./courtroom-panel"
import { DelegationPanel } from "./delegation-panel"
import { FundingPanel } from "./funding-panel"
import { UploadPanel } from "./upload-panel"
import { VitalsPanel } from "./vitals-panel"
import { WalletPanel } from "./wallet-panel"

/**
 * Dashboard shell: owns polling and the session trigger.
 *
 * Vitals are polled on a short interval so runway visibly ticks down. The agent
 * also gets an autonomous check on the same interval -- a non-forced POST to
 * /api/court/session, which no-ops unless runway is under threshold. That is
 * what makes the court convene without anyone pressing anything.
 */

const POLL_MS = 5_000

interface DashboardProps {
  /** False when Supabase env vars are missing, so we show setup instead. */
  configured: boolean
  /** Only synapse mode can store to chain, so the upload control is hidden otherwise. */
  canUpload: boolean
  /** Delegation only means anything against a real chain. */
  isWalletMode: boolean
  /** The signed-in user's id, for the wallet-link signature. */
  userId: string
}

export function CourtDashboard({
  configured,
  canUpload,
  isWalletMode,
  userId,
}: DashboardProps) {
  const [preview, setPreview] = useState<CourtPreview | null>(null)
  const [sessions, setSessions] = useState<CaseLogSession[]>([])
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Guards the autonomous tick so overlapping polls can't convene twice.
  const autoRunning = useRef(false)

  const refresh = useCallback(async () => {
    try {
      const [courtRes, logRes] = await Promise.all([
        fetch("/api/court", { cache: "no-store" }),
        fetch("/api/case-log?limit=12", { cache: "no-store" }),
      ])

      if (!courtRes.ok) {
        const body = await courtRes.json().catch(() => ({}))
        throw new Error(body?.message ?? `Vitals request failed (${courtRes.status})`)
      }

      setPreview((await courtRes.json()) as CourtPreview)
      if (logRes.ok) {
        setSessions(((await logRes.json())?.sessions ?? []) as CaseLogSession[])
      }
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to read court state.")
    } finally {
      setLoading(false)
    }
  }, [])

  const convene = useCallback(
    async (force: boolean) => {
      setRunning(true)
      try {
        const response = await fetch("/api/court/session", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ force }),
        })

        if (!response.ok) {
          const body = await response.json().catch(() => ({}))
          throw new Error(body?.message ?? `Session failed (${response.status})`)
        }

        await refresh()
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Session failed.")
      } finally {
        setRunning(false)
      }
    },
    [refresh],
  )

  const retrieve = useCallback(
    async (fileId: string) => {
      await fetch("/api/files/access", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fileId }),
      })
      await refresh()
    },
    [refresh],
  )

  // Poll vitals + case log.
  useEffect(() => {
    if (!configured) {
      setLoading(false)
      return
    }

    void refresh()
    const id = setInterval(() => void refresh(), POLL_MS)
    return () => clearInterval(id)
  }, [configured, refresh])

  // The autonomous decision: convene unprompted once runway drops.
  useEffect(() => {
    if (!configured || !preview?.belowThreshold || running || autoRunning.current) return

    autoRunning.current = true
    void convene(false).finally(() => {
      autoRunning.current = false
    })
  }, [configured, preview?.belowThreshold, running, convene])

  if (!configured) {
    return (
      <section className="rounded-xl border border-amber-400/30 bg-amber-400/5 p-6 backdrop-blur-sm">
        <h2 className="text-sm font-medium uppercase tracking-wider text-amber-200">Setup needed</h2>
        <p className="mt-2 max-w-prose text-sm leading-relaxed text-white/70">
          RunwayCourt needs a Supabase project. Copy <code className="text-white/90">.env.example</code>{" "}
          to <code className="text-white/90">.env.local</code>, fill in your project URL and keys,
          then apply <code className="text-white/90">supabase/migrations/0001_init.sql</code> and{" "}
          <code className="text-white/90">supabase/seed.sql</code>.
        </p>
      </section>
    )
  }

  return (
    <div className="space-y-4">
      {error ? (
        <div className="rounded-lg border border-red-400/30 bg-red-400/10 px-4 py-3 text-sm text-red-200">
          {error}
        </div>
      ) : null}

      {isWalletMode ? (
        <WalletPanel userId={userId} onLinked={() => void refresh()} />
      ) : null}

      <VitalsPanel preview={preview} loading={loading} />

      {isWalletMode && !preview?.needsWallet ? (
        <>
          <FundingPanel onChanged={() => void refresh()} />
          <DelegationPanel onChanged={() => void refresh()} />
        </>
      ) : null}

      {canUpload ? <UploadPanel onUploaded={() => void refresh()} /> : null}

      <div className="grid gap-4 lg:grid-cols-[1.35fr_1fr]">
        <CourtroomPanel
          preview={preview}
          loading={loading}
          running={running}
          onConvene={() => void convene(true)}
          onRetrieve={retrieve}
        />
        <CaseLogPanel sessions={sessions} loading={loading} />
      </div>
    </div>
  )
}
