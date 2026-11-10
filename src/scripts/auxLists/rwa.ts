import { getAddressKey, isEvmAddress, isSolanaAddress, SupportedChainId } from '@cowprotocol/cow-sdk'
import { processTokenList } from './processTokenList.js'
import { COINGECKO_API_KEY, COINGECKO_CHAINS, DISPLAY_CHAIN_NAMES, getLogger, TokenInfo } from './utils.js'

/**
 * Builds `CoinGeckoRwa.<chainId>.json`: every tokenized real-world asset (stocks, ETFs, commodities) CoinGecko knows
 * about, on each chain CoW supports, from any issuer. Biggest token market cap first.
 *
 * Source: https://docs.coingecko.com/reference/rwa-overview
 */

export const RWA_PREFIX = 'CoinGeckoRwa'
const RWA_LOGO = 'https://support.coingecko.com/hc/article_attachments/4499575478169/CoinGecko_logo.png'
const API_URL = 'https://pro-api.coingecko.com/api/v3'
const PAGE_SIZE = 250
const CONCURRENCY = 8
const MAX_RETRIES = 5

interface RwaListItem {
  id: string
  asset_type: string
}

interface RwaToken {
  id: string
  symbol: string
  name: string
  platforms?: Record<string, string | null>
  issuer_details?: { id: string; name: string } | null
}

interface RwaDetails extends RwaListItem {
  tokens?: RwaToken[]
}

interface CoinMarket {
  id: string
  market_cap: number | null
  image?: string | null
}

interface CoinDetails {
  image?: { large?: string }
  detail_platforms?: Record<string, { decimal_place: number | null } | undefined>
}

interface RwaTokenInfo extends TokenInfo {
  marketCap: number
}

export async function fetchAndProcessRwaTokens(): Promise<void> {
  const logger = getLogger('rwa-tokens')
  const chains = (Object.keys(COINGECKO_CHAINS).map(Number) as SupportedChainId[]).filter(
    (chainId) => COINGECKO_CHAINS[chainId],
  )

  // Any failed RWA request aborts the run, otherwise its tokens would be dropped from the lists
  const rwas = await mapConcurrent(await coingecko<RwaListItem[]>('/rwas/list'), (rwa) =>
    coingecko<RwaDetails>(`/rwas/${encodeURIComponent(rwa.id)}?tokens=true`),
  )
  const coins = rwas.flatMap((rwa) => (rwa.tokens ?? []).map((token) => ({ rwa, token })))
  console.log(`Fetched ${rwas.length} RWAs with ${coins.length} tokens`)

  const markets = await fetchCoinMarkets([...new Set(coins.map(({ token }) => token.id))])

  await Promise.all(
    chains.map(async (chainId) => {
      const platform = COINGECKO_CHAINS[chainId] as string
      const listed = await fetchCoingeckoTokenList(platform)
      const tokens = new Map<string, RwaTokenInfo>()

      for (const { rwa, token } of coins) {
        const address = token.platforms?.[platform]

        if (!address || !isChainAddress(chainId, address)) continue

        const key = getAddressKey(address)

        if (tokens.has(key)) continue

        const info = await buildToken({ chainId, platform, key, rwa, token, listed, market: markets.get(token.id) })

        if (info) tokens.set(key, info)
      }

      const sorted = [...tokens.values()].sort((a, b) => b.marketCap - a.marketCap || a.address.localeCompare(b.address))

      if (!sorted.length) {
        console.log(`No RWA tokens found for ${DISPLAY_CHAIN_NAMES[chainId]}`)
        return
      }

      await processTokenList({
        chainId,
        tokens: sorted.map(({ marketCap, ...token }) => ({ ...token, volume: marketCap })),
        prefix: RWA_PREFIX,
        logo: RWA_LOGO,
        keywords: ['rwa', 'coingecko'],
        // The token list schema limits names to 30 characters
        title: 'RWA',
        logMessage: `RWA tokens by market cap`,
        logger,
      })
    }),
  )
}

interface BuildTokenParams {
  chainId: SupportedChainId
  platform: string
  key: string
  rwa: RwaDetails
  token: RwaToken
  listed: Map<string, TokenInfo>
  market: CoinMarket | undefined
}

