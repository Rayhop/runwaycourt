"use client"

import { useState } from "react"
import { Loader2, LogIn, Wallet } from "lucide-react"

import { getBrowserClient } from "@/lib/supabase/client"

/**
 * Sign in with Google or an Ethereum wallet.
 *
 * Wallet sign-in uses Supabase's native EIP-4361 (Sign-In With Ethereum)
 * support, so there is no custom nonce endpoint to secure -- the wallet signs a
 * statement and Supabase verifies it.
 */

export function SignIn() {
  const [busy, setBusy] = useState<"google" | "wallet" | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function withGoogle() {
    const supabase = getBrowserClient()
    if (!supabase) return setError("Supabase is not configured.")

    setBusy("google")
    setError(null)

    const { error: cause } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: `${window.location.origin}/auth/callback` },
    })

    if (cause) {
      setError(cause.message)
      setBusy(null)
    }
    // On success the browser navigates away; leave the spinner running.
  }

  async function withWallet() {
    const supabase = getBrowserClient()
    if (!supabase) return setError("Supabase is not configured.")

    if (!(window as { ethereum?: unknown }).ethereum) {
      return setError("No Ethereum wallet found. Install MetaMask or similar, then retry.")
    }

    setBusy("wallet")
    setError(null)

    try {
      const { error: cause } = await supabase.auth.signInWithWeb3({
        chain: "ethereum",
        statement:
          "Sign in to RunwayCourt. This proves you control this wallet. " +
          "It does not authorise any spending.",
      })

      if (cause) throw new Error(cause.message)
      window.location.reload()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Wallet sign-in failed.")
      setBusy(null)
    }
  }

  return (
    <section className="rounded-xl border border-white/10 bg-black/60 p-8 backdrop-blur-sm">
      <h2 className="text-lg font-medium text-white/90">Sign in</h2>
      <p className="mt-2 max-w-prose text-sm leading-relaxed text-white/50">
        Each account gets its own court: its own storage inventory, its own runway, and its
        own Case Log. Sign in with a wallet if you want the agent to manage data you
        actually own on Filecoin.
      </p>

      <div className="mt-5 flex flex-wrap gap-3">
        <button
          type="button"
          onClick={withWallet}
          disabled={busy !== null}
          className="flex items-center gap-2 rounded-lg border border-white/20 bg-white/5 px-4 py-2.5 text-sm font-medium text-white/90 transition-colors hover:border-white/40 hover:bg-white/10 disabled:opacity-40"
        >
          {busy === "wallet" ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Wallet className="h-4 w-4" />
          )}
          Continue with wallet
        </button>

        <button
          type="button"
          onClick={withGoogle}
          disabled={busy !== null}
          className="flex items-center gap-2 rounded-lg border border-white/15 px-4 py-2.5 text-sm font-medium text-white/70 transition-colors hover:border-white/30 hover:text-white/90 disabled:opacity-40"
        >
          {busy === "google" ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <LogIn className="h-4 w-4" />
          )}
          Continue with Google
        </button>
      </div>

      <p className="mt-4 text-xs leading-relaxed text-white/35">
        Signing in with Google lets you watch a simulated court. Only a wallet can link real
        Filecoin storage — and even then the agent never holds your key.
      </p>

      {error ? (
        <div className="mt-4 rounded-lg border border-red-400/30 bg-red-400/10 px-3 py-2 text-xs text-red-200">
          {error}
        </div>
      ) : null}
    </section>
  )
}
