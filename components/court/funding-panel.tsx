"use client"

import { useCallback, useEffect, useState } from "react"
import { CheckCircle2, Coins, Loader2, TriangleAlert } from "lucide-react"

import { formatUSDFC, parseUSDFC, perEpochToPerMonth } from "@/lib/epochs"
import { connect, getEthereum, requireChain, sendCall } from "@/lib/wallet"

/**
 * Fund the court.
 *
 * Filecoin Pay bills the user's OWN wallet, so storing anything needs two
 * things from them: USDFC deposited into the Pay contract, and FWSS approved as
 * an operator. Neither is something the agent can do on their behalf -- its
 * session key carries FWSS storage permissions and nothing that could move
 * tokens -- so all three transactions are signed here, by the user's wallet.
 *
 * That is the honest division of authority: the agent may commit you to
 * storage and later stop paying for it, but it can never spend your money.
 */

interface FundingPanelProps {
  onChanged: () => void
}

interface Funding {
  walletAddress: string | null
  walletBalance: string
  payAllowance: string
  deposited: string
  available: string
  lockupRatePerEpoch: string
  serviceApproved: boolean
  rateAllowance: string
  lockupAllowance: string
  maxLockupPeriod: string
  requiredLockupPeriod: string
  ready: boolean
  contracts: { usdfc: string; filecoinPay: string; fwss: string }
  chainId: number
}

const DEFAULT_DEPOSIT = "5"

function Row({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <span className="text-xs text-white/40">{label}</span>
      <span className="text-right">
        <span className="font-mono text-xs tabular-nums text-white/80">{value}</span>
        {hint ? <span className="ml-2 text-[11px] text-white/30">{hint}</span> : null}
      </span>
    </div>
  )
}

