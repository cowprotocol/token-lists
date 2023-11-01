import { readFileSync } from 'node:fs'
import { BASE_PATH } from '../const.js'
import { Token } from '../types.js'
import { join } from 'node:path'

export function getTokens(chainId: number, tokenListPath: string | undefined): Array<Token> {
  const filePath = tokenListPath
    ? tokenListPath
    : join(BASE_PATH, chainId === 5 ? 'CowSwapGoerli.json' : 'CowSwap.json')

  return JSON.parse(readFileSync(filePath, 'utf-8')).tokens
}
