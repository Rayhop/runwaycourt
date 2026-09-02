import "server-only"

import { cookies } from "next/headers"
import { createServerClient } from "@supabase/ssr"
import type { SupabaseClient, User } from "@supabase/supabase-js"

/**
 * Server-side auth: who is making this request.
 *
 * Uses the cookie-bound anon client, so it is subject to RLS and reflects the
 * signed-in user. Distinct from getServiceClient(), which bypasses RLS and must
 * only ever be used AFTER the caller's identity has been established here.
 */

function publishableKey(): string | undefined {
  return (
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  )
}

export async function createServerSupabase(): Promise<SupabaseClient | null> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = publishableKey()
  if (!url || !key) return null

  const store = await cookies()

  return createServerClient(url, key, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (list) => {
        try {
          for (const { name, value, options } of list) store.set(name, value, options)
        } catch {
          // Called from a Server Component, where cookies are read-only. The
          // middleware refreshes the session instead, so this is safe to skip.
        }
      },
    },
  })
}

/**
 * The signed-in user, or null.
 *
 * Always uses getUser() rather than getSession(): getSession reads the cookie
 * without verifying it, so it can be spoofed. getUser revalidates against the
 * auth server.
 */
export async function getCurrentUser(): Promise<User | null> {
  const supabase = await createServerSupabase()
  if (!supabase) return null

  const { data, error } = await supabase.auth.getUser()
  if (error) return null
  return data.user
}

/** Throws unless signed in. For API routes that must never run anonymously. */
export class UnauthenticatedError extends Error {
  constructor() {
    super("Sign in required.")
    this.name = "UnauthenticatedError"
  }
}

export async function requireUser(): Promise<User> {
  const user = await getCurrentUser()
  if (!user) throw new UnauthenticatedError()
  return user
}
