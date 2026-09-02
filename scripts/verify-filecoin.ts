/**
 * Proof of live Filecoin connectivity.
 *
 *   npx tsx scripts/verify-filecoin.ts
 *
 * Reads real values off the chain and prints them. No Supabase, no funds, no
 * private key required -- reads work with an RPC endpoint alone. Set
 * FILECOIN_ADDRESS (or FILECOIN_PRIVATE_KEY) to inspect a specific account.
 *
 * Run this in front of a judge: every number below comes off Calibration.
 */
import "./load-env"

import { createPublicClient, http } from "viem"
import { calibration, mainnet } from "@filoz/synapse-core/chains"
import { getAccountSummary } from "@filoz/synapse-core/pay"
import { getClientDataSets, getPriceList } from "@filoz/synapse-core/warm-storage"

import { EPOCHS_PER_MONTH, formatRunway, formatUSDFC } from "@/lib/epochs"

const UINT256_MAX = (1n << 256n) - 1n
const RUNWAY_SENTINEL = 10n ** 12n

const toRunway = (e: bigint) =>
  e >= RUNWAY_SENTINEL || e === UINT256_MAX ? Number.POSITIVE_INFINITY : Number(e)

async function main() {
  const network = process.env.FILECOIN_NETWORK ?? "calibration"
  const chain = network === "mainnet" ? mainnet : calibration

  const rpcUrl = process.env.FILECOIN_RPC_URL
  const client = createPublicClient({ chain, transport: rpcUrl ? http(rpcUrl) : http() })

  console.log(`network        : ${network} (chain ${chain.id})`)
  console.log(`filecoinPay    : ${chain.contracts.filecoinPay.address}`)
  console.log(`fwssView       : ${chain.contracts.fwssView.address}`)
  console.log(`USDFC          : ${chain.contracts.usdfc.address}`)

  const head = await client.getBlockNumber()
  console.log(`head epoch     : ${head}`)

  // ---- Warm Storage pricing, live ----------------------------------------
  const prices = await getPriceList(client)
  const perEpoch = prices.rates.storagePerTibPerMonth / BigInt(EPOCHS_PER_MONTH)

  console.log("\n== Warm Storage pricing (live) ==")
  console.log(`storage / TiB / month : ${formatUSDFC(prices.rates.storagePerTibPerMonth, 6)} USDFC`)
  console.log(`storage / TiB / epoch : ${formatUSDFC(perEpoch, 12)} USDFC`)
  console.log(`dataset fee / month   : ${formatUSDFC(prices.rates.datasetFeePerMonth, 6)} USDFC`)

  // ---- Account health, live ----------------------------------------------
  let address = process.env.FILECOIN_ADDRESS as `0x${string}` | undefined

  if (!address && process.env.FILECOIN_PRIVATE_KEY) {
    const { privateKeyToAccount } = await import("viem/accounts")
    const key = process.env.FILECOIN_PRIVATE_KEY
    address = privateKeyToAccount((key.startsWith("0x") ? key : `0x${key}`) as `0x${string}`).address
  }

  if (!address) {
    console.log(
      "\nNo FILECOIN_ADDRESS or FILECOIN_PRIVATE_KEY set — skipping account read.\n" +
        "Set one to see live runway for your own wallet.",
    )
    return
  }

  const summary = await getAccountSummary(client, {
    address,
    token: chain.contracts.usdfc.address,
  })

  const runway = toRunway(summary.runwayInEpochs)

  console.log(`\n== Account ${address} (live) ==`)
  console.log(`funds                 : ${formatUSDFC(summary.funds, 6)} USDFC`)
  console.log(`available             : ${formatUSDFC(summary.availableFunds, 6)} USDFC`)
  console.log(`debt                  : ${formatUSDFC(summary.debt, 6)} USDFC`)
  console.log(`burn / epoch          : ${formatUSDFC(summary.lockupRatePerEpoch, 12)} USDFC`)
  console.log(`burn / month          : ${formatUSDFC(summary.lockupRatePerMonth, 6)} USDFC`)
  console.log(`runwayInEpochs        : ${summary.runwayInEpochs}`)
  console.log(`runway                : ${formatRunway(runway)}`)
  console.log(`grossCoverageInEpochs : ${summary.grossCoverageInEpochs}`)
  console.log(`chain epoch           : ${summary.epoch}`)

  if (summary.lockupRatePerEpoch === 0n) {
    console.log(
      "\nNOTE: burn rate is zero, so runway comes back as uint256 max (unbounded).\n" +
        "Upload something through Warm Storage to open a rail and make runway finite.",
    )
  }

  // ---- Data sets, live ----------------------------------------------------
  const sets = await getClientDataSets(client, { address })
  console.log(`\n== Data sets (live): ${sets.items.length} ==`)

  for (const info of sets.items) {
    console.log(
      `  dataSetId=${info.dataSetId}  pdpRail=${info.pdpRailId}  ` +
        `cdnRail=${info.cdnRailId}  provider=${info.serviceProvider}  ` +
        `pdpEndEpoch=${info.pdpEndEpoch}`,
    )
  }

  if (sets.items.length === 0) {
    console.log("  (none — nothing stored on this account yet)")
  }
}

main().catch((error) => {
  console.error("\nFAILED:", error instanceof Error ? error.message : error)
  process.exit(1)
})
