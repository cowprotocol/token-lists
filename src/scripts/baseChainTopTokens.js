import assert from 'assert'
import fetch from 'node-fetch'
import fs from 'fs'
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
    major: 1,
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

    // Write token file
    const newTokenList = {
      ...TOKEN_LIST_INFO,
      timestamp: new Date().toISOString(),
      tokens: topTokens.map(({ token }) => token),
    }

    // Write token list to file
    const tokenListPath = path.join('src/public/CoinGecko.8453.json')
    fs.writeFileSync(tokenListPath, JSON.stringify(newTokenList, null, 2))
    console.log(`Token list written to ${tokenListPath}`)
  } catch (error) {
    console.error('Error fetching data:', error)
  }
}

main()
