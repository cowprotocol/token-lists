import { mapSupportedNetworks, SupportedChainId } from '@cowprotocol/cow-sdk'
import { TokenList } from '@uniswap/token-lists'
import assert from 'assert'
import * as fs from 'fs'
import path from 'path'

export interface TokenInfo {
  chainId: SupportedChainId
  address: string
  name: string
  symbol: string
  decimals: number
  logoURI?: string
  volume?: number
}

interface SaveUpdatedTokensParams {
  chainId: SupportedChainId
  prefix: string
  logo: string
  tokens: TokenInfo[]
  listName: string
}

interface ProcessTokenListParams {
  chainId: SupportedChainId
  tokens: TokenInfo[]
  prefix: string
  logo: string
  logMessage: string
  shouldAddCountToListName?: boolean
}

interface CoingeckoToken {
  id: string
  platforms: {
    [chain: string]: string
  }
}

export type CoingeckoIdsMap = Record<string, Record<string, string>>

export const COINGECKO_API_KEY = process.env.COINGECKO_API_KEY
assert(COINGECKO_API_KEY, 'COINGECKO_API_KEY env is required')

export const COINGECKO_CHAINS: Record<SupportedChainId, string | null> = {
  [SupportedChainId.MAINNET]: 'ethereum',
  [SupportedChainId.GNOSIS_CHAIN]: 'xdai',
  [SupportedChainId.BASE]: 'base',
  [SupportedChainId.ARBITRUM_ONE]: 'arbitrum-one',
  [SupportedChainId.SEPOLIA]: null,
}

export const DISPLAY_CHAIN_NAMES: Record<SupportedChainId, string | null> = {
  [SupportedChainId.MAINNET]: 'Ethereum',
  [SupportedChainId.GNOSIS_CHAIN]: 'Gnosis chain',
  [SupportedChainId.BASE]: 'Base',
  [SupportedChainId.ARBITRUM_ONE]: 'Arbitrum one',
  [SupportedChainId.SEPOLIA]: null,
}

export const VS_CURRENCY = 'usd'
export const TOP_TOKENS_COUNT = 500
const COINGECKO_CHAINS_NAMES = Object.values(COINGECKO_CHAINS)
const TOKEN_LISTS_CACHE: Record<SupportedChainId, TokenInfo[]> = mapSupportedNetworks([])

export async function fetchWithApiKey(url: string): Promise<any> {
  try {
    const headers = COINGECKO_API_KEY ? { 'X-Cg-Pro-Api-Key': COINGECKO_API_KEY } : undefined
    const response = await fetch(url, { headers })

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`)
    }

    return response.json()
  } catch (error) {
    console.error(`Failed to fetch from ${url}:`, error)
    throw error
  }
}

async function getCoingeckoTokenIds(): Promise<CoingeckoToken[]> {
  try {
    return await fetchWithApiKey('https://pro-api.coingecko.com/api/v3/coins/list?include_platform=true&status=active')
  } catch (error) {
    console.error(`Error fetching Coingecko's coin list:`, error)
    return []
  }
}

export async function getCoingeckoTokenIdsMap(): Promise<CoingeckoIdsMap> {
  const tokenIdsMap = COINGECKO_CHAINS_NAMES.reduce<CoingeckoIdsMap>(
    (acc, name) => (name ? { ...acc, [name]: {} } : acc),
    {},
  )

  try {
    const tokenIds = await getCoingeckoTokenIds()
    tokenIds.forEach((token) => {
      COINGECKO_CHAINS_NAMES.forEach((chain) => {
        if (!chain) return

        const address = token.platforms[chain]?.toLowerCase()
        if (address) {
          tokenIdsMap[chain][address] = token.id
          tokenIdsMap[chain][token.id] = address // reverse mapping
        }
      })
    })
    return tokenIdsMap
  } catch (error) {
    console.error(`Error building Coingecko token IDs map:`, error)
    return tokenIdsMap
  }
}

function getEmptyList(): Partial<TokenList> {
  return {
    keywords: ['defi'],
    version: { major: 0, minor: 0, patch: 0 },
    tokens: [],
  }
}

function getListName(chain: SupportedChainId, prefix: string, count?: number): string {
  return `${prefix}${count ? ` top ${count}` : ''} on ${DISPLAY_CHAIN_NAMES[chain]}`
}

function getOutputPath(prefix: string, chainId: SupportedChainId): string {
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

function getTokenListVersion(list: Partial<TokenList>, tokens: TokenInfo[]): TokenList['version'] {
  const version = list.version || { major: 0, minor: 0, patch: 0 }
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

function getTokenListUrl(chain: SupportedChainId): string {
  return `https://tokens.coingecko.com/${COINGECKO_CHAINS[chain]}/all.json`
}

export async function getTokenList(chain: SupportedChainId): Promise<TokenInfo[]> {
  if (TOKEN_LISTS_CACHE[chain].length) {
    return TOKEN_LISTS_CACHE[chain]
  }

  const data = await fetchWithApiKey(getTokenListUrl(chain))
  TOKEN_LISTS_CACHE[chain] = data.tokens
  return data.tokens
}
