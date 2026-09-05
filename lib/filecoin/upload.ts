import "server-only"

import { getScope } from "@/lib/court/scope"
import { getServiceClient } from "@/lib/supabase/server"
import type { FilePriority } from "@/lib/supabase/types"
import { ESSENTIAL_UPLOAD_PERMISSIONS } from "./session-key"
import { DelegationInactiveError, WalletNotLinkedError, getSynapse } from "./synapse-client"

/**
 * Store a file on Filecoin Warm Storage and enrol it in the court.
 *
 * This is the step that makes everything else real: the upload opens a PDP rail
 * against the account, which is what the runway is actually being spent on and
 * what a DROP verdict later terminates.
 *
 * The Supabase row records the resulting data_set_id, so the court can act on
 * it, and prices the file at the rail's real per-epoch rate.
 */

export interface UploadOutcome {
  fileId: string
  name: string
  pieceCid: string
  sizeBytes: number
  dataSetId: string | null
  pdpRailId: string | null
  costPerEpoch: string
  provider: string | null
}

export async function uploadAndEnrol(params: {
  userId: string
  name: string
  data: Uint8Array
  priority?: FilePriority
}): Promise<UploadOutcome> {
  const { userId, name, data, priority = "normal" } = params

  // Signed by this user's delegated key, but BILLED to their linked wallet --
  // the session key is a signer, never a funding source. Check both up front:
  // failing here says what to fix, where failing on chain says
  // InsufficientLockupFunds against an address the user has never seen.
  const scope = await getScope(userId)
  if (!scope.walletAddress) throw new WalletNotLinkedError()

  if (!scope.grant.active) {
    throw new DelegationInactiveError(
      scope.grant.expiresAt
        ? `The agent's authority expired on ${scope.grant.expiresAt.toISOString()}. ` +
          "Re-authorise it to store files."
        : "The agent has no authority to store files yet. Grant it from the dashboard.",
    )
  }

  const missing = ESSENTIAL_UPLOAD_PERMISSIONS.filter(
    (permission) => !scope.grant.permissions.includes(permission),
  )
  if (missing.length > 0) {
    throw new DelegationInactiveError(
      `The agent was not granted ${missing.join(" and ")}, so it cannot store files. ` +
        "Re-authorise it with the full set of court permissions.",
    )
  }

  const synapse = await getSynapse({
    userId,
    walletAddress: scope.walletAddress,
    permissions: ESSENTIAL_UPLOAD_PERMISSIONS,
  })

  // 1. Store it. This creates or reuses a data set and opens the rails.
  const result = await synapse.storage.upload(data)
  const pieceCid = result.pieceCid.toString()

  // 2. Find the data set the piece landed in. upload() does not return the id,
  //    so match against the account's sets -- the newest is the one just used
  //    when a fresh context was created, and an existing one otherwise.
  const sets = await synapse.storage.findDataSets()
  const dataSet =
    sets.length > 0
      ? sets.reduce((newest, candidate) =>
          candidate.dataSetId > newest.dataSetId ? candidate : newest,
        )
      : null

  // 3. Price it at what Filecoin Pay is really charging for those rails.
  let costPerEpoch = 0n
  if (dataSet) {
    const { getRail } = await import("@filoz/synapse-core/pay")
    const railIds = [dataSet.pdpRailId, dataSet.cdnRailId, dataSet.cacheMissRailId].filter(
      (id) => id > 0n,
    )

    for (const railId of railIds) {
      try {
        const rail = await getRail(synapse.readClient, { railId })
        costPerEpoch += rail.paymentRate
      } catch {
        // Rail not settleable yet; contributes nothing until it is.
      }
    }
  }

  // 4. Enrol it as a defendant.
  const supabase = getServiceClient()
  const now = new Date().toISOString()

  const { data: row, error } = await supabase
    .from("files")
    .insert({
      user_id: userId,
      name,
      piece_cid: pieceCid,
      size_bytes: result.size,
      cost_per_epoch: costPerEpoch.toString(),
      tier: "warm",
      priority,
      status: "active",
      last_accessed_at: now,
      data_set_id: dataSet ? dataSet.dataSetId.toString() : null,
      pdp_rail_id: dataSet ? dataSet.pdpRailId.toString() : null,
      cdn_rail_id: dataSet ? dataSet.cdnRailId.toString() : null,
      provider: dataSet ? dataSet.serviceProvider : null,
      synced_at: now,
    })
    .select("id")
    .single()

  if (error) throw new Error(`Stored on Filecoin but failed to enrol: ${error.message}`)

  return {
    fileId: (row as { id: string }).id,
    name,
    pieceCid,
    sizeBytes: result.size,
    dataSetId: dataSet ? dataSet.dataSetId.toString() : null,
    pdpRailId: dataSet ? dataSet.pdpRailId.toString() : null,
    costPerEpoch: costPerEpoch.toString(),
    provider: dataSet ? dataSet.serviceProvider : null,
  }
}
