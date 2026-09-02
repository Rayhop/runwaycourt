import { createBrowserClient } from "@supabase/ssr"
import type { SupabaseClient } from "@supabase/supabase-js"

/**
 * Browser-side Supabase client.
 *
 * Uses @supabase/ssr's createBrowserClient, NOT supabase-js's createClient, and
 * the difference is load-bearing:
 *
 *   - It stores the session in COOKIES rather than localStorage, so the server
 *     can read it. With localStorage the browser is signed in but every Server
 *     Component and route handler still sees an anonymous request.
 *
 *   - It selects the PKCE flow, so OAuth comes back as `?code=...` which
 *     /auth/callback can exchange. The default implicit flow returns the token
 *     in the URL fragment, which never reaches the server at all -- the symptom
 *     is a callback that reports "missing_code".
 *
 * Writes are still governed by RLS: the publishable key grants SELECT on the
 * signed-in user's own rows and nothing more.
 */

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const publishableKey =
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

let cached: SupabaseClient | null = null

/** True when the browser has enough config to talk to Supabase. */
export function isSupabaseConfigured(): boolean {
  return Boolean(url && publishableKey)
}

/**
 * The shared browser client, or null when env vars are missing so the dashboard
 * can render a setup prompt instead of throwing on first paint.
 */
export function getBrowserClient(): SupabaseClient | null {
  if (!url || !publishableKey) return null
  if (!cached) cached = createBrowserClient(url, publishableKey)
  return cached
}