export function FundingPanel({ onChanged }: FundingPanelProps) {
  const [state, setState] = useState<Funding | null>(null)
  const [amount, setAmount] = useState(DEFAULT_DEPOSIT)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/account/funding")
      if (!response.ok) return
      setState((await response.json()) as Funding)
    } catch {
      // A funding read that fails must not take the dashboard down with it.
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  /**
   * Deposit, and approve FWSS if it is not already approved.
   *
   * Up to three transactions, each waited on: the ERC-20 approve is skipped
   * when the allowance already covers the amount, and the operator approval is
   * skipped when it is already good enough.
   */
  async function fund() {
    if (!state) return

    setBusy(true)
    setError(null)
    setDone(null)

    try {
      let value: bigint
      try {
        value = parseUSDFC(amount)
      } catch {
        throw new Error("Enter an amount in USDFC, for example 5.")
      }
      if (value <= 0n) throw new Error("Enter an amount greater than zero.")

      if (value > BigInt(state.walletBalance)) {
        throw new Error(
          `Your wallet holds ${formatUSDFC(BigInt(state.walletBalance), 4)} USDFC, ` +
            `which is less than ${formatUSDFC(value, 4)}.`,
        )
      }

      const ethereum = getEthereum()
      const from = await connect(ethereum)
      await requireChain(ethereum, state.chainId)

      const [chains, pay] = await Promise.all([
        import("@filoz/synapse-core/chains"),
        import("@filoz/synapse-core/pay"),
      ])
      const chain = state.chainId === chains.mainnet.id ? chains.mainnet : chains.calibration

      // 1. Let the Pay contract pull the tokens. Skipped when it already may.
      if (BigInt(state.payAllowance) < value) {
        setStatus("Approving USDFC for Filecoin Pay…")
        await sendCall(ethereum, from, {
          address: state.contracts.usdfc as `0x${string}`,
          abi: chain.contracts.usdfc.abi,
          functionName: "approve",
          args: [state.contracts.filecoinPay, value],
        })
      }

      // 2. Move the tokens in. A wallet balance is not spendable by Pay.
      setStatus(`Depositing ${formatUSDFC(value, 4)} USDFC…`)
      await sendCall(
        ethereum,
        from,
        pay.depositCall({ chain, to: from, amount: value }),
      )

      // 3. Authorise FWSS to charge against the deposit. Without this a commit
      //    reverts with InsufficientLockupFunds even though the money is there.
      const needsApproval =
        !state.serviceApproved ||
        BigInt(state.maxLockupPeriod) < BigInt(state.requiredLockupPeriod) ||
        BigInt(state.rateAllowance) === 0n ||
        BigInt(state.lockupAllowance) === 0n

      if (needsApproval) {
        setStatus("Approving Filecoin Warm Storage as an operator…")
        await sendCall(
          ethereum,
          from,
          pay.setOperatorApprovalCall({
            chain,
            approve: true,
            maxLockupPeriod: BigInt(state.requiredLockupPeriod),
          }),
        )
      }

      setDone(`Deposited ${formatUSDFC(value, 4)} USDFC.`)
      await load()
      onChanged()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Funding failed.")
    } finally {
      setBusy(false)
      setStatus(null)
    }
  }

  if (!state) return null

  if (!state.walletAddress) {
    return (
      <section className="rounded-xl border border-white/10 bg-black/50 p-5 backdrop-blur-sm">
        <h2 className="text-sm font-medium uppercase tracking-wider text-white/60">
          Storage funding
        </h2>
        <p className="mt-2 text-xs text-white/40">
          Link a wallet first. Filecoin Pay bills that wallet, so there is nothing to fund
          until the court knows which one.
        </p>
      </section>
    )
  }

  const burnPerMonth = perEpochToPerMonth(BigInt(state.lockupRatePerEpoch))

  return (
    <section className="rounded-xl border border-white/10 bg-black/50 p-5 backdrop-blur-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-medium uppercase tracking-wider text-white/60">
            <Coins className="h-3.5 w-3.5" />
            Storage funding
          </h2>
          <p className="mt-1 max-w-prose text-xs text-white/35">
            Filecoin Pay spends from your wallet, not the agent&apos;s. You deposit and
            approve; the agent can then commit you to storage — and stop paying for it —
            but never move your tokens.
          </p>
        </div>

        <span
          className={`rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wider ${
            state.ready
              ? "border-emerald-400/40 text-emerald-200"
              : "border-amber-400/40 text-amber-200"
          }`}
        >
          {state.ready ? "funded" : "needs funding"}
        </span>
      </div>

      <div className="mt-4 divide-y divide-white/5 rounded-lg border border-white/10 bg-white/[0.02] px-3 py-1">
        <Row label="In your wallet" value={`${formatUSDFC(BigInt(state.walletBalance), 4)} USDFC`} />
        <Row
          label="Deposited in Filecoin Pay"
          value={`${formatUSDFC(BigInt(state.deposited), 4)} USDFC`}
        />
        <Row
          label="Available to new rails"
          value={`${formatUSDFC(BigInt(state.available), 4)} USDFC`}
          hint="unreserved"
        />
        <Row
          label="Current burn"
          value={`${formatUSDFC(burnPerMonth, 4)} USDFC/mo`}
          hint={state.lockupRatePerEpoch === "0" ? "nothing stored yet" : undefined}
        />
        <Row
          label="Warm Storage approved"
          value={state.serviceApproved ? "yes" : "no"}
          hint={
            state.serviceApproved &&
            BigInt(state.maxLockupPeriod) < BigInt(state.requiredLockupPeriod)
              ? "lockup period too short"
              : undefined
          }
        />
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-2">
          <input
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            disabled={busy}
            inputMode="decimal"
            className="w-28 rounded-lg border border-white/15 bg-black/60 px-2 py-2 font-mono text-sm text-white/80 disabled:opacity-40"
          />
          <span className="text-xs text-white/40">USDFC</span>
        </div>

        <button
          type="button"
          onClick={() => void fund()}
          disabled={busy}
          className="flex items-center gap-2 rounded-lg border border-white/20 bg-white/5 px-3 py-2 text-sm font-medium text-white/90 transition-colors hover:border-white/40 hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Coins className="h-4 w-4" />}
          {busy ? "Signing…" : "Deposit"}
        </button>
      </div>

      {busy ? (
        <p className="mt-3 text-[11px] text-white/30">
          Up to three transactions: approve USDFC, deposit, then authorise Warm Storage.
          Each one waits to confirm before the next is sent.
        </p>
      ) : null}

      {status ? (
        <p className="mt-3 flex items-center gap-2 text-xs text-white/50">
          <Loader2 className="h-3 w-3 animate-spin" />
          {status}
        </p>
      ) : null}

      {!state.ready && !busy ? (
        <p className="mt-3 flex items-start gap-2 text-[11px] text-amber-200/70">
          <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" />
          Uploads will fail with an InsufficientLockupFunds error until this wallet has
          both a deposit and an approval.
        </p>
      ) : null}

      {error ? (
        <div className="mt-3 rounded-lg border border-red-400/30 bg-red-400/10 px-3 py-2 text-xs text-red-200">
          {error}
        </div>
      ) : null}

      {done ? (
        <div className="mt-3 flex items-center gap-2 rounded-lg border border-emerald-400/30 bg-emerald-400/10 px-3 py-2 text-xs text-emerald-100">
          <CheckCircle2 className="h-3.5 w-3.5" />
          {done}
        </div>
      ) : null}
    </section>
  )
}
