import "server-only"

import { getScope } from "@/lib/court/scope"
import { getServiceClient } from "@/lib/supabase/server"
import type { FilePriority, UploadJobRow, UploadJobState } from "@/lib/supabase/types"
import { ESSENTIAL_UPLOAD_PERMISSIONS } from "./session-key"
import { DelegationInactiveError, WalletNotLinkedError, getSynapse } from "./synapse-client"

/**
 * Store a file on Filecoin Warm Storage and enrol it in the court.
 *
 * This is the step that makes everything else real: the upload opens a PDP rail
 * against the account, which is what the runway is actually being spent on and
 * what a DROP verdict later terminates.
 *
 * It is split in two because it is SLOW -- around 80 seconds end to end, which
 * no serverless request may take:
 *
 *   startUpload()    push the bytes to the provider and submit the commit.
 *                    Seconds, because it never waits for the chain.
 *   advanceUpload()  ask the provider whether the commit confirmed yet, and
 *                    enrol the file once it has. One cheap HTTP call.
 *
 * The caller polls advanceUpload() until the job is done. Between calls the
 * only state that matters -- the provider's status URL -- is in upload_jobs, so
 * a commit survives the request that started it ending.
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

export interface UploadProgress {
  jobId: string
  state: UploadJobState
  name: string
  sizeBytes: number
  pieceCid: string | null
  dataSetId: string | null
  provider: string | null
  txHash: string | null
  error: string | null
  /** Present only once state is "done". */
  outcome: UploadOutcome | null
}

/** Raised when a job id does not belong to the caller. */
export class UploadJobNotFoundError extends Error {
  constructor() {
    super("No such upload in your court.")
    this.name = "UploadJobNotFoundError"
  }
}

function progressFrom(job: UploadJobRow, outcome: UploadOutcome | null = null): UploadProgress {
  return {
    jobId: job.id,
    state: job.state,
    name: job.name,
    sizeBytes: job.size_bytes,
    pieceCid: job.piece_cid,
    dataSetId: job.data_set_id,
    provider: job.provider,
    txHash: job.tx_hash,
    error: job.error,
    outcome,
  }
}

/**
 * Check the delegation before doing any work.
 *
 * Failing here says what to fix. Failing on chain says InsufficientLockupFunds
 * against an address the user has never seen.
 */
async function requireStorageAuthority(userId: string): Promise<string> {
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

  return scope.walletAddress
}

/**
 * Push the bytes and submit the commit, without waiting for the chain.
 *
 * Returns as soon as the provider has accepted the commit and handed back a
 * status URL. The data set does not exist yet at this point.
 */
export async function startUpload(params: {
  userId: string
  name: string
  data: Uint8Array
  priority?: FilePriority
}): Promise<UploadProgress> {
  const { userId, name, data, priority = "normal" } = params

  const walletAddress = await requireStorageAuthority(userId)
  const supabase = getServiceClient()

  const { data: created, error: createError } = await supabase
    .from("upload_jobs")
    .insert({
      user_id: userId,
      name,
      priority,
      size_bytes: data.length,
      state: "committing",
    })
    .select("*")
    .single()

  if (createError) throw new Error(`Could not record the upload: ${createError.message}`)
  const job = created as UploadJobRow

  try {
    const synapse = await getSynapse({
      userId,
      walletAddress,
      permissions: ESSENTIAL_UPLOAD_PERMISSIONS,
    })

    const [SP, chains] = await Promise.all([
      import("@filoz/synapse-core/sp"),
      import("@filoz/synapse-core/chains"),
    ])
    const network = process.env.FILECOIN_NETWORK ?? "calibration"
    const chain = network === "mainnet" ? chains.mainnet : chains.calibration

    // A context picks the provider and, if the account already has one, the
    // data set to add to.
    const context = await synapse.storage.createContext()
    const serviceURL = context.provider.pdp.serviceURL

    // 1. Bytes to the provider. Nothing on chain yet.
    const stored = await context.store(data)
    const pieceCid = stored.pieceCid

    // 2. Sign the commit. presignForCommit() picks the right payload for a new
    //    data set versus an existing one, and the clientDataSetId it chose is
    //    inside the signature -- which is why the submit below only forwards
    //    extraData rather than rebuilding the request.
    const extraData = await context.presignForCommit([{ pieceCid }])

    // 3. Submit, and stop. The *ApiRequest functions are the submit half of
    //    context.commit(); the half that blocks for a minute is the wait that
    //    follows them, which advanceUpload() does one poll at a time instead.
    const existingDataSetId = context.dataSetId
    const submitted = existingDataSetId
      ? await SP.addPiecesApiRequest({
          serviceURL,
          dataSetId: existingDataSetId,
          pieces: [pieceCid],
          extraData,
        })
      : await SP.createDataSetAndAddPiecesApiRequest({
          serviceURL,
          recordKeeper: chain.contracts.fwss.address,
          extraData,
          pieces: [pieceCid],
        })

    const { data: updated, error: updateError } = await supabase
      .from("upload_jobs")
      .update({
        state: "confirming",
        piece_cid: pieceCid.toString(),
        provider: context.provider.serviceProvider,
        service_url: serviceURL,
        status_url: submitted.statusUrl,
        tx_hash: submitted.txHash,
        data_set_id: existingDataSetId ? existingDataSetId.toString() : null,
        added_to_existing: Boolean(existingDataSetId),
        size_bytes: stored.size,
        updated_at: new Date().toISOString(),
      })
      .eq("id", job.id)
      .select("*")
      .single()

    if (updateError) throw new Error(updateError.message)
    return progressFrom(updated as UploadJobRow)
  } catch (error) {
    await fail(job.id, error)
    throw error
  }
}

