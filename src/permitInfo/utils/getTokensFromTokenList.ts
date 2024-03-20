import { readFileSync } from 'node:fs'
import { BASE_PATH } from '../const'
import { Token } from '../types'
import { join } from 'node:path'
import { SupportedChainId } from '@cowprotocol/cow-sdk'

const tokenListsByNetwork: Record<SupportedChainId, string> = {
  [SupportedChainId.MAINNET]: 'CowSwap.json',
  [SupportedChainId.GNOSIS_CHAIN]: 'CowSwap.json',
  [SupportedChainId.SEPOLIA]: 'CowSwapSepolia.json',
}

export function getTokensFromTokenList(chainId: SupportedChainId, tokenListPath: string | undefined): Array<Token> {
  const filePath = tokenListPath
    ? tokenListPath
    : join(BASE_PATH, tokenListsByNetwork[chainId])

  return JSON.parse(readFileSync(filePath, 'utf-8')).tokens
}
