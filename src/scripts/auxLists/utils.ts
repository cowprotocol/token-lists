import { TokenList } from '@uniswap/token-lists'
import assert from 'assert'
import * as fs from 'fs'
import path from 'path'

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

interface SaveUpdatedTokensParams {
  chainId: number
  prefix: string
  logo: string
  tokens: TokenInfo[]
  listName: string
}

function getTokenListVersion(list: Partial<TokenList>, tokens: TokenInfo[]): TokenList['version'] {
  let version = list.version || { major: 0, minor: 0, patch: 0 }
  const listTokenAddresses = new Set(list.tokens?.map((token) => token.address.toLowerCase()) || [])
  const tokensAddresses = new Set(tokens.map((token) => token.address.toLowerCase()))

  // Check for removed tokens
  if (
    listTokenAddresses.size > tokensAddresses.size ||
    Array.from(listTokenAddresses).some((address) => !tokensAddresses.has(address))
  ) {
    return { ...version, major: version.major + 1 }
  }

  // Check for added tokens
  if (
    listTokenAddresses.size < tokensAddresses.size ||
    Array.from(tokensAddresses).some((address) => !listTokenAddresses.has(address))
  ) {
    return { ...version, minor: version.minor + 1 }
  }

  // Check for changes in token details
  for (const listToken of list.tokens || []) {
    const token = tokens.find((token) => token.address === listToken.address)
    if (
      token &&
      (listToken.name !== token.name ||
        listToken.symbol !== token.symbol ||
        listToken.decimals !== token.decimals ||
        listToken.logoURI !== token.logoURI)
    ) {
      return { ...version, patch: version.patch + 1 }
    }
  }

  return version
}

export function saveUpdatedTokens({ chainId, prefix, logo, tokens, listName }: SaveUpdatedTokensParams): void {
  const tokenListPath = path.join(getOutputPath(prefix, chainId))
  const currentList = getLocalTokenList(tokenListPath, getEmptyList())
  const updatedTokenList = { ...currentList, tokens, name: listName, logoURI: logo }

  try {
    const version = getTokenListVersion(currentList, tokens)
    const updatedList: TokenList = { ...updatedTokenList, version, timestamp: new Date().toISOString() }
    fs.writeFileSync(tokenListPath, JSON.stringify(updatedList, null, 2))
    console.log(`Token list saved to ${tokenListPath}`)
  } catch (error) {
    console.error(`Error saving token list to ${tokenListPath}:`, error)
  }
}

interface ProcessTokenListParams {
  chainId: number
  tokens: TokenInfo[]
  prefix: string
  logo: string
  logMessage: string
  shouldAddCountToListName?: boolean
}

export async function processTokenList({
  chainId,
  tokens,
  prefix,
  logo,
  logMessage,
  shouldAddCountToListName = true,
}: ProcessTokenListParams): Promise<void> {
  const count = tokens.length
  console.log(`🥇 ${logMessage} on chain ${chainId}`)
  tokens.forEach((token, index) => {
    const volumeStr = token.volume ? `: $${token.volume}` : ''
    console.log(`\t-${(index + 1).toString().padStart(3, '0')}) ${token.name} (${token.symbol})${volumeStr}`)
  })

  const updatedTokens = tokens.map(({ volume: _, ...token }) => ({
    ...token,
    logoURI: token.logoURI ? token.logoURI.replace(/thumb/, 'large') : undefined,
  }))
  const listName = getListName(chainId, prefix, shouldAddCountToListName ? count : undefined)

  saveUpdatedTokens({ chainId, prefix, logo, tokens: updatedTokens, listName })
}
