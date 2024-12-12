import assert from 'assert'
import fs from 'fs'
import fetch from 'node-fetch'
import path from 'path'

const TOP_TOKENS_COUNT = 500 // Number of top tokens to display

const VS_CURRENCY = 'usd' // Base currency for volume data

const UNISWAP_LIST = 'https://gateway.ipfs.io/ipns/tokens.uniswap.org'

async function getUniswapTokens() {
  const response = await fetch(UNISWAP_LIST)
  const list = await response.json()
  return list.tokens
}

const COINGECKO_API_KEY = process.env.COINGECKO_API_KEY
assert(COINGECKO_API_KEY, 'COINGECKO_API_KEY env is required')

const COINGECKO_CHAINS = {
  1: 'ethereum',
  100: 'xdai',
  8453: 'base',
  42161: 'arbitrum-one',
}

const DISPLAY_CHAIN_NAMES = {
  1: 'Ethereum',
  100: 'Gnosis chain',
  8453: 'Base',
  42161: 'Arbitrum one',
}

const COINGECKO_CHAINS_NAMES = Object.values(COINGECKO_CHAINS)
let COINGECKO_IDS_MAP = {}

function getCoingeckoApiUrl(chain) {
  return `https://pro-api.coingecko.com/api/v3/coins/${COINGECKO_CHAINS[chain]}/contract`
}

function getTokenListUrl(chain) {
  return `https://tokens.coingecko.com/${COINGECKO_CHAINS[chain]}/all.json`
}

async function fetchWithApiKey(url) {
  const headers = COINGECKO_API_KEY ? { 'X-Cg-Pro-Api-Key': COINGECKO_API_KEY } : {}
  const response = await fetch(url, { headers })
  return response.json()
}

function getEmptyList() {
  return {
    name: 'Coingecko',
    logoURI:
      'https://static.coingecko.com/s/thumbnail-007177f3eca19695592f0b8b0eabbdae282b54154e1be912285c9034ea6cbaf2.png',
    keywords: ['defi'],
    version: { major: 0, minor: 0, patch: 0 },
  }
}

function getListName(chain, prefix, count) {
  return `${prefix}${count ? ` top ${count}` : ''} on ${DISPLAY_CHAIN_NAMES[chain]}`
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

async function getCoingeckoTokenIdsMap() {
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

function getLocalTokenList(listPath, defaultEmptyList) {
  try {
    return JSON.parse(fs.readFileSync(listPath, 'utf8'))
  } catch (error) {
    console.warn(`Error reading token list from ${listPath}:`, error)
    return defaultEmptyList
  }
}

function saveLocalTokenList(listPath, list) {
  try {
    list.version = list.version || { major: 0, minor: 0, patch: 0 }
    list.version.major += 1
    list.timestamp = new Date().toISOString()
    fs.writeFileSync(listPath, JSON.stringify(list, null, 2))
    console.log(`Token list saved to ${listPath}`)
  } catch (error) {
    console.error(`Error saving token list to ${listPath}:`, error)
  }
}

function getOutputPath(prefix, chainId) {
  return `src/public/${prefix}.${chainId}.json`
}

async function processTokenList({ chainId, tokens, prefix, logMessage }) {
  const count = tokens.length
  console.log(`🥇 ${logMessage} on chain ${chainId}`)
  tokens.forEach((token, index) => {
    const volumeStr = token.volume ? `: $${token.volume}` : ''
    console.log(`\t-${(index + 1).toString().padStart(3, '0')}) ${token.name} (${token.symbol})${volumeStr}`)
  })

  const tokenListPath = path.join(getOutputPath(prefix, chainId))
  const tokenList = getLocalTokenList(tokenListPath, getEmptyList())

  tokenList.tokens = tokens.map((token) => ({
    ...token,
    logoURI: token.logoURI ? token.logoURI.replace(/thumb/, 'large') : undefined,
  }))
  tokenList.name = getListName(chainId, prefix, count)

  saveLocalTokenList(tokenListPath, tokenList)
}

async function fetchAndProcessCoingeckoTokens(chainId) {
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

async function mapUniMainnetToChainTokens(chain, uniTokens, coingeckoTokensForChain) {
  const mainnetTokens = []
  const chainTokens = {}

  // Split uni tokens into mainnet and chain
  uniTokens.forEach((token) => {
    if (token.chainId === +chain) {
      // Chain tokens already have all the details
      chainTokens[token.address.toLowerCase()] = token
    } else if (token.chainId === 1) {
      // We'll need to get the address and details for mainnet tokens
      mainnetTokens.push(token)
    }
  })

  // Create a map with coingecko tokes for chain for easier access
  const coingeckoTokensMap = coingeckoTokensForChain.reduce((acc, token) => {
    acc[token.address.toLowerCase()] = token
    return acc
  }, {})

  // For each mainnet token
  mainnetTokens.forEach((token) => {
    // See if there's a corresponding coingecko id
    const coingeckoId = COINGECKO_IDS_MAP[COINGECKO_CHAINS['1']][token.address.toLowerCase()]
    if (coingeckoId) {
      // If there is, try to find the corresponding chain token address
      const chainAddress = COINGECKO_IDS_MAP[COINGECKO_CHAINS[chain]][coingeckoId]
      if (!chainTokens[chainAddress]) {
        // If that's not already in uni's list, try to get it from coingecko's chain list
        const cgToken = coingeckoTokensMap[chainAddress]
        if (cgToken) {
          // If it is, add it to the output map
          chainTokens[chainAddress] = cgToken
        }
      }
    }
  })

  return Object.values(chainTokens)
}

async function fetchAndProcessUniswapTokens(chainId) {
  try {
    COINGECKO_IDS_MAP = Object.keys(COINGECKO_IDS_MAP).length || (await getCoingeckoTokenIdsMap())
    // TODO: cache uniTokens and coingeckoTokens in memory
    const uniTokens = await getUniswapTokens()
    const coingeckoTokens = await getTokenList(chainId)

    const tokens = await mapUniMainnetToChainTokens(chainId, uniTokens, coingeckoTokens)

    await processTokenList({
      chainId,
      tokens,
      prefix: 'Uniswap',
      logMessage: `Uniswap tokens`,
    })
  } catch (error) {
    console.error(`Error fetching data for chain ${chainId}:`, error)
  }
}

async function main() {
  Object.keys(COINGECKO_CHAINS).forEach((chain) => fetchAndProcessCoingeckoTokens(chain))
  Object.keys(COINGECKO_CHAINS)
    .filter((chain) => chain != 1) // No need to create a list for mainnet
    .forEach((chain) => fetchAndProcessUniswapTokens(chain))
}

main()
