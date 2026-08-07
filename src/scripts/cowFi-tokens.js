import fs from 'fs'
import path from 'path'

import pThrottle from 'p-throttle'

const COINGECKO_API_KEY = process.env.COINGECKO_API_KEY
const COINGECKO_API_BASE = 'https://pro-api.coingecko.com/api/v3'

const cowListUrl = 'https://files.cow.fi/tokens/CowSwap.json'

const LIST_DIR = path.join('src', 'cowFi')
const CUSTOM_DESCRIPTION_PATH = path.join('src', 'files', 'description.json')

const IDS_FILE_NAME_FINAL = 'cowFi-tokenIds.json'
const STATIC_LIST_NAME_FINAL = 'cowFi-tokens.json'

const TOTAL_LIST_LENGTH = 50
// Fetch a few extra top-ranked candidates in case some get dropped below (denylisted or missing a description),
// so the final list can still reach TOTAL_LIST_LENGTH without a second round-trip.
const DETAIL_FETCH_BUFFER = 20
const MARKET_API_CHUNK_SIZE = 250
const COINGECKO_REQUESTS_PER_MINUTE = 25
const COINGECKO_RETRIES = 2
const MAX_RETRY_AFTER_MS = 10_000

const TOKENS_TO_REMOVE = ['agave-token', 'fraction', 'minerva-wallet']

// cow.fi's showcase list only cares about tokens on these two networks (CoinGecko platform names)
const RELEVANT_CHAINS = { 1: 'ethereum', 100: 'xdai' }

async function fetchJson(url) {
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`Error fetching ${url}: ${res.status}`)
  }
  return res.json()
}

const throttledFetch = pThrottle({ limit: COINGECKO_REQUESTS_PER_MINUTE, interval: 60_000 })(fetch)

function getRetryDelay(retryAfter, attempt) {
  const retryAfterMs = Number(retryAfter) * 1000
  return Number.isFinite(retryAfterMs) && retryAfterMs >= 0
    ? Math.min(retryAfterMs, MAX_RETRY_AFTER_MS)
    : 1000 * 2 ** attempt
}

function isRetryable(error) {
  return error instanceof TypeError || error.status === 429 || (error.status >= 500 && error.status < 600)
}

export async function requestWithRetries(request, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))) {
  for (let attempt = 0; attempt <= COINGECKO_RETRIES; attempt++) {
    try {
      const res = await request()
      if (res.ok) return res.json()

      const error = new Error(`Error fetching CoinGecko: ${res.status}`)
      error.status = res.status
      error.retryAfter = res.headers.get('Retry-After')
      throw error
    } catch (error) {
      if (!isRetryable(error) || attempt === COINGECKO_RETRIES) throw error
      await sleep(getRetryDelay(error.retryAfter, attempt))
    }
  }
}

async function fetchCoingecko(path) {
  const headers = COINGECKO_API_KEY ? { 'X-Cg-Pro-Api-Key': COINGECKO_API_KEY } : undefined
  return requestWithRetries(() => throttledFetch(`${COINGECKO_API_BASE}${path}`, { headers }))
}

function writeFile(dir, filename, input) {
  const data = JSON.stringify(input, null, 4)
  const filePath = path.join(dir, filename)

  console.log(`Writing file ${filePath}, length: ${input.length}`)

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }

  fs.writeFileSync(filePath, data)
}

async function getCowFiAddressesByChain() {
  const { tokens } = await fetchJson(cowListUrl)

  const byChain = {}
  for (const chainId of Object.keys(RELEVANT_CHAINS)) {
    byChain[chainId] = new Set()
  }

  for (const token of tokens) {
    const addresses = byChain[token.chainId]
    if (addresses) {
      addresses.add(token.address.toLowerCase())
    }
  }

  return byChain
}

