import assert from 'assert'
import fs from 'fs'
import fetch from 'node-fetch'
import path from 'path'

const TOP_TOKENS_COUNT = 500 // Number of top tokens to display

const TOKEN_LIST_URL = 'https://tokens.coingecko.com/base/all.json'
const COINGECKO_API_URL = 'https://pro-api.coingecko.com/api/v3/coins/base/contract'
const VS_CURRENCY = 'usd' // Base currency for volume data

const TOKEN_LIST_INFO = {
  name: 'CoinGecko',
  logoURI:
    'https://static.coingecko.com/s/thumbnail-007177f3eca19695592f0b8b0eabbdae282b54154e1be912285c9034ea6cbaf2.png',
  keywords: ['defi'],
  version: {
    major: 0,
    minor: 0,
    patch: 0,
  },
}

const COINGECKO_API_KEY = process.env.COINGECKO_API_KEY
assert(COINGECKO_API_KEY, 'COINGECKO_API_KEY env is required')

async function getTokenList() {
  const response = await fetch(TOKEN_LIST_URL)
  const data = await response.json()
  return data.tokens
}

async function getTokenVolume(token) {
  try {
    const headers = COINGECKO_API_KEY ? { 'X-Cg-Pro-Api-Key': COINGECKO_API_KEY } : {}

    const url = `${COINGECKO_API_URL}/${token.address}?localization=false`
    const response = await fetch(url, { headers })
    const data = await response.json()

    // console.log('[getTokenVolume] url:', url)
    // console.log('[getTokenVolume] token:', token.symbol)
    // console.log(`[getTokenVolume] ${token.symbol} $${data.market_data.total_volume[VS_CURRENCY]}`)
    return data.market_data.total_volume[VS_CURRENCY] || 0
  } catch (error) {
    console.error(`Error fetching volume for token ${token.name}:`, error)
    return 0
  }
}

async function main() {
  try {
    // Fetch tokens
    const tokens = await getTokenList()

    // Fetch volume for each token
    const tokenVolumes = await Promise.all(
      tokens.map(async (token) => ({
        token,
        volume: await getTokenVolume(token),
      })),
    )

    // Sort by volume and pick top tokens
    const topTokens = tokenVolumes.sort((a, b) => b.volume - a.volume).slice(0, TOP_TOKENS_COUNT)

    // Print top tokens
    let position = 1
    console.log(`🥇 Top ${TOP_TOKENS_COUNT} tokens`)
    for (const { token, volume } of topTokens) {
      console.log(`\t-${position.toString().padStart(3, '0')}) ${token.name} (${token.symbol}): $${volume}`)
      position++
    }

    const tokenListPath = path.join('src/public/CoinGecko.8453.json')

    const tokenList = getLocalTokenList(tokenListPath, TOKEN_LIST_INFO)

    // Replace tokens
    tokenList.tokens = topTokens.map(({ token }) => token)

    // Write token file
    saveLocalTokenList(tokenListPath, tokenList)
  } catch (error) {
    console.error('Error fetching data:', error)
  }
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
