import assert from 'assert'
import fs from 'fs'
import winston, { Logger } from 'winston'
import { mapSupportedNetworks, SupportedChainId } from '@cowprotocol/cow-sdk'

export interface TokenInfo {
  chainId: SupportedChainId
  address: string
  name: string
  symbol: string
  decimals: number
  logoURI?: string
  volume?: number
}

export type Overrides = Record<string, Partial<TokenInfo>>
export type OverridesPerChain = Record<SupportedChainId, Overrides>

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
  [SupportedChainId.POLYGON]: 'polygon-pos',
  [SupportedChainId.AVALANCHE]: 'avalanche',
}

export const DISPLAY_CHAIN_NAMES: Record<SupportedChainId, string | null> = {
  [SupportedChainId.MAINNET]: 'Ethereum',
  [SupportedChainId.GNOSIS_CHAIN]: 'Gnosis chain',
  [SupportedChainId.BASE]: 'Base',
  [SupportedChainId.ARBITRUM_ONE]: 'Arbitrum one',
  [SupportedChainId.SEPOLIA]: null,
  [SupportedChainId.POLYGON]: 'Polygon',
  [SupportedChainId.AVALANCHE]: 'Avalanche',
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

export function removeOldLogs(context: string): void {
  const logFiles = [`${context}.log`, `${context}-error.log`]
  logFiles.forEach((file) => {
    if (fs.existsSync(file)) {
      fs.unlinkSync(file)
    }
  })
}

let logger: Logger
export function getLogger(context: string): Logger {
  if (!logger) {
    logger = winston.createLogger({
      level: 'info',
      format: winston.format.json(),
      transports: [
        new winston.transports.File({ filename: `${context}.log` }),
        new winston.transports.File({ filename: `${context}-error.log`, level: 'error' }),
        new winston.transports.Console({ level: 'error' }),
      ],
    })
  }
  return logger
}
