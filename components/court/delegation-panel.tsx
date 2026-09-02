"use client"

import { useCallback, useEffect, useState } from "react"
import { KeyRound, Loader2, ShieldCheck, ShieldOff } from "lucide-react"

/**
 * The leash.
 *
 * The user's wallet authorises an agent-controlled signer for named permissions
 * until an expiry, by calling the session key registry directly. The server
 * only records the result -- it cannot grant itself authority, which is what
 * makes it safe to let the court spend money unattended.
 */

interface Delegation {
  walletAddress: string | null
  signerAddress: string | null
  unavailable: string | null
  permissions: string[]
  defaultGrantDays: number
  grant: {
    address: string | null
    expiresAt: string | null
    permissions: string[]
    active: boolean
  }
}

function short(address: string | null): string {
  if (!address) return "—"
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}

export function DelegationPanel({ onChanged }: { onChanged: () => void }) {
  const [state, setState] = useState<Delegation | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/account/delegation", { cache: "no-store" })
      if (!response.ok) return
      setState((await response.json()) as Delegation)
    } catch {
      // Non-fatal: the panel just stays empty.
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function grant() {
    if (!state?.signerAddress) return

    setBusy(true)
    setError(null)

    try {
      const ethereum = (window as { ethereum?: any }).ethereum
      if (!ethereum) throw new Error("No wallet found in this browser.")

      const [from] = (await ethereum.request({ method: "eth_requestAccounts" })) as string[]

      const expiresAt = new Date(Date.now() + state.defaultGrantDays * 86_400_000)

      // Build the registry call client-side so the USER signs it.
      const [{ loginCall }, { calibration, mainnet }, permissionsMod] = await Promise.all([
        import("@filoz/synapse-core/session-key"),
        import("@filoz/synapse-core/chains"),
        import("@filoz/synapse-core/session-key"),
      ])

      const chainIdHex = (await ethereum.request({ method: "eth_chainId" })) as string
      const chain = Number(chainIdHex) === mainnet.id ? mainnet : calibration

      const permissions = [
        permissionsMod.TerminateServicePermission,
        permissionsMod.CreateDataSetPermission,
        permissionsMod.AddPiecesPermission,
        permissionsMod.SchedulePieceRemovalsPermission,
      ]

      const call = loginCall({
        chain,
        address: state.signerAddress as `0x${string}`,
        permissions,
        expiresAt: BigInt(Math.floor(expiresAt.getTime() / 1000)),
      })

      const { encodeFunctionData } = await import("viem")
      const data = encodeFunctionData({
        abi: call.abi,
        functionName: call.functionName,
        args: call.args,
      })

      const txHash = (await ethereum.request({
        method: "eth_sendTransaction",
        params: [{ from, to: call.address, data }],
      })) as string

      const response = await fetch("/api/account/delegation", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          txHash,
          expiresAt: expiresAt.toISOString(),
          walletAddress: from,
        }),
      })

      if (!response.ok) {
        throw new Error((await response.json())?.message ?? "Failed to record grant.")
      }

      await load()
      onChanged()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Delegation failed.")
    } finally {
      setBusy(false)
    }
  }

  async function revoke() {
    setBusy(true)
    try {
      await fetch("/api/account/delegation", { method: "DELETE" })
      await load()
      onChanged()
    } finally {
      setBusy(false)
    }
  }

  if (!state) return null

  const active = state.grant.active

  return (
    <section className="rounded-xl border border-white/10 bg-black/50 p-5 backdrop-blur-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            {active ? (
              <ShieldCheck className="h-4 w-4 text-emerald-400" />
            ) : (
              <ShieldOff className="h-4 w-4 text-white/40" />
            )}
            <h2 className="text-sm font-medium uppercase tracking-wider text-white/60">
              Agent authority
            </h2>
          </div>

          <p className="mt-1.5 max-w-prose text-xs leading-relaxed text-white/40">
            {active
              ? "The agent can stop paying for your data on your behalf, without asking. It cannot move funds or sign anything else."
              : "The agent has no authority yet. Until you grant it, verdicts are recorded but never settled onchain."}
          </p>

          <dl className="mt-2 space-y-0.5 font-mono text-[11px] text-white/40">
            <div>wallet : {short(state.walletAddress)}</div>
            <div>signer : {short(state.grant.address ?? state.signerAddress)}</div>
            <div>
              expires :{" "}
              {state.grant.expiresAt
                ? new Date(state.grant.expiresAt).toLocaleString()
                : "not granted"}
            </div>
          </dl>
        </div>

        <button
          type="button"
          onClick={active ? revoke : grant}
          disabled={busy || !state.signerAddress}
          className="flex shrink-0 items-center gap-2 rounded-lg border border-white/20 bg-white/5 px-3 py-2 text-sm font-medium text-white/90 transition-colors hover:border-white/40 hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
          {active ? "Forget grant" : `Grant for ${state.defaultGrantDays} days`}
        </button>
      </div>

      {state.unavailable ? (
        <div className="mt-3 rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-xs text-amber-200">
          Delegation unavailable: {state.unavailable}
        </div>
      ) : null}

      {error ? (
        <div className="mt-3 rounded-lg border border-red-400/30 bg-red-400/10 px-3 py-2 text-xs text-red-200">
          {error}
        </div>
      ) : null}
    </section>
  )
}
