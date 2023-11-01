import { JsonRpcProvider } from '@ethersproject/providers'
import { DEFAULT_RPC_URLS } from '../const.js'
import { env } from 'node:process'
import { ethers } from 'ethers'

export function getProvider(chainId: number, rpcUrl: string | undefined): JsonRpcProvider {
  const rpcEndpoint = rpcUrl ? rpcUrl : DEFAULT_RPC_URLS[chainId]

  if (!rpcEndpoint) {
    throw new Error(`No RPC found for network ${chainId}`)
  }

  if (!rpcUrl && (chainId === 1 || chainId === 5) && !env.INFURA_API_KEY) {
    throw new Error(`INFURA_API_KEY is required`)
  }

  return new ethers.providers.JsonRpcProvider(rpcEndpoint)
}
