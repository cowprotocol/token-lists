import { getTokenPermitInfo } from 'alfetopito-permit-utils' // import {getTokenPermitInfo, PermitInfo} from '@cowprotocol/permit-utils' // TODO: maybe make the args nicer?

import { ethers } from 'ethers'
import { JsonRpcProvider } from '@ethersproject/providers'

const DEFAULT_RPC_URLS: Record<number, string> = {
  1: 'https://mainnet.infura.io/v3/' + process.env.INFURA_API_KEY,
  5: 'https://goerli.infura.io/v3/' + process.env.INFURA_API_KEY,
  100: 'https://rpc.gnosischain.com',
}

function getProvider(chainId: number, rpcUrl: string | undefined): JsonRpcProvider {
  const rpcEndpoint = rpcUrl ? rpcUrl : DEFAULT_RPC_URLS[chainId]

  if (!rpcEndpoint) {
    throw new Error(`No RPC found for network ${chainId}`)
  }

  if (!rpcUrl && (chainId === 1 || chainId === 5) && !process.env.INFURA_API_KEY) {
    throw new Error(`INFURA_API_KEY is required`)
  }

  return new ethers.providers.JsonRpcProvider(rpcEndpoint)
}

async function main() {
  const provider = getProvider(1, undefined)
  // const response = await getTokenPermitInfo({
  //   chainId: 1,
  //   provider,
  //   spender: '0xC92E8bdf79f0507f65a392b0ab4667716BFE0110',
  //   tokenAddress: '0xdef1ca1fb7fbcdc777520aa7f396b4e015f497ab',
  //   tokenName: 'COW',
  // })

  // // Uncomment breaks!
  // console.log(getTokenPermitInfo)

  const response = await provider.getBlockNumber()

  console.info(`Token COW:`, response)
}

main().catch(console.error)
