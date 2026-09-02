import "server-only"

import { createClient, type SupabaseClient } from "@supabase/supabase-js"

/**
 * Server-side Supabase client using the service role key.
 *
 * This bypasses RLS, so it must never be imported into a client component --
 * the "server-only" import above turns that mistake into a build error.
 */

let cached: SupabaseClient | null = null

export class SupabaseNotConfiguredError extends Error {
  constructor() {
    super(
      "Supabase is not configured. Set NEXT_PUBLIC_SUPABASE_URL and " +
        "SUPABASE_SECRET_KEY (or SUPABASE_SERVICE_ROLE_KEY) in .env.local " +
        "-- see .env.example.",
    )
    this.name = "SupabaseNotConfiguredError"
  }
}

/**
 * Supabase renamed the privileged key from "service_role" to "secret"
 * (sb_secret_...). Both bypass RLS and both are accepted here.
 */
function readSecretKey(): string | undefined {
  return process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY
}

export function getServiceClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = readSecretKey()

  if (!url || !serviceKey) throw new SupabaseNotConfiguredError()

  if (!cached) {
    cached = createClient(url, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
  }
  return cached
}

export function isServerSupabaseConfigured(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && readSecretKey())
}
