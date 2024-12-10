import assert from 'assert'
import fs from 'fs'
import fetch from 'node-fetch'
import path from 'path'

const TOP_TOKENS_COUNT = 500 // Number of top tokens to display

const VS_CURRENCY = 'usd' // Base currency for volume data

let COINGECKO_IDS_MAP = {}

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

const COINGECKO_API_KEY = process.env.COINGECKO_API_KEY
assert(COINGECKO_API_KEY, 'COINGECKO_API_KEY env is required')

function getCoingeckoApiUrl(chain) {
  return `https://pro-api.coingecko.com/api/v3/coins/${COINGECKO_CHAINS[chain]}/contract`
}

function getTokenListUrl(chain) {
  return `https://tokens.coingecko.com/${COINGECKO_CHAINS[chain]}/all.json`
}

function getListName(chain, count) {
  return `Coingecko top ${count} on ${DISPLAY_CHAIN_NAMES[chain]}`
}

function getEmptyList() {
  return {
    name: `Coingecko`,
    logoURI:
      'https://static.coingecko.com/s/thumbnail-007177f3eca19695592f0b8b0eabbdae282b54154e1be912285c9034ea6cbaf2.png',
    keywords: ['defi'],
    version: {
      major: 0,
      minor: 0,
      patch: 0,
    },
  }
}

async function getTokenList(chain) {
  const tokenListUrl = getTokenListUrl(chain)
  const response = await fetch(tokenListUrl)
  const data = await response.json()
  return data.tokens
}

async function getTokenVolume(token, chain) {
  try {
    const headers = COINGECKO_API_KEY ? { 'X-Cg-Pro-Api-Key': COINGECKO_API_KEY } : {}

    const url = `${getCoingeckoApiUrl(chain)}/${token.address}?localization=false`
    const response = await fetch(url, { headers })
    const data = await response.json()

    return data.market_data.total_volume[VS_CURRENCY] || 0
  } catch (error) {
    console.error(`Error fetching volume for token ${token.name} on chain ${chain}:`, error)
    return 0
  }
}

async function getCoingeckoTokenIds() {
  try {
    const headers = COINGECKO_API_KEY ? { 'X-Cg-Pro-Api-Key': COINGECKO_API_KEY } : {}

    const url = `https://pro-api.coingecko.com/api/v3/coins/list?include_platform=true&status=active`
    const response = await fetch(url, { headers })
    return await response.json()
  } catch (error) {
    console.error(`Error fetching Coingecko's coin list`, error)
    return []
  }
}

/**
 * Get a map of contract addresses to coingecko coin id.
 *
 * Result is stored in a local file since this shouldn't change often.
 *
 * Takes in one parameter forceUpdate, to ignore local content - if any.
 */
async function getCoingeckoTokenIdsMap(forceUpdate) {
  const localFilePath = 'build/coingeckoTokenIdsMap.json'
  let tokenIdsMap = COINGECKO_CHAINS_NAMES.reduce((acc, name) => ({ ...acc, [name]: {} }), {})

  // Check if local file exists and forceUpdate is false
  if (!forceUpdate && fs.existsSync(localFilePath)) {
    try {
      // Read the local file
      const data = fs.readFileSync(localFilePath)
      tokenIdsMap = JSON.parse(data)
    } catch (error) {
      console.error(`Error reading local file: ${error}`)
    }
  } else {
    // Fetch the token IDs from Coingecko API
    try {
      const tokenIds = await getCoingeckoTokenIds()

      tokenIds.forEach((token) => {
        COINGECKO_CHAINS_NAMES.forEach((chain) => {
          const address = token.platforms[chain]
          if (address) {
            tokenIdsMap[chain][address] = token.id
            // reverse mapping
            tokenIdsMap[chain][token.id] = address
          }
        })
      })

      // Save the fetched data to the local file
      fs.writeFileSync(localFilePath, JSON.stringify(tokenIdsMap))
    } catch (error) {
      console.error(`Error fetching Coingecko token IDs: ${error}`)
    }
  }

  return tokenIdsMap
}

async function getCoingeckoMarket(chainId, tokens) {
  const coingeckoIdsForChain = COINGECKO_IDS_MAP[COINGECKO_CHAINS[chainId]]
  const ids = tokens.reduce((acc, token) => {
    const coingeckoId = coingeckoIdsForChain[token.address]
    if (coingeckoId) {
      acc += `${coingeckoId},`
    }
    return acc
  }, '')

  try {
    const headers = COINGECKO_API_KEY ? { 'X-Cg-Pro-Api-Key': COINGECKO_API_KEY } : {}

    const url = `https://pro-api.coingecko.com/api/v3/coins/markets?vs_currency=${VS_CURRENCY}&per_page=250&ids=${ids}`
    const response = await fetch(url, { headers })
    return await response.json()
  } catch (error) {
    console.error(`Error fetching Coingecko's coin list`, error)
    return []
  }
}

