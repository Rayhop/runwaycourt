/**
 * Store a file on Filecoin Warm Storage from the CLI and enter it in the court.
 *
 *   npm run upload:filecoin -- ./path/to/file
 *
 * Same code path as the dashboard's upload button, so if this works the UI does.
 */
import "./load-env"

import { readFile } from "node:fs/promises"
import { basename } from "node:path"

import { formatBytes, formatUSDFC, perEpochToPerMonth } from "@/lib/epochs"

async function main() {
  const path = process.argv[2]
  if (!path) throw new Error("Usage: npm run upload:filecoin -- <path> [priority]")

  const priority = (process.argv[3] ?? "normal") as
    | "critical" | "normal" | "archive" | "junk"

  const data = new Uint8Array(await readFile(path))
  console.log(`Storing ${basename(path)} (${formatBytes(data.length)}) on Filecoin…`)

  const userId = process.env.RUNWAYCOURT_USER_ID
  if (!userId) {
    throw new Error(
      "Set RUNWAYCOURT_USER_ID to the auth.users id whose court should own this file. " +
        "Find it in Supabase -> Authentication -> Users.",
    )
  }

  const { uploadAndEnrol } = await import("@/lib/filecoin/upload")
  const out = await uploadAndEnrol({ userId, name: basename(path), data, priority })

  console.log("\nStored and enrolled:")
  console.log(`  piece CID   : ${out.pieceCid}`)
  console.log(`  size        : ${formatBytes(out.sizeBytes)}`)
  console.log(`  data set    : ${out.dataSetId ?? "pending"}`)
  console.log(`  PDP rail    : ${out.pdpRailId ?? "pending"}`)
  console.log(`  provider    : ${out.provider ?? "pending"}`)
  console.log(`  cost        : ${formatUSDFC(perEpochToPerMonth(BigInt(out.costPerEpoch)), 6)} USDFC/month`)
  console.log("\nOpen the dashboard -- it is now a defendant.")
}

main().catch((error) => {
  console.error(`\nFAILED: ${error instanceof Error ? error.message : error}`)
  process.exit(1)
})
