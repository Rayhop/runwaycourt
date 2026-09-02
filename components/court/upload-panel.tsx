"use client"

import { useRef, useState } from "react"
import { CheckCircle2, Loader2, UploadCloud } from "lucide-react"

import { formatBytes } from "@/lib/epochs"
import type { FilePriority } from "@/lib/supabase/types"

/**
 * Store a real file on Filecoin and put it on trial.
 *
 * Only rendered in synapse mode -- in simulator mode there is no chain to
 * store to, and offering the control would be a lie.
 */

interface UploadPanelProps {
  onUploaded: () => void
}

interface Outcome {
  name: string
  pieceCid: string
  sizeBytes: number
  dataSetId: string | null
  pdpRailId: string | null
}

const PRIORITIES: FilePriority[] = ["critical", "normal", "archive", "junk"]

export function UploadPanel({ onUploaded }: UploadPanelProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [priority, setPriority] = useState<FilePriority>("normal")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [outcome, setOutcome] = useState<Outcome | null>(null)

  async function submit(file: File) {
    setBusy(true)
    setError(null)
    setOutcome(null)

    try {
      const body = new FormData()
      body.append("file", file)
      body.append("priority", priority)

      const response = await fetch("/api/filecoin/upload", { method: "POST", body })
      const json = await response.json()

      if (!response.ok) throw new Error(json?.message ?? `Upload failed (${response.status})`)

      setOutcome(json as Outcome)
      onUploaded()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Upload failed.")
    } finally {
      setBusy(false)
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
        <p className="mt-3 text-xs text-white/40">
          Computing piece CID, sending to a provider, and waiting for the data set. This can
          take a minute or two.
        </p>
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