async function getTokenVolumes(chainId, tokens) {
  // Max items per query is 250
  const chunkSize = 250
  const chunkVolumes = []

  // Chunk tokens for each individual query
  for (let i = 0; i < tokens.length; i += chunkSize) {
    const chunk = tokens.slice(i, i + chunkSize)
    chunkVolumes.push({ tokens: chunk, volume: getCoingeckoMarket(chainId, chunk) })
  }

  const ids = COINGECKO_IDS_MAP[COINGECKO_CHAINS[chainId]]

  const volumes = await Promise.all(
    chunkVolumes.map(async ({ tokens, volume }) => {
      // Await query in parallel
      const volumeData = await volume
      // Create a map with volumes since the ordering is lost
      const volumeMap = volumeData.reduce((acc, cur) => {
        if (cur.total_volume && ids[cur.id]) {
          acc[ids[cur.id]] = cur.total_volume || 0
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

  // Flatten and sort volumes by volume in descending order
  return volumes.flat().sort((a, b) => b.volume - a.volume)
}

async function fetchAndProcessTokens(chainId) {
  try {
    // Get coingecko ids
    COINGECKO_IDS_MAP = await getCoingeckoTokenIdsMap()

    // Fetch tokens
    const tokens = await getTokenList(chainId)

    // Fetch volume for each token
    // const tokenVolumes = await Promise.all(
    //   tokens.map(async (token) => ({
    //     token,
    //     volume: await getTokenVolume(token, chainId),
    //   })),
    // )

    // Sort by volume and pick top tokens
    // const topTokens = tokenVolumes.sort((a, b) => b.volume - a.volume).slice(0, TOP_TOKENS_COUNT)
    const topTokens = (await getTokenVolumes(chainId, tokens)).slice(0, TOP_TOKENS_COUNT)

    // Print top tokens
    let position = 1
    console.log(`🥇 Top ${TOP_TOKENS_COUNT} tokens on chain ${chainId}`)
    for (const { token, volume } of topTokens) {
      console.log(`\t-${position.toString().padStart(3, '0')}) ${token.name} (${token.symbol}): $${volume}`)
      position++
    }

    const tokenListPath = path.join(`src/public/CoinGecko.${chainId}.json`)

    const tokenList = getLocalTokenList(tokenListPath, getEmptyList())

    // Replace tokens
    tokenList.tokens = topTokens.map(({ token }) => ({
      ...token,
      logoURI: token.logoURI ? token.logoURI.replace(/thumb/, 'large') : undefined,
    }))
    tokenList.name = getListName(chainId, tokenList.tokens.length)

    // Write token file
    saveLocalTokenList(tokenListPath, tokenList)
  } catch (error) {
    console.error(`Error fetching data for chain ${chainId}:`, error)
  }
}

async function main() {
  // Fetch tokens for all chains
  Object.keys(COINGECKO_CHAINS).forEach((chain) => fetchAndProcessTokens(chain))
}

/**
 * Given a listPath with the relative path to the local token list, try to load it.
 * Return the loaded list if it's found, return the defaultEmptyList otherwise
 */
function getLocalTokenList(listPath, defaultEmptyList) {
  try {
    const listData = fs.readFileSync(listPath, 'utf8')
    return JSON.parse(listData)
  } catch (error) {
    console.error(`Error reading token list from ${listPath}:`, error)
    return defaultEmptyList
  }
}

/**
 * Given a listPath and a list object, write the list to the specified listPath.
 * List version.major is incremented, and timestamp is set to current ISO date, in UTC.
 */
function saveLocalTokenList(listPath, list) {
  try {
    // Set default values for required fields if they are missing
    list.version = list.version || { major: 0, minor: 0, patch: 0 }
    // Increment the major version
    list.version.major += 1
    // Set the timestamp to the current ISO date in UTC
    list.timestamp = new Date().toISOString()
    // Convert the list object to a JSON string
    const listJSON = JSON.stringify(list, null, 2)
    // Write the JSON string to the specified file path
    fs.writeFileSync(listPath, listJSON)
    console.log(`Token list saved to ${listPath}`)
  } catch (error) {
    console.error(`Error saving token list to ${listPath}:`, error)
  }
}

main()
