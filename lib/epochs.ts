/**
 * Filecoin epoch math.
 *
 * These constants are fixed by the Filecoin Pay payment system -- do not
 * "simplify" them into approximations. Prices are quoted per-month onchain but
 * rails settle per-epoch, so all internal math is done per-epoch and only
 * converted for display.
 */

/** One epoch is 30 seconds. */
export const SECONDS_PER_EPOCH = 30

/** Filecoin Pay defines one "month" as exactly 86,400 epochs (30 days). */
export const EPOCHS_PER_MONTH = 86_400

export const EPOCHS_PER_HOUR = 120
export const EPOCHS_PER_DAY = 2_880

/** USDFC is an 18-decimal ERC-20. */
export const USDFC_DECIMALS = 18
export const USDFC_UNIT = 10n ** BigInt(USDFC_DECIMALS)

export function epochsToMs(epochs: number): number {
  return epochs * SECONDS_PER_EPOCH * 1000
}

export function msToEpochs(ms: number): number {
  return Math.floor(ms / (SECONDS_PER_EPOCH * 1000))
}

export function epochsToDays(epochs: number): number {
  return epochs / EPOCHS_PER_DAY
}

export function daysToEpochs(days: number): number {
  return Math.round(days * EPOCHS_PER_DAY)
}

/** Convert a per-month rate to per-epoch. Rounds down, matching rail settlement. */
export function perMonthToPerEpoch(perMonth: bigint): bigint {
  return perMonth / BigInt(EPOCHS_PER_MONTH)
}

export function perEpochToPerMonth(perEpoch: bigint): bigint {
  return perEpoch * BigInt(EPOCHS_PER_MONTH)
}

/**
 * Human-readable runway, e.g. "2.1 days" or "4.5 hours".
 * Deliberately coarse -- this is demo copy, not accounting.
 */
export function formatRunway(epochs: number): string {
  if (!Number.isFinite(epochs)) return "unlimited"
  if (epochs <= 0) return "0 (in deficit)"

  const days = epochsToDays(epochs)
  if (days >= 1) return `${days.toFixed(1)} days`

  const hours = epochs / EPOCHS_PER_HOUR
  if (hours >= 1) return `${hours.toFixed(1)} hours`

  return `${Math.max(1, Math.round(epochs * SECONDS_PER_EPOCH / 60))} min`
}

/** Format an atomic USDFC amount for display. */
export function formatUSDFC(atomic: bigint, fractionDigits = 4): string {
  const negative = atomic < 0n
  const abs = negative ? -atomic : atomic

  const whole = abs / USDFC_UNIT
  const frac = abs % USDFC_UNIT

  const fracStr = frac.toString().padStart(USDFC_DECIMALS, "0").slice(0, fractionDigits)
  const sign = negative ? "-" : ""

  return fractionDigits > 0 ? `${sign}${whole}.${fracStr}` : `${sign}${whole}`
}

/** Parse a decimal USDFC string into atomic units without floating point. */
export function parseUSDFC(value: string): bigint {
  const trimmed = value.trim()
  const negative = trimmed.startsWith("-")
  const unsigned = negative ? trimmed.slice(1) : trimmed

  const [whole = "0", frac = ""] = unsigned.split(".")
  const paddedFrac = frac.padEnd(USDFC_DECIMALS, "0").slice(0, USDFC_DECIMALS)

  const atomic = BigInt(whole || "0") * USDFC_UNIT + BigInt(paddedFrac || "0")
  return negative ? -atomic : atomic
}

/** Bytes -> human readable, for the file table. */
export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"]
  let value = bytes
  let unit = 0

  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }

  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}
