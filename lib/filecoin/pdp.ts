import "server-only"

/**
 * Proof of Data Possession status.
 *
 * A storage provider must periodically prove it still holds your pieces. A data
 * set that stops being proven is one you are paying for but may no longer be
 * able to retrieve -- which is the strongest possible reason for the court to
 * stop funding it.
 *
 * Verified live against Calibration: data set 12130 returns
 * live=true, 25 active pieces, nextChallenge=4024423, deadline=4024443.
 */

export interface ProofStatus {
  dataSetId: string
  /** False once the set has been terminated or removed. */
  live: boolean
  activePieces: number
  nextChallengeEpoch: number | null
  provingDeadline: number | null
  provenThisPeriod: boolean
  /**
   * Live, unproven, and past its deadline. The provider has missed a proof --
   * you are paying for storage nobody has attested to recently.
   */
  atRisk: boolean
}

/** Read proof status for several data sets at once. */
export async function getProofStatuses(
  readClient: any,
  dataSetIds: string[],
): Promise<Map<string, ProofStatus>> {
  const result = new Map<string, ProofStatus>()
  if (dataSetIds.length === 0) return result

  const [{ dataSetLive, getNextChallengeEpoch, getActivePieceCount }, chains] = await Promise.all([
    import("@filoz/synapse-core/pdp-verifier"),
    import("@filoz/synapse-core/chains"),
  ])

  const network = process.env.FILECOIN_NETWORK ?? "calibration"
  const chain = network === "mainnet" ? chains.mainnet : chains.calibration

  const head = Number(await readClient.getBlockNumber())

  await Promise.all(
    dataSetIds.map(async (raw) => {
      const dataSetId = BigInt(raw)

      // Each read is independently tolerant: a terminated set reverts on some
      // calls but not others, and a partial reading is still worth showing.
      const safe = async <T>(fn: () => Promise<T>, fallback: T): Promise<T> => {
        try {
          return await fn()
        } catch {
          return fallback
        }
      }

      const [live, pieces, nextChallenge, deadline, proven] = await Promise.all([
        safe(() => dataSetLive(readClient, { dataSetId }), false),
        safe(async () => Number(await getActivePieceCount(readClient, { dataSetId })), 0),
        safe(async () => Number(await getNextChallengeEpoch(readClient, { dataSetId })), null),
        safe(
          async () =>
            Number(
              await readClient.readContract({
                address: chain.contracts.fwssView.address,
                abi: chain.contracts.fwssView.abi,
                functionName: "provingDeadline",
                args: [dataSetId],
              }),
            ),
          null,
        ),
        safe(
          async () =>
            Boolean(
              await readClient.readContract({
                address: chain.contracts.fwssView.address,
                abi: chain.contracts.fwssView.abi,
                functionName: "provenThisPeriod",
                args: [dataSetId],
              }),
            ),
          false,
        ),
      ])

      result.set(raw, {
        dataSetId: raw,
        live: Boolean(live),
        activePieces: pieces,
        nextChallengeEpoch: nextChallenge,
        provingDeadline: deadline,
        provenThisPeriod: proven,
        // Only a MISSED deadline is a problem. Being unproven before the
        // deadline is the normal state for most of every proving period.
        atRisk: Boolean(live) && !proven && deadline !== null && head > deadline,
      })
    }),
  )

  return result
}