/**
 * Advance a job by one step.
 *
 * Safe to call repeatedly: a job already done or failed is returned as-is.
 */
export async function advanceUpload(params: {
  userId: string
  jobId: string
}): Promise<UploadProgress> {
  const { userId, jobId } = params
  const supabase = getServiceClient()

  // Ownership check: the service client bypasses RLS, so this is the only thing
  // stopping one user driving another's upload.
  const { data, error } = await supabase
    .from("upload_jobs")
    .select("*")
    .eq("id", jobId)
    .eq("user_id", userId)
    .maybeSingle()

  if (error) throw new Error(`Could not read the upload: ${error.message}`)
  if (!data) throw new UploadJobNotFoundError()

  const job = data as UploadJobRow

  if (job.state === "done") return progressFrom(job, await outcomeFor(job))
  if (job.state === "failed") return progressFrom(job)
  if (job.state === "committing" || !job.status_url) {
    // Still inside startUpload's request, or it died before recording a status
    // URL. Either way there is nothing to poll yet.
    return progressFrom(job)
  }

  try {
    const confirmed = await checkCommit(job)
    if (!confirmed) return progressFrom(job)

    return await enrol(job, confirmed)
  } catch (error) {
    await fail(job.id, error)
    const { data: failed } = await supabase
      .from("upload_jobs")
      .select("*")
      .eq("id", job.id)
      .single()
    return progressFrom(failed as UploadJobRow)
  }
}

interface Confirmation {
  dataSetId: bigint
  txHash: string
}

interface ProviderStatus {
  txStatus?: string
  dataSetCreated?: boolean
  piecesAdded?: boolean
  dataSetId?: number | string
  createMessageHash?: string
  txHash?: string
  confirmedTxHash?: string
}

/**
 * One status request, no polling.
 *
 * The SDK's waitFor* helpers loop until the chain confirms, which is exactly
 * the minute-long block this split exists to avoid -- so read the same
 * endpoints directly and return null while it is still pending.
 */
async function checkCommit(job: UploadJobRow): Promise<Confirmation | null> {
  const statusUrl = job.status_url as string

  if (job.added_to_existing) {
    const body = await getJson(statusUrl)
    if (body.txStatus === "rejected") {
      throw new Error("The storage provider's add-pieces transaction was rejected on chain.")
    }
    if (body.piecesAdded !== true) return null
    return {
      dataSetId: BigInt(body.dataSetId as number),
      txHash: body.confirmedTxHash ?? body.txHash ?? (job.tx_hash as string),
    }
  }

  const created = await getJson(statusUrl)
  if (created.txStatus === "rejected") {
    throw new Error("The storage provider's create-data-set transaction was rejected on chain.")
  }
  if (created.dataSetCreated !== true) return null

  // The set exists; its pieces are confirmed separately, on a URL derived from
  // the create message hash.
  const origin = new URL(statusUrl).origin
  const piecesUrl = new URL(
    `/pdp/data-sets/${created.dataSetId}/pieces/added/${created.createMessageHash}`,
    origin,
  ).toString()

  const added = await getJson(piecesUrl)
  if (added.txStatus === "rejected") {
    throw new Error("The storage provider's add-pieces transaction was rejected on chain.")
  }
  if (added.piecesAdded !== true) return null

  return {
    dataSetId: BigInt(created.dataSetId as number),
    txHash:
      created.confirmedTxHash ??
      added.confirmedTxHash ??
      (created.createMessageHash as string),
  }
}

async function getJson(url: string): Promise<ProviderStatus> {
  // 202 means "still processing" here, not an error.
  const response = await fetch(url, { cache: "no-store" })
  if (!response.ok && response.status !== 202) {
    throw new Error(`Storage provider returned ${response.status} for ${url}`)
  }
  return (await response.json()) as ProviderStatus
}