async function buildToken({
  chainId,
  platform,
  key,
  rwa,
  token,
  listed,
  market,
}: BuildTokenParams): Promise<RwaTokenInfo | null> {
  const fromList = listed.get(key)
  const details = fromList ? undefined : await fetchCoinDetails(token.id)
  const decimals = fromList?.decimals ?? details?.detail_platforms?.[platform]?.decimal_place

  if (!Number.isInteger(decimals) || (decimals as number) < 0) {
    console.warn(`Skipping RWA token ${token.id} on ${platform}: unknown decimals`)
    return null
  }

  return {
    chainId,
    address: key,
    name: fromList?.name ?? token.name,
    symbol: fromList?.symbol ?? token.symbol.toUpperCase(),
    decimals: decimals as number,
    logoURI: toLogoUrl(market?.image) ?? toLogoUrl(fromList?.logoURI) ?? toLogoUrl(details?.image?.large),
    // The token list schema limits extension strings to 42 characters, too short for CoinGecko ids
    extensions: Object.fromEntries(
      Object.entries({ assetType: rwa.asset_type, issuer: token.issuer_details?.name }).filter(
        (entry): entry is [string, string] => !!entry[1] && entry[1].length <= 42,
      ),
    ),
    marketCap: market?.market_cap ?? 0,
  }
}

function isChainAddress(chainId: SupportedChainId, address: string): boolean {
  return chainId === SupportedChainId.SOLANA ? isSolanaAddress(address) : isEvmAddress(address)
}

/** CoinGecko answers `missing_large.png`, a relative path, for coins without an image */
function toLogoUrl(image: string | null | undefined): string | undefined {
  try {
    return image && new URL(image).protocol === 'https:' ? image : undefined
  } catch {
    return undefined
  }
}

/** Address key -> token, the source of decimals and properly cased symbols */
async function fetchCoingeckoTokenList(platform: string): Promise<Map<string, TokenInfo>> {
  try {
    const list = await request<{ tokens: TokenInfo[] }>(`https://tokens.coingecko.com/${platform}/all.json`)

    return new Map(list.tokens.map((token) => [getAddressKey(token.address), token]))
  } catch (error) {
    console.warn(`No CoinGecko token list for ${platform}, falling back to coin details:`, error)
    return new Map()
  }
}

async function fetchCoinMarkets(ids: string[]): Promise<Map<string, CoinMarket>> {
  const batches: string[][] = []

  for (let i = 0; i < ids.length; i += PAGE_SIZE) batches.push(ids.slice(i, i + PAGE_SIZE))

  const results = await mapConcurrent(batches, (batch) =>
    coingecko<CoinMarket[]>(`/coins/markets?vs_currency=usd&per_page=${PAGE_SIZE}&ids=${batch.join(',')}`),
  )

  return new Map(results.flat().map((coin) => [coin.id, coin]))
}

const coinDetails = new Map<string, Promise<CoinDetails | undefined>>()

function fetchCoinDetails(id: string): Promise<CoinDetails | undefined> {
  if (!coinDetails.has(id)) {
    const path = `/coins/${encodeURIComponent(id)}?localization=false&tickers=false&market_data=false&community_data=false&developer_data=false`

    coinDetails.set(
      id,
      coingecko<CoinDetails>(path).catch((error) => {
        console.warn(`Failed to fetch CoinGecko coin ${id}:`, error)
        return undefined
      }),
    )
  }

  return coinDetails.get(id) as Promise<CoinDetails | undefined>
}

function coingecko<T>(path: string): Promise<T> {
  return request<T>(`${API_URL}${path}`, { 'x-cg-pro-api-key': COINGECKO_API_KEY as string })
}

async function request<T>(url: string, headers: Record<string, string> = {}): Promise<T> {
  const label = url.split('?')[0]

  for (let attempt = 0; ; attempt++) {
    let response: Response

    try {
      response = await fetch(url, { headers: { accept: 'application/json', ...headers } })
    } catch (error) {
      if (attempt >= MAX_RETRIES) throw error

      await sleep(2 ** attempt * 1000)
      continue
    }

    if ((response.status === 429 || response.status >= 500) && attempt < MAX_RETRIES) {
      const retryAfter = Number(response.headers?.get('retry-after'))
      await sleep(retryAfter > 0 ? retryAfter * 1000 : 2 ** attempt * 1000)
      continue
    }

    if (!response.ok) throw new Error(`${label} responded with ${response.status}`)

    return response.json() as Promise<T>
  }
}

async function mapConcurrent<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0

  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next++
      results[index] = await fn(items[index])
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker))

  return results
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
