import { SupportedChainId } from '@cowprotocol/cow-sdk'
import {
  COINGECKO_CHAINS,
  type COINGECKO_IDS_MAP,
  fetchWithApiKey,
  getTokenList,
  processTokenList,
  TokenInfo,
  TOP_TOKENS_COUNT,
  VS_CURRENCY,
} from './utils'

interface MarketData {
  id: string
  total_volume: number
}

async function getCoingeckoMarket(
  chainId: SupportedChainId,
  tokens: TokenInfo[],
  coingeckoIdsMap: COINGECKO_IDS_MAP,
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
      `https://pro-api.coingecko.com/api/v3/coins/markets?vs_currency=${VS_CURRENCY}&per_page=250&ids=${ids}`,
    )
  } catch (error) {
    console.error(`Error fetching Coingecko's coin list`, error)
    return []
  }
}

interface TokenWithVolume {
  token: TokenInfo
  volume: number
}

async function getTokenVolumes(
  chainId: SupportedChainId,
  tokens: TokenInfo[],
  coingeckoIdsMap: COINGECKO_IDS_MAP,
): Promise<TokenWithVolume[]> {
  const chunkSize = 250
  const chunks = []

  for (let i = 0; i < tokens.length; i += chunkSize) {
    const chunk = tokens.slice(i, i + chunkSize)
    chunks.push({
      tokens: chunk,
      volume: getCoingeckoMarket(chainId, chunk, coingeckoIdsMap),
    })
  }

  const coingeckoChainName = COINGECKO_CHAINS[chainId]
  if (!coingeckoChainName) {
    return []
  }

  const ids = coingeckoIdsMap[coingeckoChainName]
  const volumes = await Promise.all(
    chunks.map(async ({ tokens, volume }: { tokens: TokenInfo[]; volume: Promise<MarketData[]> }) => {
      const volumeData = await volume
      const volumeMap = volumeData.reduce<Record<string, number>>((acc, cur: MarketData) => {
        if (cur.total_volume && ids[cur.id]) {
          acc[ids[cur.id]] = cur.total_volume
        }
        return acc
      }, {})

      return tokens.reduce<TokenWithVolume[]>((acc, token: TokenInfo) => {
        if (volumeMap[token.address]) {
          acc.push({ token, volume: volumeMap[token.address] })
        }
        return acc
      }, [])
    }),
  )

  return volumes.flat().sort((a, b) => b.volume - a.volume)
}

async function fetchAndProcessCoingeckoTokensForChain(
  chainId: SupportedChainId,
  coingeckoIdsMap: COINGECKO_IDS_MAP,
): Promise<void> {
  try {
    const tokens = await getTokenList(chainId)
    const topTokens = (await getTokenVolumes(chainId, tokens, coingeckoIdsMap)).slice(0, TOP_TOKENS_COUNT)

    await processTokenList({
      chainId,
      tokens: topTokens.map(({ token, volume }) => ({ ...token, volume })),
      prefix: 'CoinGecko',
      logo: 'https://support.coingecko.com/hc/article_attachments/4499575478169/CoinGecko_logo.png',
      logMessage: `Top ${TOP_TOKENS_COUNT} tokens`,
    })
  } catch (error) {
    console.error(`Error fetching data for chain ${chainId}:`, error)
  }
}

export async function fetchAndProcessCoingeckoTokens(coingeckoIdsMap: COINGECKO_IDS_MAP) {
  Object.keys(COINGECKO_CHAINS).forEach(
    (chain) =>
      COINGECKO_CHAINS[+chain as SupportedChainId] &&
      fetchAndProcessCoingeckoTokensForChain(Number(chain), coingeckoIdsMap),
  )
}
