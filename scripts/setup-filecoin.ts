/**
 * One-time onboarding for a Calibration wallet.
 *
 *   npm run setup:filecoin              # dry run -- reports what it would do
 *   npm run setup:filecoin -- --apply   # actually deposits and approves
 *
 * Filecoin Pay needs two things before Warm Storage will store anything:
 *
 *   1. USDFC deposited into the Pay contract (a wallet balance is not enough).
 *   2. FWSS approved as an operator, with a rate allowance (how fast it may
 *      charge) and a lockup allowance (how much it may reserve up front).
 *
 * Without both, uploads fail with an allowance error. Read-only by default so
 * you can see the numbers before spending anything.
 */
import "./load-env"

import { createPublicClient, http, formatUnits } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { calibration, mainnet } from "@filoz/synapse-core/chains"
import { getAccountSummary } from "@filoz/synapse-core/pay"

import { formatUSDFC, parseUSDFC } from "@/lib/epochs"

/** Deposited by default. Override with DEPOSIT_USDFC. */
const DEFAULT_DEPOSIT = "5"

async function main() {
  const apply = process.argv.includes("--apply")

  const privateKey = process.env.FILECOIN_PRIVATE_KEY
  if (!privateKey) {
    throw new Error(
      "FILECOIN_PRIVATE_KEY is not set.\n\n" +
        "Create a throwaway wallet, then fund it on Calibration:\n" +
        "  tFIL  (gas)     https://faucet.calibnet.chainsafe-fil.io/\n" +
        "  tUSDFC (storage) https://forest-explorer.chainsafe.dev/faucet/calibnet_usdfc\n",
    )
  }

  const network = process.env.FILECOIN_NETWORK ?? "calibration"
  const chain = network === "mainnet" ? mainnet : calibration
  const rpcUrl = process.env.FILECOIN_RPC_URL

  const account = privateKeyToAccount(
    (privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`) as `0x${string}`,
  )
  const readClient = createPublicClient({ chain, transport: rpcUrl ? http(rpcUrl) : http() })

  console.log(`network : ${network} (chain ${chain.id})`)
  console.log(`wallet  : ${account.address}`)
  console.log(`mode    : ${apply ? "APPLY -- will send transactions" : "dry run"}\n`)

  // ---- Wallet balances ----------------------------------------------------
  const [gas, usdfcWallet] = await Promise.all([
    readClient.getBalance({ address: account.address }),
    readClient.readContract({
      address: chain.contracts.usdfc.address,
      abi: chain.contracts.usdfc.abi,
      functionName: "balanceOf",
      args: [account.address],
    }) as Promise<bigint>,
  ])

  console.log(`tFIL in wallet  : ${formatUnits(gas, 18)}`)
  console.log(`USDFC in wallet : ${formatUSDFC(usdfcWallet, 6)}`)

  if (gas === 0n) {
    throw new Error(
      "No tFIL for gas. Fund the wallet: https://faucet.calibnet.chainsafe-fil.io/",
    )
  }

  // ---- What Pay already holds --------------------------------------------
  const before = await getAccountSummary(readClient, {
    address: account.address,
    token: chain.contracts.usdfc.address,
  })
  console.log(`USDFC in Filecoin Pay : ${formatUSDFC(before.funds, 6)}`)
  console.log(`burn rate             : ${formatUSDFC(before.lockupRatePerEpoch, 12)} /epoch\n`)

  const depositAmount = parseUSDFC(process.env.DEPOSIT_USDFC ?? DEFAULT_DEPOSIT)

  if (usdfcWallet < depositAmount) {
    console.log(
      `Wallet holds ${formatUSDFC(usdfcWallet, 6)} USDFC but the plan deposits ` +
        `${formatUSDFC(depositAmount, 6)}.\n` +
        "Get tUSDFC: https://forest-explorer.chainsafe.dev/faucet/calibnet_usdfc\n" +
        "Or set DEPOSIT_USDFC to a smaller amount.",
    )
    if (apply) return
  }

  console.log("Plan:")
  console.log(`  1. deposit ${formatUSDFC(depositAmount, 6)} USDFC into Filecoin Pay`)
  console.log("  2. approve FWSS as operator (rate + lockup allowance)")

  if (!apply) {
    console.log("\nDry run. Re-run with --apply to execute.")
    return
  }

  // ---- Execute ------------------------------------------------------------
  const { getSynapse } = await import("@/lib/filecoin/synapse-client")
  const synapse = await getSynapse()

  console.log("\nDepositing…")
  const depositTx = await synapse.payments.deposit({
    amount: depositAmount,
    onAllowanceCheck: (current, required) =>
      console.log(`  ERC-20 allowance ${current} / needs ${required}`),
    onApprovalTransaction: (tx) => console.log(`  approval tx ${tx}`),
    onDepositStarting: () => console.log("  submitting deposit…"),
  })
  console.log(`  deposit tx ${depositTx}`)
  await readClient.waitForTransactionReceipt({ hash: depositTx })

  console.log("\nApproving FWSS as operator…")
  // Rate allowance caps ongoing spend per epoch; lockup caps what can be
  // reserved. Generous values so a demo does not stall on an allowance error.
  const approveTx = await synapse.payments.approveService({
    rateAllowance: depositAmount,
    lockupAllowance: depositAmount,
    maxLockupPeriod: 86_400n, // one "month" of epochs
  })
  console.log(`  approval tx ${approveTx}`)
  await readClient.waitForTransactionReceipt({ hash: approveTx })

  const after = await getAccountSummary(readClient, {
    address: account.address,
    token: chain.contracts.usdfc.address,
  })

  console.log("\nDone.")
  console.log(`USDFC in Filecoin Pay : ${formatUSDFC(after.funds, 6)}`)
  console.log(`available             : ${formatUSDFC(after.availableFunds, 6)}`)
  console.log("\nNext: upload a file (dashboard, or npm run upload:filecoin -- <path>)")
}

main().catch((error) => {
  console.error(`\nFAILED: ${error instanceof Error ? error.message : error}`)
  process.exit(1)
})
