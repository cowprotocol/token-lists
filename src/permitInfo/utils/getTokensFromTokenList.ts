import { SupportedChainId, mapSupportedNetworks } from '@cowprotocol/cow-sdk'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { BASE_PATH } from '../const'
import { Token } from '../types'

const tokenListsByNetwork: Record<SupportedChainId, string> = {
  ...mapSupportedNetworks('CowSwap.json'),
  [SupportedChainId.SEPOLIA]: 'CowSwapSepolia.json',
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
