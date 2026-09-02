/**
 * Exercises the decision engine end to end with fixtures -- no Supabase, no
 * chain. Run: npx tsx scripts/verify-court.ts
 */
import { scoreFile, rankFiles, budgetPerEpoch } from "@/lib/court/scoring"
import { decideVerdicts, spendPerEpoch } from "@/lib/court/verdicts"
import { narrateSession, narrateVerdict } from "@/lib/court/narrate"
import { formatRunway, formatUSDFC, EPOCHS_PER_DAY } from "@/lib/epochs"
import type { FileRow } from "@/lib/supabase/types"

const now = new Date()
const daysAgo = (d: number) => new Date(now.getTime() - d * 864e5).toISOString()

const file = (
  name: string,
  costPerEpoch: string,
  priority: FileRow["priority"],
  idleDays: number,
): FileRow => ({
  id: name, user_id: null, name, piece_cid: null, size_bytes: 1_000_000,
  cost_per_epoch: costPerEpoch, tier: "warm", priority, status: "active",
  last_accessed_at: daysAgo(idleDays), created_at: daysAgo(90), dropped_at: null,
  data_set_id: null, pdp_rail_id: null, cdn_rail_id: null, provider: null, synced_at: null,
})

const fixtures: [FileRow, number][] = [
  [file("client-invoices-2026.zip",   "9000000000000",   "critical", 0.1), 40],
  [file("prod-db-snapshot.sql.gz",    "42000000000000",  "critical", 0.4), 14],
  [file("analytics-events-raw.parquet","63000000000000", "normal",   0.3), 22],
  [file("brand-assets-final.tar",     "17000000000000",  "normal",   3),    2],
  [file("user-uploads-2026-q1.tar",   "88000000000000",  "normal",   1),    6],
  [file("legal-retention-2019.pdf",   "700000000000",    "critical", 46),   0],
  [file("marketing-site-backup.zip",  "11000000000000",  "archive",  12),   0],
  [file("old-render-cache.mp4",       "140000000000000", "junk",     19),   0],
  [file("scratch-experiment-b.tmp",   "26000000000000",  "junk",     27),   0],
  [file("training-run-47-ckpt.bin",   "210000000000000", "archive",  31),   0],
]

const ranked = rankFiles(fixtures.map(([f, hits]) => scoreFile(f, hits, now)))

const availableFunds = 5_000_000_000_000_000_000n // 5 USDFC
const targetRunway = 10 * EPOCHS_PER_DAY
const budget = budgetPerEpoch(availableFunds, targetRunway)

const decisions = decideVerdicts(ranked, budget)
const spend = spendPerEpoch(decisions)

const burnBefore = fixtures.reduce((s, [f]) => s + BigInt(f.cost_per_epoch), 0n)
const runwayBefore = Number(availableFunds / burnBefore)
const runwayAfter = spend === 0n ? Infinity : Number(availableFunds / spend)

console.log(`budget/epoch : ${formatUSDFC(budget, 8)} USDFC`)
console.log(`burn before  : ${formatUSDFC(burnBefore, 8)} USDFC/epoch -> ${formatRunway(runwayBefore)}`)
console.log(`spend after  : ${formatUSDFC(spend, 8)} USDFC/epoch -> ${formatRunway(runwayAfter)}`)
console.log()

const penalties = decisions.map(d => d.scored.breakdown.costPenalty).sort((a, b) => a - b)
const median = penalties[Math.floor(penalties.length / 2)] ?? 1

for (const [i, d] of decisions.entries()) {
  console.log(
    `${String(i + 1).padStart(2)}. ${d.verdict.padEnd(9)} ${d.scored.score.toFixed(1).padStart(7)}  ${d.scored.file.name}`,
  )
  console.log(`    ${narrateVerdict(d.scored, d.verdict, median, d.reason)}`)
}

const counts = { KEEP: 0, DOWNGRADE: 0, DROP: 0 }
for (const d of decisions) counts[d.verdict]++

console.log()
console.log(narrateSession({
  sessionNumber: 1,
  runwayBeforeEpochs: runwayBefore,
  runwayAfterEpochs: runwayAfter,
  triggerRunwayEpochs: 3 * EPOCHS_PER_DAY,
  kept: counts.KEEP, downgraded: counts.DOWNGRADE, dropped: counts.DROP,
}))

// Invariants.
const errors: string[] = []
if (spend > budget) errors.push(`spend ${spend} exceeds budget ${budget}`)
if (runwayAfter < runwayBefore) errors.push("runway did not improve")
for (let i = 1; i < ranked.length; i++) {
  if (ranked[i - 1].score < ranked[i].score) errors.push("ranking not descending")
}
console.log()
console.log(errors.length ? `FAIL: ${errors.join("; ")}` : "PASS: all invariants hold")
process.exit(errors.length ? 1 : 0)
