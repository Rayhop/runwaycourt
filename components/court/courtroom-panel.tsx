"use client"

import { useState } from "react"
import { Download, Gavel, Loader2, ShieldAlert, ShieldCheck } from "lucide-react"

import type { CourtPreview, PreviewFile } from "@/lib/court/preview"
import { formatBytes, formatUSDFC, perEpochToPerMonth } from "@/lib/epochs"
import { cn } from "@/lib/utils"

/**
 * The Courtroom.
 *
 * Every file, ranked by Survival Score, with the four score terms broken out
 * and the verdict it is currently heading for. Rows animate to new positions as
 * scores change, so the ranking visibly reorders while you watch -- this is the
 * "watch it happen" surface.
 */

interface CourtroomPanelProps {
  preview: CourtPreview | null
  loading: boolean
  running: boolean
  onConvene: () => void
  onRetrieve: (fileId: string) => void
}

/** Why the court landed where it did -- shown on hover over the verdict chip. */
const VERDICT_REASONS = {
  merit: "Score went negative: the file cannot justify its rail at any budget.",
  budget: "Score is positive, but the budget ran out before reaching it.",
  afforded: "Funded at the full warm rate inside the budget.",
} as const

const VERDICT_STYLES = {
  KEEP: "border-emerald-400/40 bg-emerald-400/10 text-emerald-300",
  DOWNGRADE: "border-amber-400/40 bg-amber-400/10 text-amber-300",
  DROP: "border-red-400/40 bg-red-400/10 text-red-300",
} as const

/** Horizontal bar showing how the four terms combine into the score. */
function ScoreBar({ file, maxScore }: { file: PreviewFile; maxScore: number }) {
  const { accessTerm, recencyTerm, priorityTerm, costPenalty } = file.breakdown

  // Positive terms stack left-to-right; the cost penalty is drawn as a
  // subtracted segment so you can see what the file is being charged.
  const positive = Math.max(0, accessTerm) + Math.max(0, recencyTerm) + Math.max(0, priorityTerm)
  const scale = maxScore > 0 ? 100 / maxScore : 0

  const segments = [
    { key: "access", value: Math.max(0, accessTerm), className: "bg-sky-400/80", label: "access" },
    { key: "recency", value: Math.max(0, recencyTerm), className: "bg-violet-400/80", label: "recency" },
    { key: "priority", value: Math.max(0, priorityTerm), className: "bg-emerald-400/80", label: "priority" },
  ]

  return (
    <div className="mt-2">
      <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-white/[0.06]">
        {segments.map((segment) => (
          <div
            key={segment.key}
            className={cn("h-full transition-all duration-500", segment.className)}
            style={{ width: `${Math.min(100, segment.value * scale)}%` }}
            title={`${segment.label}: +${segment.value.toFixed(1)}`}
          />
        ))}
        <div
          className="h-full bg-red-500/60 transition-all duration-500"
          style={{ width: `${Math.min(100, costPenalty * scale)}%` }}
          title={`cost: -${costPenalty.toFixed(1)}`}
        />
      </div>
      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[10px] text-white/40">
        <span className="text-sky-300/70">access +{accessTerm.toFixed(1)}</span>
        <span className="text-violet-300/70">recency +{recencyTerm.toFixed(1)}</span>
        <span className="text-emerald-300/70">priority {priorityTerm >= 0 ? "+" : ""}{priorityTerm.toFixed(1)}</span>
        <span className="text-red-300/70">cost −{costPenalty.toFixed(1)}</span>
        <span className="ml-auto text-white/25">
          {positive.toFixed(1)} − {costPenalty.toFixed(1)}
        </span>
      </div>
    </div>
  )
}

