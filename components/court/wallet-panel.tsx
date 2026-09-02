"use client"

import { useCallback, useEffect, useState } from "react"
import { Link2, Loader2, Wallet } from "lucide-react"

import { linkMessage } from "@/lib/filecoin/wallet-link"

/**
 * Link an EVM wallet to the signed-in account.
 *
 * Signing in and owning a wallet are separate things: a Google user has no
 * wallet, and a Web3 sign-in does not necessarily tell the server which address
 * to watch. This asks the browser wallet to sign a message naming the user, and
 * the server recovers the address from the signature -- so the link is proved,
 * not merely claimed.
 */

export function WalletPanel({
  userId,
  onLinked,
}: {
  userId: string
  onLinked: () => void
}) {
  const [walletAddress, setWalletAddress] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/account/wallet", { cache: "no-store" })
      if (!response.ok) return
      setWalletAddress((await response.json())?.walletAddress ?? null)
    } catch {
      // Non-fatal.
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function link() {
    setBusy(true)
    setError(null)

    try {
      const ethereum = (window as { ethereum?: any }).ethereum
      if (!ethereum) {
        throw new Error("No Ethereum wallet in this browser. Install MetaMask, then retry.")
      }

      const accounts = (await ethereum.request({ method: "eth_requestAccounts" })) as string[]
      const address = accounts?.[0]
      if (!address) throw new Error("Wallet returned no account.")

      const issuedAt = new Date().toISOString()
      const signature = (await ethereum.request({
        method: "personal_sign",
        params: [linkMessage(userId, address, issuedAt), address],
      })) as string

      const response = await fetch("/api/account/wallet", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address, signature, issuedAt }),
      })

      const json = await response.json()
      if (!response.ok) throw new Error(json?.message ?? "Linking failed.")

      setWalletAddress(json.walletAddress)
      onLinked()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Linking failed.")
    } finally {
      setBusy(false)
    }
  }

  if (walletAddress) {
    return (
      <section className="rounded-xl border border-white/10 bg-black/50 px-5 py-3 backdrop-blur-sm">
        <div className="flex flex-wrap items-center gap-2 text-xs text-white/40">
          <Wallet className="h-3.5 w-3.5" />
          <span className="uppercase tracking-wider">Wallet</span>
          <span className="font-mono text-white/70">{walletAddress}</span>
          <button
            type="button"
            onClick={link}
            disabled={busy}
            className="ml-auto rounded border border-white/15 px-2 py-1 text-[10px] text-white/50 transition-colors hover:border-white/30 hover:text-white/80 disabled:opacity-40"
          >
            {busy ? "…" : "change"}
          </button>
        </div>
        {error ? <p className="mt-2 text-xs text-red-300">{error}</p> : null}
      </section>
    )
  }

  return (
    <section className="rounded-xl border border-amber-400/25 bg-amber-400/5 p-5 backdrop-blur-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium uppercase tracking-wider text-amber-200">
            Link a wallet
          </h2>
          <p className="mt-1.5 max-w-prose text-xs leading-relaxed text-white/50">
            The court reads runway from the Filecoin Pay account belonging to your wallet.
            Until one is linked there is no account to watch. Signing proves you control the
            address — it authorises no spending.
          </p>
        </div>

        <button
          type="button"
          onClick={link}
          disabled={busy}
          className="flex shrink-0 items-center gap-2 rounded-lg border border-white/20 bg-white/5 px-3 py-2 text-sm font-medium text-white/90 transition-colors hover:border-white/40 hover:bg-white/10 disabled:opacity-40"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4" />}
          Connect wallet
        </button>
      </div>

      {error ? (
        <div className="mt-3 rounded-lg border border-red-400/30 bg-red-400/10 px-3 py-2 text-xs text-red-200">
          {error}
        </div>
      ) : null}
    </section>
  )
}
