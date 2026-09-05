import { NextResponse } from "next/server"

import { getConfiguredKind } from "@/lib/filecoin"
import {
  DelegationInactiveError,
  SignerOutOfGasError,
  WalletNotLinkedError,
  hasDelegationSecret,
} from "@/lib/filecoin/synapse-client"
import { uploadAndEnrol } from "@/lib/filecoin/upload"
import type { FilePriority } from "@/lib/supabase/types"
import { getCurrentUser } from "@/lib/supabase/auth"
import { isServerSupabaseConfigured } from "@/lib/supabase/server"

/**
 * Store a file on Filecoin Warm Storage and put it on trial.
 *
 * POST multipart/form-data: file=<blob>, priority=critical|normal|archive|junk
 *
 * This is the judge-facing path: drop a file in the dashboard, watch it get a
 * real piece CID and data set, then watch the court decide whether to keep
 * paying for it.
 */

export const dynamic = "force-dynamic"
// Storing to a provider and waiting for the data set takes a while, so ask for
// the longest run this plan allows. 60s is the Hobby ceiling -- Vercel REJECTS a
// deployment that requests more than the plan permits, so raise this to 300 only
// once you are on Pro. Large uploads may time out at 60s.
export const maxDuration = 60

const PRIORITIES: FilePriority[] = ["critical", "normal", "archive", "junk"]

/** Providers reject very small pieces; keep the UI honest about the floor. */
const MIN_BYTES = 127
const MAX_BYTES = 32 * 1024 * 1024

export async function POST(request: Request) {
  if (!isServerSupabaseConfigured()) {
    return NextResponse.json(
      { error: "supabase_not_configured", message: "Set Supabase env vars -- see .env.example." },
      { status: 503 },
    )
  }

  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json(
      { error: "unauthenticated", message: "Sign in to store files." },
      { status: 401 },
    )
  }

  if (getConfiguredKind() !== "synapse") {
    return NextResponse.json(
      {
        error: "simulator_mode",
        message:
          "Uploads need RUNWAYCOURT_CHAIN=synapse. In simulator mode there is no " +
          "chain to store to.",
      },
      { status: 409 },
    )
  }

  // Uploads are signed by the user's delegated session key, so what the server
  // needs is the secret it derives that key from -- not its own wallet.
  if (!hasDelegationSecret()) {
    return NextResponse.json(
      {
        error: "no_delegation_secret",
        message:
          "RUNWAYCOURT_SESSION_SECRET is not set, so no agent signer can be " +
          "derived and nothing can be stored.",
      },
      { status: 409 },
    )
  }

  let form: FormData
  try {
    form = await request.formData()
  } catch {
    return NextResponse.json(
      { error: "bad_request", message: "Expected multipart/form-data." },
      { status: 400 },
    )
  }

  const file = form.get("file")
  if (!(file instanceof File)) {
    return NextResponse.json(
      { error: "bad_request", message: "No file provided." },
      { status: 400 },
    )
  }

  if (file.size < MIN_BYTES) {
    return NextResponse.json(
      {
        error: "too_small",
        message: `File is ${file.size} bytes; storage providers need at least ${MIN_BYTES}.`,
      },
      { status: 400 },
    )
  }

  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      {
        error: "too_large",
        message: `File is ${file.size} bytes; this demo caps uploads at ${MAX_BYTES}.`,
      },
      { status: 400 },
    )
  }

  const rawPriority = form.get("priority")
  const priority = PRIORITIES.includes(rawPriority as FilePriority)
    ? (rawPriority as FilePriority)
    : "normal"

  try {
    const outcome = await uploadAndEnrol({
      userId: user.id,
      name: file.name || "upload.bin",
      data: new Uint8Array(await file.arrayBuffer()),
      priority,
    })

    return NextResponse.json(outcome)
  } catch (error) {
    // Both mean "you have not finished setting up", not "the upload broke".
    if (error instanceof WalletNotLinkedError) {
      return NextResponse.json({ error: "no_wallet", message: error.message }, { status: 409 })
    }
    if (error instanceof DelegationInactiveError) {
      return NextResponse.json(
        { error: "delegation_inactive", message: error.message },
        { status: 409 },
      )
    }
    if (error instanceof SignerOutOfGasError) {
      return NextResponse.json(
        { error: "signer_out_of_gas", message: error.message },
        { status: 409 },
      )
    }

    const message = error instanceof Error ? error.message : "Upload failed."

    // The most common first-run failure is a payer that was never funded.
    // Name the payer: it is the LINKED WALLET, so pointing at setup:filecoin
    // only helps when that wallet happens to be FILECOIN_PRIVATE_KEY's.
    const hint = /allowance|insufficient|approve|lockup/i.test(message)
      ? " Filecoin Pay bills your linked wallet, which has no USDFC deposited " +
        "or has not approved FWSS. Deposit and approve from that wallet -- or, " +
        "if it is the same wallet as FILECOIN_PRIVATE_KEY, run " +
        "`npm run setup:filecoin -- --apply`."
      : ""

    return NextResponse.json(
      { error: "upload_failed", message: message + hint },
      { status: 500 },
    )
  }
}
