import "server-only"

/**
 * Reading a user's Filecoin Pay position.
 *
 * Filecoin Pay bills the user's own wallet, so before it can store anything
 * that wallet needs two things, and they are easy to confuse:
 *
 *   deposited  USDFC moved INTO the Pay contract. A wallet balance is not
 *              enough -- Pay can only spend what it holds.
 *   approved   FWSS authorised as an operator, with a rate allowance (how fast
 *              it may charge) and a lockup allowance (how much it may reserve
 *              up front). Without this, a commit reverts with
 *              InsufficientLockupFunds even when the deposit is there.
 *
 * Everything here is a read. The writes belong to the user's wallet, in the
 * browser -- the agent's session key has FWSS storage permissions only, and
 * nothing that would let it move the user's tokens. That separation is the
 * point: the agent can commit you to storage, but it cannot spend your money.
 */

export interface FundingState {
  walletAddress: string | null
  /** USDFC sitting in the wallet, not yet deposited. */
  walletBalance: string
  /** How much of that the Pay contract is currently allowed to pull. */
  payAllowance: string
  /** USDFC held by Filecoin Pay for this wallet. */
  deposited: string
  /** The unreserved part of it -- what a new rail can actually draw on. */
  available: string
  /** Aggregate per-epoch burn across every rail this wallet pays for. */
  lockupRatePerEpoch: string
  /** Whether FWSS is approved as an operator at all. */
  serviceApproved: boolean
  rateAllowance: string
  lockupAllowance: string
  maxLockupPeriod: string
  /** What FWSS wants maxLockupPeriod to be, read from the chain price list. */
  requiredLockupPeriod: string
  /** True when deposit AND approval are both good enough to store a file. */
  ready: boolean
  /** Addresses the browser needs to build the transactions. */
  contracts: {
    usdfc: string
    filecoinPay: string
    fwss: string
  }
  chainId: number
}

const ZERO: Omit<FundingState, "walletAddress" | "contracts" | "chainId"> = {
  walletBalance: "0",
  payAllowance: "0",
  deposited: "0",
  available: "0",
  lockupRatePerEpoch: "0",
  serviceApproved: false,
  rateAllowance: "0",
  lockupAllowance: "0",
  maxLockupPeriod: "0",
  requiredLockupPeriod: "0",
  ready: false,
}

export async function readFunding(walletAddress: string | null): Promise<FundingState> {
  const [chains, viem] = await Promise.all([
    import("@filoz/synapse-core/chains"),
    import("viem"),
  ])

  const network = process.env.FILECOIN_NETWORK ?? "calibration"
  const chain = network === "mainnet" ? chains.mainnet : chains.calibration
  const rpcUrl = process.env.FILECOIN_RPC_URL

  const contracts = {
    usdfc: chain.contracts.usdfc.address,
    filecoinPay: chain.contracts.filecoinPay.address,
    fwss: chain.contracts.fwss.address,
  }

  if (!walletAddress) {
    return { walletAddress: null, ...ZERO, contracts, chainId: chain.id }
  }

  const client = viem.createPublicClient({
    chain,
    transport: rpcUrl ? viem.http(rpcUrl) : viem.http(),
  })

  const [{ getAccountSummary, operatorApprovals }, { getPriceList }] = await Promise.all([
    import("@filoz/synapse-core/pay"),
    import("@filoz/synapse-core/warm-storage"),
  ])

  const address = walletAddress as `0x${string}`

  const [balance, allowance, summary, approval, priceList] = await Promise.all([
    client.readContract({
      address: contracts.usdfc,
      abi: chain.contracts.usdfc.abi,
      functionName: "balanceOf",
      args: [address],
    }) as Promise<bigint>,
    client.readContract({
      address: contracts.usdfc,
      abi: chain.contracts.usdfc.abi,
      functionName: "allowance",
      args: [address, contracts.filecoinPay],
    }) as Promise<bigint>,
    getAccountSummary(client, { address, token: contracts.usdfc }),
    operatorApprovals(client, { address }),
    getPriceList(client),
  ])

  const requiredLockupPeriod = priceList.lockups.defaultLockupPeriod

  // "Ready" is deliberately weak: enough approval to open a rail, and some
  // unreserved balance to draw on. The exact cost depends on the file, so the
  // upload is still the thing that finds out for certain.
  const ready =
    approval.isApproved &&
    approval.rateAllowance > 0n &&
    approval.lockupAllowance > 0n &&
    approval.maxLockupPeriod >= requiredLockupPeriod &&
    summary.availableFunds > 0n

  return {
    walletAddress,
    walletBalance: balance.toString(),
    payAllowance: allowance.toString(),
    deposited: summary.funds.toString(),
    available: summary.availableFunds.toString(),
    lockupRatePerEpoch: summary.lockupRatePerEpoch.toString(),
    serviceApproved: approval.isApproved,
    rateAllowance: approval.rateAllowance.toString(),
    lockupAllowance: approval.lockupAllowance.toString(),
    maxLockupPeriod: approval.maxLockupPeriod.toString(),
    requiredLockupPeriod: requiredLockupPeriod.toString(),
    ready,
    contracts,
    chainId: chain.id,
  }
}
