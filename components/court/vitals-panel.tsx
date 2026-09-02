"use client"

import { AlertTriangle, Coins, Flame, Timer } from "lucide-react"

import type { CourtPreview } from "@/lib/court/preview"
import {
  EPOCHS_PER_DAY,
  formatRunway,
  formatUSDFC,
  perEpochToPerMonth,
} from "@/lib/epochs"
import { cn } from "@/lib/utils"

/**
 * Vitals: the number the whole project turns on.
 *
 * Runway is read from Filecoin Pay (or the simulator) and shown in both epochs
 * and human time, because the judging criteria care about the moment a decision
 * gets made and this is the gauge that triggers it.
 */

interface VitalsPanelProps {
  preview: CourtPreview | null
  loading: boolean
}

function Stat({
  icon,
  label,
  value,
  sub,
  tone = "default",
}: {
  icon: React.ReactNode
  label: string
  value: string
  sub?: string
  tone?: "default" | "warn" | "danger"
}) {
  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.03] p-4">
      <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-white/50">
        {icon}
        {label}
      </div>
      <div
        className={cn(
          "mt-2 font-mono text-2xl tabular-nums",
          tone === "default" && "text-white",
          tone === "warn" && "text-amber-300",
          tone === "danger" && "text-red-400",
        )}
      >
        {value}
      </div>
      {sub ? <div className="mt-1 text-xs text-white/40">{sub}</div> : null}
    </div>
  )
}

export function VitalsPanel({ preview, loading }: VitalsPanelProps) {
  if (!preview) {
    return (
      <section className="rounded-xl border border-white/10 bg-black/50 p-5 backdrop-blur-sm">
        <h2 className="text-sm font-medium uppercase tracking-wider text-white/60">Vitals</h2>
        <p className="mt-3 text-sm text-white/40">
          {loading ? "Reading account…" : "No reading yet."}
        </p>
      </section>
    )
  }

  const { vitals, thresholdEpochs, belowThreshold } = preview

  const unlimited = vitals.runwayInEpochs < 0
  const runwayEpochs = unlimited ? Number.POSITIVE_INFINITY : vitals.runwayInEpochs

  const tone = vitals.inDeficit
    ? "danger"
    : belowThreshold
      ? "warn"
      : "default"

  // Progress bar is scaled against 2x the threshold so the trigger point sits
  // at the halfway mark and is easy to read at a glance.
  const scaleMax = thresholdEpochs * 2
  const fill = unlimited ? 1 : Math.max(0, Math.min(1, runwayEpochs / scaleMax))
  const triggerAt = 0.5

  const burnPerEpoch = BigInt(vitals.lockupRatePerEpoch)

  return (
    <section className="rounded-xl border border-white/10 bg-black/50 p-5 backdrop-blur-sm">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-medium uppercase tracking-wider text-white/60">Vitals</h2>
        <span className="rounded-full border border-white/15 px-2 py-0.5 text-[10px] uppercase tracking-wider text-white/50">
          {vitals.source}
        </span>
      </div>

      {vitals.inDeficit ? (
        <div className="mt-4 flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-200">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <p>
            <strong className="font-semibold">Account in deficit.</strong> New uploads fail and
            providers can terminate rails and claim against the lockup.
          </p>
        </div>
      ) : null}

      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          icon={<Timer className="h-3.5 w-3.5" />}
          label="Runway"
          value={formatRunway(runwayEpochs)}
          sub={unlimited ? "no active rails" : `${Math.round(runwayEpochs).toLocaleString()} epochs`}
          tone={tone}
        />
        <Stat
          icon={<Coins className="h-3.5 w-3.5" />}
          label="Available"
          value={`${formatUSDFC(BigInt(vitals.availableFunds), 3)}`}
          sub={`USDFC · ${formatUSDFC(BigInt(vitals.funds), 3)} deposited`}
        />
        <Stat
          icon={<Flame className="h-3.5 w-3.5" />}
          label="Burn rate"
          value={formatUSDFC(perEpochToPerMonth(burnPerEpoch), 3)}
          sub="USDFC / month"
        />
        <Stat
          icon={<AlertTriangle className="h-3.5 w-3.5" />}
          label="Debt"
          value={formatUSDFC(BigInt(vitals.debt), 3)}
          sub={BigInt(vitals.debt) > 0n ? "owed to providers" : "none"}
          tone={BigInt(vitals.debt) > 0n ? "danger" : "default"}
        />
      </div>

      {/* Runway gauge with the court's trigger point marked. */}
      <div className="mt-5">
        <div className="relative h-2 overflow-hidden rounded-full bg-white/10">
          <div
            className={cn(
              "h-full rounded-full transition-[width] duration-700 ease-out",
              tone === "danger" && "bg-red-500",
              tone === "warn" && "bg-amber-400",
              tone === "default" && "bg-emerald-400",
            )}
            style={{ width: `${fill * 100}%` }}
          />
          <div
            className="absolute inset-y-0 w-px bg-white/60"
            style={{ left: `${triggerAt * 100}%` }}
          />
        </div>
        <div className="mt-2 flex justify-between text-[11px] text-white/40">
          <span>0</span>
          <span className={belowThreshold ? "text-amber-300" : undefined}>
            court convenes below {(thresholdEpochs / EPOCHS_PER_DAY).toFixed(1)}d
          </span>
          <span>{(scaleMax / EPOCHS_PER_DAY).toFixed(0)}d</span>
        </div>
      </div>
    </section>
  )
}
