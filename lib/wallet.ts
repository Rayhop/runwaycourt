/**
 * Talking to the user's own wallet, in the browser.
 *
 * Anything that spends the user's money or grants authority over it is signed
 * here, by them -- never by the agent's session key, which holds FWSS storage
 * permissions and nothing that could move tokens.
 *
 * Client-side only. Do not import from a server module.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Ethereum = any

export function getEthereum(): Ethereum {
  const ethereum = (window as { ethereum?: Ethereum }).ethereum
  if (!ethereum) throw new Error("No wallet found in this browser.")
  return ethereum
}

/** Prompt for accounts and return the selected one. */
export async function connect(ethereum: Ethereum): Promise<`0x${string}`> {
  const [from] = (await ethereum.request({ method: "eth_requestAccounts" })) as string[]
  if (!from) throw new Error("No account selected in the wallet.")
  return from as `0x${string}`
}

/**
 * Refuse to send anything while the wallet is on the wrong network.
 *
 * Without this the transaction goes through on whatever chain is selected, and
 * the failure surfaces later as an unrelated-looking balance or allowance
 * problem on the chain the app is actually reading.
 */
export async function requireChain(ethereum: Ethereum, chainId: number): Promise<void> {
  const current = Number((await ethereum.request({ method: "eth_chainId" })) as string)
  if (current === chainId) return

  try {
    await ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: `0x${chainId.toString(16)}` }],
    })
  } catch {
    throw new Error(
      `Your wallet is on chain ${current}, but this app is using ${chainId}. ` +
        "Switch networks and try again.",
    )
  }
}

/**
 * Block until a transaction is mined, then insist it succeeded.
 *
 * eth_sendTransaction resolves when a transaction is BROADCAST, not when it is
 * mined, so acting on its hash means acting on something that may still revert
 * or be dropped. Every write here waits.
 */
export async function waitForReceipt(
  ethereum: Ethereum,
  txHash: string,
  timeoutMs = 3 * 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    const receipt = (await ethereum.request({
      method: "eth_getTransactionReceipt",
      params: [txHash],
    })) as { status?: string } | null

    if (receipt) {
      // 0x1 is success, 0x0 a revert.
      if (receipt.status === "0x0") throw new Error(`Transaction ${txHash} reverted on chain.`)
      return
    }

    await new Promise((resolve) => setTimeout(resolve, 3_000))
  }

  throw new Error(
    "That transaction is taking unusually long to confirm. It may still land -- " +
      "reload in a minute rather than sending it again.",
  )
}

/** Send one contract call from the user's wallet and wait for it to land. */
export async function sendCall(
  ethereum: Ethereum,
  from: `0x${string}`,
  call: { address: `0x${string}`; abi: readonly unknown[]; functionName: string; args: readonly unknown[] },
): Promise<string> {
  const { encodeFunctionData } = await import("viem")
  const data = encodeFunctionData({
    abi: call.abi as any,
    functionName: call.functionName,
    args: call.args as any,
  })

  const txHash = (await ethereum.request({
    method: "eth_sendTransaction",
    params: [{ from, to: call.address, data }],
  })) as string

  await waitForReceipt(ethereum, txHash)
  return txHash
}