// Matches CoinGecko's full coin list against cow.fi's own token addresses *before* fetching any
// per-token detail, so we only ever fetch detail for tokens we actually care about.
export function filterCandidates(coingeckoList, cowFiAddressesByChain) {
  const candidates = []

  for (const entry of coingeckoList) {
    if (TOKENS_TO_REMOVE.includes(entry.id)) continue

    for (const [chainId, platformName] of Object.entries(RELEVANT_CHAINS)) {
      const address = entry.platforms?.[platformName]?.toLowerCase()
      if (address && cowFiAddressesByChain[chainId]?.has(address)) {
        candidates.push({ id: entry.id, address })
        break
      }
    }
  }

  return candidates
}

export function sortByMarketCapDesc(candidates, marketCapById) {
  return [...candidates].sort((a, b) => (marketCapById.get(b.id) ?? 0) - (marketCapById.get(a.id) ?? 0))
}

async function rankByMarketCap(candidates) {
  const ids = candidates.map(({ id }) => id)
  const chunks = []
  for (let index = 0; index < ids.length; index += MARKET_API_CHUNK_SIZE) {
    chunks.push(ids.slice(index, index + MARKET_API_CHUNK_SIZE))
  }

  const pages = await Promise.all(
    chunks.map((ids) =>
      fetchCoingecko(`/coins/markets?vs_currency=usd&per_page=${MARKET_API_CHUNK_SIZE}&ids=${ids.join(',')}`),
    ),
  )

  const marketCapById = new Map(pages.flat().map((coin) => [coin.id, coin.market_cap ?? 0]))
  return sortByMarketCapDesc(candidates, marketCapById)
}

async function getTokenDetails(ids) {
  return Promise.all(
    ids.map((id) =>
      fetchCoingecko(
        `/coins/${id}?localization=false&tickers=false&market_data=true&community_data=false&developer_data=false&sparkline=false`,
      ),
    ),
  )
}

export function trimToUsd(marketData) {
  const trimmed = {}
  for (const [key, value] of Object.entries(marketData ?? {})) {
    trimmed[key] = value && typeof value === 'object' && 'usd' in value ? { usd: value.usd } : value
  }
  return trimmed
}

function readCustomDescriptions() {
  if (!fs.existsSync(CUSTOM_DESCRIPTION_PATH)) return null
  return JSON.parse(fs.readFileSync(CUSTOM_DESCRIPTION_PATH, 'utf8'))
}

function getIdsFinal(data) {
  return data.map(({ name, symbol, address, id, description }) => ({
    id,
    name,
    symbol,
    address,
    description: description.en,
  }))
}

async function main() {
  if (!fs.existsSync(LIST_DIR)) {
    fs.mkdirSync(LIST_DIR)
  }

  const cowFiAddressesByChain = await getCowFiAddressesByChain()

  const coingeckoList = await fetchCoingecko('/coins/list?include_platform=true&status=active')
  const candidates = filterCandidates(coingeckoList, cowFiAddressesByChain)
  console.log(`Candidates after address/platform filter: ${candidates.length}`)

  const ranked = await rankByMarketCap(candidates)
  const topCandidates = ranked.slice(0, TOTAL_LIST_LENGTH + DETAIL_FETCH_BUFFER)
  const addressById = new Map(topCandidates.map(({ id, address }) => [id, address]))

  const details = await getTokenDetails(topCandidates.map(({ id }) => id))
  const customDescriptions = readCustomDescriptions()

  const finalTokens = details
    .map((item) => ({
      ...item,
      market_data: trimToUsd(item.market_data),
      address: addressById.get(item.id),
      description: customDescriptions?.[item.id] ?? item.description,
    }))
    .filter((item) => item.description?.en?.trim().length)
    .slice(0, TOTAL_LIST_LENGTH)

  writeFile(LIST_DIR, STATIC_LIST_NAME_FINAL, finalTokens)

  const idsFinal = getIdsFinal(finalTokens)
  writeFile(LIST_DIR, IDS_FILE_NAME_FINAL, idsFinal)

  console.log('Final output token length', idsFinal.length)
  console.log('Done!!!')
}

if (import.meta.main) {
  main()
}
