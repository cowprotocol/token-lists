import { TokenList } from '@uniswap/token-lists'
import assert from 'assert'
import * as fs from 'fs'
import * as path from 'path'

export const COINGECKO_API_KEY = process.env.COINGECKO_API_KEY
assert(COINGECKO_API_KEY, 'COINGECKO_API_KEY env is required')

export const COINGECKO_CHAINS: Record<number, string> = {
  1: 'ethereum',
  100: 'xdai',
  8453: 'base',
  42161: 'arbitrum-one',
}

export const DISPLAY_CHAIN_NAMES: Record<number, string> = {
  1: 'Ethereum',
  100: 'Gnosis chain',
  8453: 'Base',
  42161: 'Arbitrum one',
}

export const VS_CURRENCY = 'usd'
export const TOP_TOKENS_COUNT = 500

export interface TokenInfo {
  chainId: number
  address: string
  name: string
  symbol: string
  decimals: number
  logoURI?: string
  volume?: number
}

export async function fetchWithApiKey(url: string): Promise<any> {
  const headers = COINGECKO_API_KEY ? { 'X-Cg-Pro-Api-Key': COINGECKO_API_KEY } : undefined
  const response = await fetch(url, { headers })
  return response.json()
}

function getEmptyList(): Partial<TokenList> {
  return {
    name: 'Coingecko',
    logoURI:
      'https://static.coingecko.com/s/thumbnail-007177f3eca19695592f0b8b0eabbdae282b54154e1be912285c9034ea6cbaf2.png',
    keywords: ['defi'],
    version: { major: 0, minor: 0, patch: 0 },
    tokens: [],
  }
}

function getListName(chain: number, prefix: string, count?: number): string {
  return `${prefix}${count ? ` top ${count}` : ''} on ${DISPLAY_CHAIN_NAMES[chain]}`
}

function getOutputPath(prefix: string, chainId: number): string {
  return `src/public/${prefix}.${chainId}.json`
}

export function getLocalTokenList(listPath: string, defaultEmptyList: Partial<TokenList>): Partial<TokenList> {
  try {
    return JSON.parse(fs.readFileSync(listPath, 'utf8'))
  } catch (error) {
    console.warn(`Error reading token list from ${listPath}:`, error)
    return defaultEmptyList
  }
}

export function saveLocalTokenList(listPath: string, list: TokenList): void {
  try {
    const updatedVersion = list.version
      ? { ...list.version, major: list.version.major + 1 }
      : { major: 1, minor: 0, patch: 0 }
    const updatedList = { ...list, version: updatedVersion, timestamp: new Date().toISOString() }
    fs.writeFileSync(listPath, JSON.stringify(updatedList, null, 2))
    console.log(`Token list saved to ${listPath}`)
  } catch (error) {
    console.error(`Error saving token list to ${listPath}:`, error)
  }
}

interface ProcessTokenListParams {
  chainId: number
  tokens: TokenInfo[]
  prefix: string
  logMessage: string
}

export async function processTokenList({ chainId, tokens, prefix, logMessage }: ProcessTokenListParams): Promise<void> {
  const count = tokens.length
  console.log(`🥇 ${logMessage} on chain ${chainId}`)
  tokens.forEach((token, index) => {
    const volumeStr = token.volume ? `: $${token.volume}` : ''
    console.log(`\t-${(index + 1).toString().padStart(3, '0')}) ${token.name} (${token.symbol})${volumeStr}`)
  })

  const tokenListPath = path.join(getOutputPath(prefix, chainId))
  const tokenList = getLocalTokenList(tokenListPath, getEmptyList())

  const updatedTokens = tokens.map((token) => ({
    ...token,
    logoURI: token.logoURI ? token.logoURI.replace(/thumb/, 'large') : undefined,
  }))
  const updatedName = getListName(chainId, prefix, count)

  const updatedTokenList = { ...tokenList, tokens: updatedTokens, name: updatedName }

  saveLocalTokenList(tokenListPath, updatedTokenList as TokenList)
}
