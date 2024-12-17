import { SupportedChainId } from '@cowprotocol/cow-sdk'
import {
  COINGECKO_CHAINS,
  type CoingeckoIdsMap,
  fetchWithApiKey,
  getTokenList,
  processTokenList,
  TokenInfo,
  TOP_TOKENS_COUNT,
  VS_CURRENCY,
} from './utils'

const COINGECKO_LOGO = 'https://support.coingecko.com/hc/article_attachments/4499575478169/CoinGecko_logo.png'
const MARKET_API_CHUNK_SIZE = 250

interface MarketData {
  id: string
  total_volume: number
}

interface TokenWithVolume {
  token: TokenInfo
  volume: number
}

interface TokenChunk {
  tokens: TokenInfo[]
  volume: Promise<MarketData[]>
}

/**
 * Fetches market data for a chunk of tokens from CoinGecko API
 */
async function getCoingeckoMarket(
  chainId: SupportedChainId,
  tokens: TokenInfo[],
  coingeckoIdsMap: CoingeckoIdsMap,
): Promise<MarketData[]> {
  const coingeckoChainName = COINGECKO_CHAINS[chainId]
  if (!coingeckoChainName) {
    return []
  }

  const coingeckoIdsForChain = coingeckoIdsMap[coingeckoChainName]
  const ids = tokens.reduce((acc, token) => {
    const coingeckoId = coingeckoIdsForChain[token.address]
    return coingeckoId ? `${acc}${coingeckoId},` : acc
  }, '')

  try {
    return await fetchWithApiKey(
      `https://pro-api.coingecko.com/api/v3/coins/markets?vs_currency=${VS_CURRENCY}&per_page=${MARKET_API_CHUNK_SIZE}&ids=${ids}`,
    )
  } catch (error) {
    console.error(`Error fetching Coingecko's coin list:`, error)
    return []
  }
}

/**
 * Creates chunks of tokens for batch processing
 */
function createTokenChunks(
  tokens: TokenInfo[],
  chainId: SupportedChainId,
  coingeckoIdsMap: CoingeckoIdsMap,
): TokenChunk[] {
  const chunks: TokenChunk[] = []

  for (let i = 0; i < tokens.length; i += MARKET_API_CHUNK_SIZE) {
    const tokenChunk = tokens.slice(i, i + MARKET_API_CHUNK_SIZE)
    chunks.push({
      tokens: tokenChunk,
      volume: getCoingeckoMarket(chainId, tokenChunk, coingeckoIdsMap),
    })
  }

  return chunks
}

/**
 * Processes market data for a chunk of tokens
 */
async function processTokenChunk(
  chunk: TokenChunk,
  coingeckoIdsMap: CoingeckoIdsMap,
  coingeckoChainName: string,
): Promise<TokenWithVolume[]> {
  const volumeData = await chunk.volume
  const ids = coingeckoIdsMap[coingeckoChainName]

  const volumeMap = volumeData.reduce<Record<string, number>>((acc, cur: MarketData) => {
    if (cur.total_volume && ids[cur.id]) {
      acc[ids[cur.id]] = cur.total_volume
    }
    return acc
  }, {})

  return chunk.tokens.reduce<TokenWithVolume[]>((acc, token: TokenInfo) => {
    if (volumeMap[token.address]) {
      acc.push({ token, volume: volumeMap[token.address] })
    }
    return acc
  }, [])
}

/**
 * Gets token volumes for all tokens on a specific chain
 */
async function getTokenVolumes(
  chainId: SupportedChainId,
  tokens: TokenInfo[],
  coingeckoIdsMap: CoingeckoIdsMap,
): Promise<TokenWithVolume[]> {
  const coingeckoChainName = COINGECKO_CHAINS[chainId]
  if (!coingeckoChainName) {
    return []
  }

  const chunks = createTokenChunks(tokens, chainId, coingeckoIdsMap)
  const volumes = await Promise.all(
    chunks.map((chunk) => processTokenChunk(chunk, coingeckoIdsMap, coingeckoChainName)),
  )

  return volumes.flat().sort((a, b) => b.volume - a.volume)
}

/**
 * Processes CoinGecko tokens for a specific chain
 */
async function fetchAndProcessCoingeckoTokensForChain(
  chainId: SupportedChainId,
  coingeckoIdsMap: CoingeckoIdsMap,
): Promise<void> {
  try {
    const tokens = await getTokenList(chainId)
    const topTokens = (await getTokenVolumes(chainId, tokens, coingeckoIdsMap)).slice(0, TOP_TOKENS_COUNT)

    await processTokenList({
      chainId,
      tokens: topTokens.map(({ token, volume }) => ({ ...token, volume })),
      prefix: 'CoinGecko',
      logo: COINGECKO_LOGO,
      logMessage: `Top ${TOP_TOKENS_COUNT} tokens`,
    })
  } catch (error) {
    console.error(`Error processing CoinGecko tokens for chain ${chainId}:`, error)
  }
}

/**
 * Main function to fetch and process CoinGecko tokens for all supported chains
 */
export async function fetchAndProcessCoingeckoTokens(coingeckoIdsMap: CoingeckoIdsMap): Promise<void> {
  const supportedChains = Object.keys(COINGECKO_CHAINS)
    .map(Number)
    .filter((chain) => COINGECKO_CHAINS[chain as SupportedChainId])

  await Promise.all(supportedChains.map((chain) => fetchAndProcessCoingeckoTokensForChain(chain, coingeckoIdsMap)))
}
