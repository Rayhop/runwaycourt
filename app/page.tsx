import { CourtBackground } from "@/components/court/court-background"
import { CourtDashboard } from "@/components/court/dashboard"
import { SignIn } from "@/components/court/sign-in"
import { getConfiguredKind } from "@/lib/filecoin"
import { hasDelegationSecret } from "@/lib/filecoin/synapse-client"
import { getCurrentUser } from "@/lib/supabase/auth"
import { isServerSupabaseConfigured } from "@/lib/supabase/server"

export const dynamic = "force-dynamic"

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ auth_error?: string }>
}) {
  const configured = isServerSupabaseConfigured()
  const chain = getConfiguredKind()
  const user = configured ? await getCurrentUser() : null
  const authError = (await searchParams)?.auth_error ?? null

  // Uploads are signed by a derived session key, so this is the server-side
  // prerequisite. Having a wallet linked is checked per-user, further in.
  const canUpload = chain === "synapse" && hasDelegationSecret()
  const identity =
    user?.user_metadata?.custom_claims?.address ??
    user?.email ??
    (user ? `${user.id.slice(0, 8)}…` : null)

  return (
    <main className="relative min-h-screen bg-black text-white">
      <CourtBackground />

      <div className="relative z-10 mx-auto max-w-7xl px-5 py-10 sm:px-8">
        <header className="mb-8 flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <h1 className="font-instrument-serif text-4xl tracking-tight sm:text-5xl">
                RunwayCourt
              </h1>
              <span className="rounded-full border border-white/15 px-2 py-0.5 text-[10px] uppercase tracking-wider text-white/50">
                {chain === "synapse" ? "Filecoin Calibration" : "simulator"}
              </span>
            </div>

            <p className="mt-2 max-w-2xl text-sm leading-relaxed text-white/50">
              An autonomous agent that reads its own Filecoin Pay runway and puts its stored
              data on trial to survive its storage budget.{" "}
              <span className="text-white/70">Where your data pleads its case to stay alive.</span>
            </p>
          </div>

          {user ? (
            <form action="/auth/signout" method="post" className="flex items-center gap-3">
              <span className="max-w-[16rem] truncate font-mono text-xs text-white/40">
                {identity}
              </span>
              <button
                type="submit"
                className="rounded-lg border border-white/15 px-3 py-1.5 text-xs text-white/60 transition-colors hover:border-white/30 hover:text-white/90"
              >
                Sign out
              </button>
            </form>
          ) : null}
        </header>

        {!configured ? (
          <section className="rounded-xl border border-amber-400/30 bg-amber-400/5 p-6 backdrop-blur-sm">
            <h2 className="text-sm font-medium uppercase tracking-wider text-amber-200">
              Setup needed
            </h2>
            <p className="mt-2 max-w-prose text-sm leading-relaxed text-white/70">
              RunwayCourt needs a Supabase project. Copy{" "}
              <code className="text-white/90">.env.example</code> to{" "}
              <code className="text-white/90">.env.local</code>, fill in your project URL and
              keys, then apply the migrations in{" "}
              <code className="text-white/90">supabase/migrations/</code>.
            </p>
          </section>
        ) : !user ? (
          <>
            {authError ? (
              <div className="mb-4 rounded-lg border border-red-400/30 bg-red-400/10 px-4 py-3 text-sm text-red-200">
                Sign-in failed: {authError}
              </div>
            ) : null}
            <SignIn />
          </>
        ) : (
          <CourtDashboard
            configured
            canUpload={canUpload}
            isWalletMode={chain === "synapse"}
            userId={user.id}
          />
        )}

        <footer className="mt-10 border-t border-white/10 pt-5 text-xs leading-relaxed text-white/30">
          Survival Score ={" "}
          <span className="font-mono text-white/50">
            access·hits₇d + recency·decay + priority·tag − cost·rate
          </span>
          . Files are ranked, funded top-down until the budget is spent, then downgraded to
          single-copy storage or dropped.
        </footer>
      </div>
    </main>
  )
}