/** Price the file at what Filecoin Pay is really charging, then enter it. */
async function enrol(job: UploadJobRow, confirmed: Confirmation): Promise<UploadProgress> {
  const supabase = getServiceClient()
  const scope = await getScope(job.user_id)

  const synapse = await getSynapse({
    userId: job.user_id,
    walletAddress: scope.walletAddress as string,
    permissions: ESSENTIAL_UPLOAD_PERMISSIONS,
  })

  const sets = await synapse.storage.findDataSets()
  const dataSet = sets.find((candidate) => candidate.dataSetId === confirmed.dataSetId) ?? null

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

  const now = new Date().toISOString()
  const { data: row, error } = await supabase
    .from("files")
    .insert({
      user_id: job.user_id,
      name: job.name,
      piece_cid: job.piece_cid,
      size_bytes: job.size_bytes,
      cost_per_epoch: costPerEpoch.toString(),
      tier: "warm",
      priority: job.priority,
      status: "active",
      last_accessed_at: now,
      data_set_id: confirmed.dataSetId.toString(),
      pdp_rail_id: dataSet ? dataSet.pdpRailId.toString() : null,
      cdn_rail_id: dataSet ? dataSet.cdnRailId.toString() : null,
      provider: dataSet ? dataSet.serviceProvider : job.provider,
      synced_at: now,
    })
    .select("id")
    .single()

  if (error) throw new Error(`Stored on Filecoin but failed to enrol: ${error.message}`)

  const fileId = (row as { id: string }).id
  const { data: finished, error: finishError } = await supabase
    .from("upload_jobs")
    .update({
      state: "done",
      file_id: fileId,
      data_set_id: confirmed.dataSetId.toString(),
      tx_hash: confirmed.txHash,
      updated_at: now,
    })
    .eq("id", job.id)
    .select("*")
    .single()

  if (finishError) throw new Error(finishError.message)

  const done = finished as UploadJobRow
  return progressFrom(done, {
    fileId,
    name: done.name,
    pieceCid: done.piece_cid ?? "",
    sizeBytes: done.size_bytes,
    dataSetId: confirmed.dataSetId.toString(),
    pdpRailId: dataSet ? dataSet.pdpRailId.toString() : null,
    costPerEpoch: costPerEpoch.toString(),
    provider: dataSet ? dataSet.serviceProvider : job.provider,
  })
}

/** Rebuild the outcome for an already-finished job, so a late poll still gets it. */
async function outcomeFor(job: UploadJobRow): Promise<UploadOutcome | null> {
  if (!job.file_id) return null

  const supabase = getServiceClient()
  const { data } = await supabase
    .from("files")
    .select("id, name, piece_cid, size_bytes, cost_per_epoch, data_set_id, pdp_rail_id, provider")
    .eq("id", job.file_id)
    .maybeSingle()

  if (!data) return null
  const file = data as Record<string, unknown>

  return {
    fileId: file.id as string,
    name: file.name as string,
    pieceCid: (file.piece_cid as string | null) ?? "",
    sizeBytes: Number(file.size_bytes),
    dataSetId: file.data_set_id as string | null,
    pdpRailId: file.pdp_rail_id as string | null,
    costPerEpoch: String(file.cost_per_epoch),
    provider: file.provider as string | null,
  }
}

async function fail(jobId: string, error: unknown) {
  const message = error instanceof Error ? error.message : "Upload failed."
  await getServiceClient()
    .from("upload_jobs")
    .update({ state: "failed", error: message, updated_at: new Date().toISOString() })
    .eq("id", jobId)
}

/**
 * Start an upload and block until it finishes.
 *
 * For the CLI, which has no request timeout to respect. The dashboard must not
 * use this -- that is the whole point of the split above.
 */
export async function uploadAndEnrol(params: {
  userId: string
  name: string
  data: Uint8Array
  priority?: FilePriority
  pollIntervalMs?: number
  timeoutMs?: number
}): Promise<UploadOutcome> {
  const { pollIntervalMs = 5_000, timeoutMs = 10 * 60_000 } = params
  const started = await startUpload(params)

  const deadline = Date.now() + timeoutMs
  let progress = started

  while (progress.state !== "done" && progress.state !== "failed") {
    if (Date.now() > deadline) throw new Error("Timed out waiting for the commit to confirm.")
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
    progress = await advanceUpload({ userId: params.userId, jobId: started.jobId })
  }

  if (progress.state === "failed" || !progress.outcome) {
    throw new Error(progress.error ?? "Upload failed.")
  }
  return progress.outcome
}
