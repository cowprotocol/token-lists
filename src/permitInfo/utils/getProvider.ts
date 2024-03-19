import { JsonRpcProvider } from '@ethersproject/providers'
import { DEFAULT_RPC_URLS } from '../const'
import { ethers } from 'ethers'
import {SupportedChainId} from '@cowprotocol/cow-sdk'

export function getProvider(chainId: number, rpcUrl: string | undefined): JsonRpcProvider {
  const rpcEndpoint = rpcUrl ? rpcUrl : DEFAULT_RPC_URLS[chainId as SupportedChainId]

  if (!rpcEndpoint) {
    throw new Error(`No RPC found for network ${chainId}`)
  }

  return new ethers.providers.JsonRpcProvider(rpcEndpoint)
}
