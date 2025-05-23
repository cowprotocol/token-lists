import { SupportedChainId } from '@cowprotocol/cow-sdk'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { BASE_PATH } from '../const'
import { Token } from '../types'

const tokenListsByNetwork: Record<SupportedChainId, string> = {
  [SupportedChainId.MAINNET]: 'CowSwap.json',
  [SupportedChainId.ARBITRUM_ONE]: 'CowSwap.json',
  [SupportedChainId.BASE]: 'CowSwap.json',
  [SupportedChainId.GNOSIS_CHAIN]: 'CowSwap.json',
  [SupportedChainId.SEPOLIA]: 'CowSwapSepolia.json',
  [SupportedChainId.POLYGON]: 'CowSwap.json',
  [SupportedChainId.AVALANCHE]: 'CowSwap.json',
}

export async function getTokensFromTokenList(
  chainId: SupportedChainId,
  tokenListPath: string | undefined,
): Promise<Array<Token>> {
  if (tokenListPath?.startsWith('http')) {
    return (await fetch(tokenListPath).then((r) => r.json())).tokens
  } else {
    const filePath = tokenListPath ? tokenListPath : join(BASE_PATH, tokenListsByNetwork[chainId])

    return JSON.parse(readFileSync(filePath, 'utf-8')).tokens
  }
}
