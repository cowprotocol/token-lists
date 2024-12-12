import { COINGECKO_CHAINS, TOP_TOKENS_COUNT, VS_CURRENCY, fetchWithApiKey, processTokenList } from './utils.js'

const COINGECKO_CHAINS_NAMES = Object.values(COINGECKO_CHAINS)
let COINGECKO_IDS_MAP = {}

function getCoingeckoApiUrl(chain) {
  return `https://pro-api.coingecko.com/api/v3/coins/${COINGECKO_CHAINS[chain]}/contract`
}

function getTokenListUrl(chain) {
  return `https://tokens.coingecko.com/${COINGECKO_CHAINS[chain]}/all.json`
}

async function getTokenList(chain) {
  const data = await fetchWithApiKey(getTokenListUrl(chain))
  return data.tokens
}

async function getCoingeckoTokenIds() {
  try {
    return await fetchWithApiKey('https://pro-api.coingecko.com/api/v3/coins/list?include_platform=true&status=active')
  } catch (error) {
    console.error(`Error fetching Coingecko's coin list`, error)
    return []
  }
}

export async function getCoingeckoTokenIdsMap() {
  let tokenIdsMap = COINGECKO_CHAINS_NAMES.reduce((acc, name) => ({ ...acc, [name]: {} }), {})

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

async function getCoingeckoMarket(chainId, tokens) {
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

async function getTokenVolumes(chainId, tokens) {
  const chunkSize = 250
  const chunks = []

  for (let i = 0; i < tokens.length; i += chunkSize) {
    const chunk = tokens.slice(i, i + chunkSize)
    chunks.push({ tokens: chunk, volume: getCoingeckoMarket(chainId, chunk) })
  }

  const ids = COINGECKO_IDS_MAP[COINGECKO_CHAINS[chainId]]
  const volumes = await Promise.all(
    chunks.map(async ({ tokens, volume }) => {
      const volumeData = await volume
      const volumeMap = volumeData.reduce((acc, cur) => {
        if (cur.total_volume && ids[cur.id]) {
          acc[ids[cur.id]] = cur.total_volume
        }
        return acc
      }, {})

      return tokens.reduce((acc, token) => {
        if (volumeMap[token.address]) {
          acc.push({ token, volume: volumeMap[token.address] })
        }
        return acc
      }, [])
    }),
  )

  return volumes.flat().sort((a, b) => b.volume - a.volume)
}

export async function fetchAndProcessCoingeckoTokens(chainId) {
  try {
    COINGECKO_IDS_MAP = Object.keys(COINGECKO_IDS_MAP).length || (await getCoingeckoTokenIdsMap())
    const tokens = await getTokenList(chainId)
    const topTokens = (await getTokenVolumes(chainId, tokens)).slice(0, TOP_TOKENS_COUNT)

    await processTokenList({
      chainId,
      tokens: topTokens,
      prefix: 'CoinGecko',
      logMessage: `Top ${TOP_TOKENS_COUNT} tokens`,
    })
  } catch (error) {
    console.error(`Error fetching data for chain ${chainId}:`, error)
  }
}
