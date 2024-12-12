import { COINGECKO_CHAINS, fetchWithApiKey, processTokenList, TokenInfo, TOP_TOKENS_COUNT, VS_CURRENCY } from './utils'

const COINGECKO_CHAINS_NAMES = Object.values(COINGECKO_CHAINS)

interface TokenIdsMap {
  [chain: string]: {
    [addressOrId: string]: string
  }
}

let COINGECKO_IDS_MAP: TokenIdsMap = {}

function getTokenListUrl(chain: number): string {
  return `https://tokens.coingecko.com/${COINGECKO_CHAINS[chain]}/all.json`
}

async function getTokenList(chain: number): Promise<TokenInfo[]> {
  const data = await fetchWithApiKey(getTokenListUrl(chain))
  return data.tokens
}

interface CoingeckoToken {
  id: string
  platforms: {
    [chain: string]: string
  }
}

async function getCoingeckoTokenIds(): Promise<CoingeckoToken[]> {
  try {
    return await fetchWithApiKey('https://pro-api.coingecko.com/api/v3/coins/list?include_platform=true&status=active')
  } catch (error) {
    console.error(`Error fetching Coingecko's coin list`, error)
    return []
  }
}

export async function getCoingeckoTokenIdsMap(): Promise<TokenIdsMap> {
  let tokenIdsMap = COINGECKO_CHAINS_NAMES.reduce<TokenIdsMap>((acc, name) => ({ ...acc, [name]: {} }), {})

  try {
    const tokenIds = await getCoingeckoTokenIds()
    tokenIds.forEach((token) => {
      COINGECKO_CHAINS_NAMES.forEach((chain) => {
        const address = token.platforms[chain]?.toLowerCase()
        if (address) {
          tokenIdsMap[chain][address] = token.id
          tokenIdsMap[chain][token.id] = address // reverse mapping
        }
      })
    })
  } catch (error) {
    console.error(`Error fetching Coingecko token IDs: ${error}`)
  }

  return tokenIdsMap
}

interface MarketData {
  id: string
  total_volume: number
}

async function getCoingeckoMarket(chainId: number, tokens: TokenInfo[]): Promise<MarketData[]> {
  const coingeckoIdsForChain = COINGECKO_IDS_MAP[COINGECKO_CHAINS[chainId]]
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

async function getTokenVolumes(chainId: number, tokens: TokenInfo[]): Promise<TokenWithVolume[]> {
  const chunkSize = 250
  const chunks = []

  for (let i = 0; i < tokens.length; i += chunkSize) {
    const chunk = tokens.slice(i, i + chunkSize)
    chunks.push({ tokens: chunk, volume: getCoingeckoMarket(chainId, chunk) })
  }

  const ids = COINGECKO_IDS_MAP[COINGECKO_CHAINS[chainId]]
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

export async function fetchAndProcessCoingeckoTokens(chainId: number): Promise<void> {
  try {
    COINGECKO_IDS_MAP = Object.keys(COINGECKO_IDS_MAP).length ? COINGECKO_IDS_MAP : await getCoingeckoTokenIdsMap()
    const tokens = await getTokenList(chainId)
    const topTokens = (await getTokenVolumes(chainId, tokens)).slice(0, TOP_TOKENS_COUNT)

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
