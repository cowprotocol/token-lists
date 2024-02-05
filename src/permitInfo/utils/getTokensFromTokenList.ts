import { readFileSync } from 'node:fs'
import { BASE_PATH } from '../const.ts'
import { Token } from '../types.ts'
import { join } from 'node:path'

const tokenListsByNetwork: Record<number, string> = {
  1: 'CowSwap.json',
  100: 'CowSwap.json',
  11155111: 'CowSwapSepolia.json',
}

export function getTokensFromTokenList(chainId: number, tokenListPath: string | undefined): Array<Token> {
  const filePath = tokenListPath
    ? tokenListPath
    : join(BASE_PATH, tokenListsByNetwork[chainId])

  return JSON.parse(readFileSync(filePath, 'utf-8')).tokens
}