function FileRow({
  file,
  maxScore,
  onRetrieve,
  retrieving,
}: {
  file: PreviewFile
  maxScore: number
  onRetrieve: (id: string) => void
  retrieving: boolean
}) {
  const { breakdown } = file

  return (
    <li className="rounded-lg border border-white/10 bg-white/[0.02] p-3 transition-colors hover:bg-white/[0.04]">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 w-6 shrink-0 text-center font-mono text-xs text-white/30">
          {file.rank}
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate font-medium text-white/90">{file.name}</span>

            <span
              title={VERDICT_REASONS[file.verdictReason]}
              className={cn(
                "shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider",
                VERDICT_STYLES[file.projectedVerdict],
              )}
            >
              {file.projectedVerdict}
              {file.verdictReason === "merit" ? (
                <span className="ml-1 font-normal opacity-70">on merit</span>
              ) : null}
            </span>

            {file.proof ? (
              <span
                title={
                  file.proof.atRisk
                    ? `Provider missed its proving deadline (epoch ${file.proof.provingDeadline}). ` +
                      "You are paying for storage nobody has recently attested to."
                    : `PDP live · ${file.proof.activePieces} pieces · ` +
                      `next challenge epoch ${file.proof.nextChallengeEpoch ?? "?"}`
                }
                className={cn(
                  "flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wider",
                  file.proof.atRisk
                    ? "border-red-400/40 bg-red-400/10 text-red-300"
                    : file.proof.live
                      ? "border-white/15 text-white/40"
                      : "border-white/10 text-white/25",
                )}
              >
                {file.proof.atRisk ? (
                  <ShieldAlert className="h-3 w-3" />
                ) : (
                  <ShieldCheck className="h-3 w-3" />
                )}
                {file.proof.atRisk ? "proof overdue" : file.proof.live ? "pdp ok" : "not live"}
              </span>
            ) : null}

            {file.tier === "cold" ? (
              <span className="shrink-0 rounded border border-white/15 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-white/40">
                single-copy
              </span>
            ) : null}
          </div>

          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-white/40">
            <span>{formatBytes(file.sizeBytes)}</span>
            <span>{file.priority}</span>
            <span>
              {breakdown.accessesLast7d} hit{breakdown.accessesLast7d === 1 ? "" : "s"}/7d
            </span>
            <span>
              {breakdown.daysSinceAccess === null
                ? "never retrieved"
                : `${breakdown.daysSinceAccess.toFixed(1)}d idle`}
            </span>
            <span>
              {formatUSDFC(perEpochToPerMonth(BigInt(file.costPerEpoch)), 3)} USDFC/mo
            </span>
            {file.dataSetId ? (
              <span className="font-mono text-white/30">dataSet {file.dataSetId}</span>
            ) : null}
          </div>

          <ScoreBar file={file} maxScore={maxScore} />
        </div>

        <div className="flex shrink-0 flex-col items-end gap-1">
          <span className="font-mono text-lg tabular-nums text-white/90">
            {file.score.toFixed(1)}
          </span>
          <button
            type="button"
            onClick={() => onRetrieve(file.id)}
            disabled={retrieving}
            title="Record a retrieval — raises access and recency, so the score climbs"
            className="flex items-center gap-1 rounded border border-white/15 px-1.5 py-0.5 text-[10px] text-white/50 transition-colors hover:border-white/30 hover:text-white/80 disabled:opacity-40"
          >
            {retrieving ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Download className="h-3 w-3" />
            )}
            retrieve
          </button>
        </div>
      </div>
    </li>
  )
}

export function CourtroomPanel({
  preview,
  loading,
  running,
  onConvene,
  onRetrieve,
}: CourtroomPanelProps) {
  const [retrievingId, setRetrievingId] = useState<string | null>(null)

  async function handleRetrieve(fileId: string) {
    setRetrievingId(fileId)
    try {
      await onRetrieve(fileId)
    } finally {
      setRetrievingId(null)
    }
  }

  const files = preview?.files ?? []
  const maxScore = Math.max(1, ...files.map((f) => Math.abs(f.score)))

  return (
    <section className="rounded-xl border border-white/10 bg-black/50 p-5 backdrop-blur-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium uppercase tracking-wider text-white/60">Courtroom</h2>
          <p className="mt-1 text-xs text-white/35">
            {files.length} file{files.length === 1 ? "" : "s"} on trial · ranked by Survival Score
          </p>
        </div>

        <button
          type="button"
          onClick={onConvene}
          disabled={running || !preview}
          className="flex items-center gap-2 rounded-lg border border-white/20 bg-white/5 px-3 py-2 text-sm font-medium text-white/90 transition-colors hover:border-white/40 hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Gavel className="h-4 w-4" />}
          {running ? "In session…" : "Convene court"}
        </button>
      </div>

      {preview?.belowThreshold ? (
        <p className="mt-3 rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-xs text-amber-200">
          Runway is below threshold — the agent will convene on its own at the next tick.
        </p>
      ) : null}

      {files.length === 0 ? (
        <p className="mt-4 text-sm text-white/40">
          {loading
            ? "Scoring inventory…"
            : preview?.needsWallet
              ? "Link a wallet above to see the data sets it is paying for."
              : "No files under management."}
        </p>
      ) : (
        <ul className="mt-4 space-y-2">
          {files.map((file) => (
            <FileRow
              key={file.id}
              file={file}
              maxScore={maxScore}
              onRetrieve={handleRetrieve}
              retrieving={retrievingId === file.id}
            />
          ))}
        </ul>
      )}
    </section>
  )
}
