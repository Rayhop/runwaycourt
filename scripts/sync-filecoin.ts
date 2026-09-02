/**
 * Pull the wallet's real FWSS data sets into Supabase.
 *
 *   npm run sync:filecoin
 *
 * After this, the court is trying data that actually exists onchain: each row
 * carries the data_set_id terminateService() needs, so a DROP verdict is a real
 * transaction rather than a note in a log.
 *
 * Cost and size are both read from chain, not estimated:
 *
 *   cost_per_epoch  = pdpRail.paymentRate + cdnRail.paymentRate
 *                     (Filecoin Pay's actual per-epoch charge for that set)
 *   size_bytes      = getDataSetLeafCount(dataSetId) * 32
 *                     (PDP verifier's leaf count, 32 bytes per leaf)
 *
 * Requires: Supabase env vars, plus FILECOIN_ADDRESS or FILECOIN_PRIVATE_KEY.
 * Reads only -- it submits nothing.
 */
import "./load-env"

import { createClient } from "@supabase/supabase-js"
import { createPublicClient, http } from "viem"
import { calibration, mainnet } from "@filoz/synapse-core/chains"
import { getAccountSummary, getRail } from "@filoz/synapse-core/pay"
import { getDataSetLeafCount } from "@filoz/synapse-core/pdp-verifier"
import { getClientDataSets } from "@filoz/synapse-core/warm-storage"

import { formatBytes, formatUSDFC } from "@/lib/epochs"

/** PDP stores 32 bytes per leaf. */
const BYTES_PER_LEAF = 32n

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!url || !key) {
    throw new Error("Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY (see .env.example).")
  }

  const network = process.env.FILECOIN_NETWORK ?? "calibration"
  const chain = network === "mainnet" ? mainnet : calibration
  const rpcUrl = process.env.FILECOIN_RPC_URL
  const client = createPublicClient({ chain, transport: rpcUrl ? http(rpcUrl) : http() })

  let address = process.env.FILECOIN_ADDRESS as `0x${string}` | undefined
  if (!address && process.env.FILECOIN_PRIVATE_KEY) {
    const { privateKeyToAccount } = await import("viem/accounts")
    const pk = process.env.FILECOIN_PRIVATE_KEY
    address = privateKeyToAccount((pk.startsWith("0x") ? pk : `0x${pk}`) as `0x${string}`).address
  }
  if (!address) throw new Error("Set FILECOIN_ADDRESS or FILECOIN_PRIVATE_KEY.")

  console.log(`Syncing ${address} on ${network}…`)

  const [sets, summary] = await Promise.all([
    getClientDataSets(client, { address }),
    getAccountSummary(client, { address, token: chain.contracts.usdfc.address }),
  ])

  console.log(`Found ${sets.items.length} data set(s) onchain.`)

  if (sets.items.length === 0) {
    console.log(
      "\nNothing to sync. Upload through Warm Storage first, then re-run.\n" +
        "Without a data set there is no rail, and without a rail runway is unbounded.",
    )
    return
  }

  const supabase = createClient(url, key, { auth: { persistSession: false } })
  const now = new Date().toISOString()

  let inserted = 0
  let updated = 0
  let totalRate = 0n

  for (const info of sets.items) {
    const dataSetId = info.dataSetId.toString()

    // Real per-epoch charge: sum the rails actually settling for this set.
    // A rail id of 0 means that rail was never opened (e.g. no CDN).
    const railIds = [info.pdpRailId, info.cdnRailId, info.cacheMissRailId].filter((id) => id > 0n)

    const rails = await Promise.all(
      railIds.map(async (railId) => {
        try {
          return await getRail(client, { railId })
        } catch {
          // A terminated or settled-out rail can revert; treat as no charge.
          return null
        }
      }),
    )

    const costPerEpoch = rails.reduce((sum, rail) => sum + (rail?.paymentRate ?? 0n), 0n)
    totalRate += costPerEpoch

    // Real size from the PDP verifier's leaf count.
    let sizeBytes = 0n
    try {
      sizeBytes = (await getDataSetLeafCount(client, { dataSetId: info.dataSetId })) * BYTES_PER_LEAF
    } catch {
      // Set not live yet, or verifier has no record. Leave at 0 rather than guessing.
    }

    const { data: existing, error: readError } = await supabase
      .from("files")
      .select("id, name, priority")
      .eq("data_set_id", dataSetId)
      .maybeSingle()

    if (readError) throw new Error(`Lookup failed for ${dataSetId}: ${readError.message}`)

    const row = {
      data_set_id: dataSetId,
      pdp_rail_id: info.pdpRailId.toString(),
      cdn_rail_id: info.cdnRailId.toString(),
      provider: info.serviceProvider,
      synced_at: now,
      cost_per_epoch: costPerEpoch.toString(),
      size_bytes: Number(sizeBytes),
      tier: "warm" as const,
      status: "active" as const,
    }

    console.log(
      `  dataSetId=${dataSetId}  ${formatBytes(Number(sizeBytes)).padStart(9)}  ` +
        `${formatUSDFC(costPerEpoch, 12)} USDFC/epoch  rails=[${railIds.join(",")}]`,
    )

    if (existing) {
      // Preserve the operator's own name and priority tag across re-syncs.
      const { error } = await supabase.from("files").update(row).eq("id", existing.id)
      if (error) throw new Error(`Update failed for ${dataSetId}: ${error.message}`)
      updated++
    } else {
      const { error } = await supabase.from("files").insert({
        ...row,
        name: `dataset-${dataSetId}`,
        priority: "normal",
        last_accessed_at: now,
      })
      if (error) throw new Error(`Insert failed for ${dataSetId}: ${error.message}`)
      inserted++
    }
  }

  console.log(`\nSynced: ${inserted} inserted, ${updated} updated.`)

  // Sanity check: the rails we summed should account for the account's own
  // burn rate. A mismatch means some rail is missing from the inventory, and
  // the court would be budgeting against an incomplete picture.
  console.log(`Summed rail rate : ${formatUSDFC(totalRate, 12)} USDFC/epoch`)
  console.log(`Account burn rate: ${formatUSDFC(summary.lockupRatePerEpoch, 12)} USDFC/epoch`)

  if (totalRate !== summary.lockupRatePerEpoch) {
    const delta = summary.lockupRatePerEpoch - totalRate
    console.warn(
      `\nWARNING: ${formatUSDFC(delta < 0n ? -delta : delta, 12)} USDFC/epoch unaccounted for.\n` +
        "The account is paying for rails not represented in `files`, so dropping\n" +
        "everything here would not take runway to zero. Check for data sets owned\n" +
        "by this account outside FWSS.",
    )
  } else {
    console.log("Rails reconcile exactly with the account burn rate.")
  }

  console.log("\nSet RUNWAYCOURT_CHAIN=synapse and restart to try these onchain.")
}

main().catch((error) => {
  console.error("\nFAILED:", error instanceof Error ? error.message : error)
  process.exit(1)
})
