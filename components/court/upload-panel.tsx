"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { CheckCircle2, Loader2, UploadCloud } from "lucide-react"

import { formatBytes } from "@/lib/epochs"
import type { FilePriority } from "@/lib/supabase/types"

/**
 * Store a real file on Filecoin and put it on trial.
 *
 * Only rendered in synapse mode -- in simulator mode there is no chain to
 * store to, and offering the control would be a lie.
 *
 * The upload is asynchronous because it takes about 80 seconds: POST returns as
 * soon as the bytes are with the provider, then this polls the status route
 * while the chain confirms the commit. Nothing progresses server-side on its
 * own, so the poll is what drives the job forward -- keep it running.
 */

interface UploadPanelProps {
  onUploaded: () => void
}

type JobState = "committing" | "confirming" | "done" | "failed"

interface Progress {
  jobId: string
  state: JobState
  name: string
  sizeBytes: number
  pieceCid: string | null
  dataSetId: string | null
  txHash: string | null
  error: string | null
  outcome: {
    name: string
    pieceCid: string
    sizeBytes: number
    dataSetId: string | null
    pdpRailId: string | null
  } | null
}

const PRIORITIES: FilePriority[] = ["critical", "normal", "archive", "junk"]

const POLL_INTERVAL_MS = 4_000
/** Well past the ~80s a commit normally takes, so a slow chain is not an error. */
const POLL_TIMEOUT_MS = 10 * 60_000

const STAGE_LABEL: Record<JobState, string> = {
  committing: "Sending to a storage provider…",
  confirming: "Waiting for the chain to confirm the data set…",
  done: "Stored.",
  failed: "Failed.",
}

export function UploadPanel({ onUploaded }: UploadPanelProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [priority, setPriority] = useState<FilePriority>("normal")
  const [progress, setProgress] = useState<Progress | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [outcome, setOutcome] = useState<Progress["outcome"]>(null)

  // Survives re-renders so an unmount can stop the poll loop mid-flight.
  const cancelled = useRef(false)
  useEffect(() => {
    cancelled.current = false
    return () => {
      cancelled.current = true
    }
  }, [])

  /**
   * Read a response as JSON, but survive one that is not.
   *
   * A request that outlives its serverless budget comes back as an HTML or
   * plain-text error page from the platform, and blindly calling .json() on it
   * reports a parse error instead of what actually went wrong.
   */
  const readJson = useCallback(async (response: Response) => {
    const text = await response.text()
    try {
      return JSON.parse(text)
    } catch {
      throw new Error(
        response.ok
          ? "The server sent a response that was not JSON."
          : `Upload failed (${response.status}). ${text.slice(0, 120)}`,
      )
    }
  }, [])

  const poll = useCallback(
    async (jobId: string) => {
      const deadline = Date.now() + POLL_TIMEOUT_MS

      while (!cancelled.current) {
        if (Date.now() > deadline) {
          throw new Error(
            "Gave up waiting for the chain to confirm. The upload may still land -- " +
              "reload in a minute before retrying, so you do not pay for it twice.",
          )
        }

        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
        if (cancelled.current) return null

        const response = await fetch(`/api/filecoin/upload/status?jobId=${jobId}`)
        const json = (await readJson(response)) as Progress & { message?: string }
        if (!response.ok) throw new Error(json?.message ?? `Status check failed (${response.status})`)

        setProgress(json)
        if (json.state === "failed") throw new Error(json.error ?? "Upload failed.")
        if (json.state === "done") return json
      }

      return null
    },
    [readJson],
  )

  async function submit(file: File) {
    setBusy(true)
    setError(null)
    setOutcome(null)
    setProgress(null)

    try {
      const body = new FormData()
      body.append("file", file)
      body.append("priority", priority)

      const response = await fetch("/api/filecoin/upload", { method: "POST", body })
      const started = (await readJson(response)) as Progress & { message?: string }

      if (!response.ok) {
        throw new Error(started?.message ?? `Upload failed (${response.status})`)
      }

      setProgress(started)

      const finished = await poll(started.jobId)
      if (!finished) return

      setOutcome(finished.outcome)
      onUploaded()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Upload failed.")
    } finally {
      if (!cancelled.current) setBusy(false)
      if (inputRef.current) inputRef.current.value = ""
    }
  }

  return (
    <section className="rounded-xl border border-white/10 bg-black/50 p-5 backdrop-blur-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium uppercase tracking-wider text-white/60">
            Store on Filecoin
          </h2>
          <p className="mt-1 text-xs text-white/35">
            Uploads to Warm Storage, opens a real payment rail, and enters the file as a
            defendant.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <select
            value={priority}
            onChange={(event) => setPriority(event.target.value as FilePriority)}
            disabled={busy}
            className="rounded-lg border border-white/15 bg-black/60 px-2 py-2 text-sm text-white/80 disabled:opacity-40"
          >
            {PRIORITIES.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>

          <input
            ref={inputRef}
            type="file"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) void submit(file)
            }}
          />

          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={busy}
            className="flex items-center gap-2 rounded-lg border border-white/20 bg-white/5 px-3 py-2 text-sm font-medium text-white/90 transition-colors hover:border-white/40 hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <UploadCloud className="h-4 w-4" />
            )}
            {busy ? "Storing on Filecoin…" : "Upload file"}
          </button>
        </div>
      </div>

      {busy ? (
        <div className="mt-3 rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2">
          <p className="flex items-center gap-2 text-xs text-white/60">
            <Loader2 className="h-3 w-3 animate-spin" />
            {STAGE_LABEL[progress?.state ?? "committing"]}
          </p>
          <p className="mt-1 text-[11px] text-white/30">
            Around a minute. The bytes are already safe with the provider; what is left is
            the on-chain commit. Leave this tab open -- closing it stops the upload being
            finished.
          </p>
          {progress?.pieceCid ? (
            <p className="mt-1.5 break-all font-mono text-[11px] text-white/35">
              piece CID : {progress.pieceCid}
            </p>
          ) : null}
        </div>
      ) : null}

      {error ? (
        <div className="mt-3 rounded-lg border border-red-400/30 bg-red-400/10 px-3 py-2 text-xs text-red-200">
          {error}
        </div>
      ) : null}

      {outcome ? (
        <div className="mt-3 rounded-lg border border-emerald-400/30 bg-emerald-400/10 px-3 py-2 text-xs text-emerald-100">
          <div className="flex items-center gap-2 font-medium">
            <CheckCircle2 className="h-3.5 w-3.5" />
            Stored {outcome.name} ({formatBytes(outcome.sizeBytes)})
          </div>
          <dl className="mt-1.5 space-y-0.5 font-mono text-[11px] text-emerald-200/70">
            <div className="break-all">piece CID : {outcome.pieceCid}</div>
            <div>data set : {outcome.dataSetId ?? "pending"}</div>
            <div>PDP rail : {outcome.pdpRailId ?? "pending"}</div>
          </dl>
        </div>
      ) : null}
    </section>
  )
}
