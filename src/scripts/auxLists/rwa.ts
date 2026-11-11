import { getAddressKey, isEvmAddress, isSolanaAddress, SupportedChainId } from '@cowprotocol/cow-sdk'
import { existsSync } from 'fs'
import { processTokenList } from './processTokenList.js'
import { COINGECKO_API_KEY, COINGECKO_CHAINS, DISPLAY_CHAIN_NAMES, getLogger, TokenInfo } from './utils.js'

/**
 * Builds `CoinGeckoRwa.<chainId>.json`: every tokenized real-world asset CoinGecko knows about, on each chain CoW
 * supports, from any issuer. Biggest token market cap first.
 *
 * Sources:
 * - the RWA API (https://docs.coingecko.com/reference/rwa-overview): stocks, ETFs and commodities, with issuers
 * - `RWA_CATEGORIES`: what the RWA API misses, such as treasuries, money market funds, credit and non-US stocks.
 *   Category queries skip coins without market data, which is fine: CoW can't trade them without liquidity anyway
 */

export const RWA_PREFIX = 'CoinGeckoRwa'
const RWA_LOGO = 'https://support.coingecko.com/hc/article_attachments/4499575478169/CoinGecko_logo.png'
const API_URL = 'https://pro-api.coingecko.com/api/v3'
const PAGE_SIZE = 250
const CONCURRENCY = 8
const MAX_RETRIES = 5

/**
 * CoinGecko category -> asset type of its coins. A coin in several categories takes the type of the first one.
 *
 * Only categories of asset tokens: the broad `real-world-assets-rwa`, `tokenized-products`, `rwa-protocol` and
 * `real-estate` categories also hold protocol and governance tokens (LINK, ONDO, Propy...), and
 * `yield-bearing-stablecoins` holds DeFi stablecoins (sUSDe, sUSDS...).
 */
export const RWA_CATEGORIES: Record<string, string> = {
  'tokenized-stock': 'stock',
  'tokenized-pre-ipo-stocks': 'stock',
  'republic-tokenized-pre-ipo-assets': 'stock',
  'tessera-tokenized-pre-ipo-assets': 'stock',
  'tokenized-exchange-traded-funds-etfs': 'etf',
  'tokenized-exchange-traded-product-etps': 'etf',
  'tokenized-closed-end-funds-cefs': 'etf',
  'tokenized-commodity-exchange-traded-products-etps': 'commodity',
  'tokenized-commodities': 'commodity',
  'tokenized-gold': 'commodity',
  'tokenized-silver': 'commodity',
  'tokenized-uranium': 'commodity',
  'commodity-backed-stablecoin': 'commodity',
  'tokenized-treasuries': 'bond',
  'tokenized-t-bills': 'bond',
  'tokenized-non-us-government-securities': 'bond',
  'tokenized-money-market-fund-mmfs': 'fund',
  'tokenized-credit': 'credit',
  'tokenized-private-credit': 'credit',
  'tokenized-bank-deposit': 'deposit',
  // Issuer ecosystems, for their tokens CoinGecko has not classified yet
  'xstocks-ecosystem': 'other',
  'bstocks-ecosystem': 'other',
  'backpack-securities-ecosystem': 'other',
  'ondo-tokenized-assets': 'other',
  'remora-markets-tokenized-rstocks': 'other',
  'securitize-ecosystem': 'other',
  'prestocks-ecosystem': 'other',
}

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

interface CoinListItem {
  id: string
  symbol: string
  name: string
  platforms?: Record<string, string | null>
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

interface RwaCoin {
  id: string
  symbol: string
  name: string
  platforms: Record<string, string | null>
  assetType: string
  issuer?: string
}

interface RwaTokenInfo extends TokenInfo {
  marketCap: number
}

export async function fetchAndProcessRwaTokens(): Promise<void> {
  const startedAt = Date.now()
  const logger = getLogger('rwa-tokens')
  const chains = (Object.keys(COINGECKO_CHAINS).map(Number) as SupportedChainId[]).filter(
    (chainId) => COINGECKO_CHAINS[chainId],
  )
  log(`Generating RWA lists for ${chains.map((chainId) => DISPLAY_CHAIN_NAMES[chainId]).join(', ')}`)

  // Any failed RWA or category request aborts the run, otherwise its tokens would be dropped from the lists
  const [rwaCoins, coinList] = await Promise.all([fetchRwaApiCoins(), fetchCoinList()])
  const categoryCoins = await fetchCategoryCoins(coinList)
  const rwaIds = new Set(rwaCoins.map((coin) => coin.id))
  const extraCoins = categoryCoins.coins.filter((coin) => !rwaIds.has(coin.id))
  const coins = [...rwaCoins, ...extraCoins]
  log(`${rwaCoins.length} RWA API tokens and ${extraCoins.length} more from categories`)

  const markets = new Map([
    ...categoryCoins.markets,
    ...(await fetchCoinMarkets([...rwaIds].filter((id) => !categoryCoins.markets.has(id)))),
  ])

  log('Building token lists')

  // All lists are built before any is written, so a failed request can't leave some chains updated and others not
  const lists = await Promise.all(
    chains.map(async (chainId) => ({ chainId, tokens: await buildChainTokens(chainId, coins, markets) })),
  )

  for (const { chainId, tokens } of lists) {
    if (!tokens.length) {
      // The token list schema requires at least one token, and the aux lists workflow can't delete a file
      if (existsSync(getRwaListPath(chainId))) {
        console.warn(`[rwa] ${DISPLAY_CHAIN_NAMES[chainId]} has no RWA tokens anymore, keeping its previous list`)
      }
      continue
    }

    await processTokenList({
      chainId,
      tokens: tokens.map(({ marketCap, ...token }) => ({ ...token, volume: marketCap })),
      prefix: RWA_PREFIX,
      logo: RWA_LOGO,
      keywords: ['rwa', 'coingecko'],
      // The token list schema limits names to 30 characters
      title: 'RWA',
      logMessage: `RWA tokens by market cap`,
      logger,
    })
  }

  log(`Done in ${Math.round((Date.now() - startedAt) / 1000)}s`)
}

function getRwaListPath(chainId: SupportedChainId): string {
  return `src/public/${RWA_PREFIX}.${chainId}.json`
}

/** RWA tokens of a chain, biggest market cap first */
async function buildChainTokens(
  chainId: SupportedChainId,
  coins: RwaCoin[],
  markets: Map<string, CoinMarket>,
): Promise<RwaTokenInfo[]> {
  const chainName = DISPLAY_CHAIN_NAMES[chainId]
  const platform = COINGECKO_CHAINS[chainId] as string
  const listed = await fetchCoingeckoTokenList(platform)
  const tokens = new Map<string, RwaTokenInfo>()
  const candidates = coins.filter((coin) => coin.platforms[platform])
  let skipped = 0
  let fromDetails = 0

  log(`${chainName}: ${candidates.length} candidate tokens, ${listed.size} tokens in CoinGecko's ${platform} list`)

  for (const coin of candidates) {
    const address = coin.platforms[platform] as string

    if (!isChainAddress(chainId, address)) {
      skipped++
      continue
    }

    const key = getAddressKey(address)

    if (tokens.has(key)) continue

    if (!listed.has(key)) fromDetails++

    const info = await buildToken({ chainId, platform, key, coin, listed, market: markets.get(coin.id) })

    if (info) tokens.set(key, info)
    else skipped++
  }

  const sorted = [...tokens.values()].sort((a, b) => b.marketCap - a.marketCap || a.address.localeCompare(b.address))

  log(`${chainName}: ${sorted.length} tokens (${fromDetails} looked up in coin details, ${skipped} skipped)`)

  return sorted
}

async function fetchRwaApiCoins(): Promise<RwaCoin[]> {
  const list = await coingecko<RwaListItem[]>('/rwas/list')

  log(`Fetching tokens of ${list.length} RWAs`)

  const rwas = await mapConcurrent(
    list,
    (rwa) => coingecko<RwaDetails>(`/rwas/${encodeURIComponent(rwa.id)}?tokens=true`),
    'RWA details',
  )

  return rwas.flatMap((rwa) =>
    (rwa.tokens ?? []).map((token) => ({
      id: token.id,
      symbol: token.symbol,
      name: token.name,
      platforms: token.platforms ?? {},
      assetType: rwa.asset_type,
      issuer: token.issuer_details?.name,
    })),
  )
}

async function fetchCoinList(): Promise<CoinListItem[]> {
  const coinList = await coingecko<CoinListItem[]>('/coins/list?include_platform=true')

  log(`Fetched ${coinList.length} coins with their platforms`)

  return coinList
}

/** Coins of `RWA_CATEGORIES`, with their market data, which `/coins/markets` answers along with the category */
async function fetchCategoryCoins(
  coinList: CoinListItem[],
): Promise<{ coins: RwaCoin[]; markets: Map<string, CoinMarket> }> {
  const categories = Object.keys(RWA_CATEGORIES)

  log(`Fetching coins of ${categories.length} categories`)

  const categoryMarkets = await mapConcurrent(categories, fetchCategoryMarkets, 'Categories')
  const platformsById = new Map(coinList.map((coin) => [coin.id, coin]))
  const coins = new Map<string, RwaCoin>()
  const markets = new Map<string, CoinMarket>()

  categories.forEach((category, index) => {
    for (const market of categoryMarkets[index]) {
      markets.set(market.id, market)

      const coin = platformsById.get(market.id)

      if (!coin || coins.has(coin.id)) continue

      coins.set(coin.id, {
        id: coin.id,
        symbol: coin.symbol,
        name: coin.name,
        platforms: coin.platforms ?? {},
        assetType: RWA_CATEGORIES[category],
      })
    }
  })

  return { coins: [...coins.values()], markets }
}

async function fetchCategoryMarkets(category: string): Promise<CoinMarket[]> {
  const coins: CoinMarket[] = []

  for (let page = 1; ; page++) {
    const items = await coingecko<CoinMarket[]>(
      `/coins/markets?vs_currency=usd&category=${encodeURIComponent(category)}&per_page=${PAGE_SIZE}&page=${page}`,
    )

    coins.push(...items)

    if (items.length < PAGE_SIZE) {
      log(`Category ${category}: ${coins.length} coins`)
      return coins
    }
  }
}

interface BuildTokenParams {
  chainId: SupportedChainId
  platform: string
  key: string
  coin: RwaCoin
  listed: Map<string, TokenInfo>
  market: CoinMarket | undefined
}

async function buildToken({
  chainId,
  platform,
  key,
  coin,
  listed,
  market,
}: BuildTokenParams): Promise<RwaTokenInfo | null> {
  const fromList = listed.get(key)
  const details = fromList ? undefined : await fetchCoinDetails(coin.id)
  const decimals = fromList?.decimals ?? details?.detail_platforms?.[platform]?.decimal_place

  if (!Number.isInteger(decimals) || (decimals as number) < 0) {
    console.warn(`Skipping RWA token ${coin.id} on ${platform}: unknown decimals`)
    return null
  }

  return {
    chainId,
    address: key,
    name: fromList?.name ?? coin.name,
    symbol: fromList?.symbol ?? coin.symbol.toUpperCase(),
    decimals: decimals as number,
    logoURI: toLogoUrl(market?.image) ?? toLogoUrl(fromList?.logoURI) ?? toLogoUrl(details?.image?.large),
    // The token list schema limits extension strings to 42 characters, too short for CoinGecko ids
    extensions: Object.fromEntries(
      Object.entries({ assetType: coin.assetType, issuer: coin.issuer }).filter(
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

  log(`Fetching market data of ${ids.length} coins`)

  const results = await mapConcurrent(
    batches,
    (batch) => coingecko<CoinMarket[]>(`/coins/markets?vs_currency=usd&per_page=${PAGE_SIZE}&ids=${batch.join(',')}`),
    'Market data batches',
  )

  return new Map(results.flat().map((coin) => [coin.id, coin]))
}

const coinDetails = new Map<string, Promise<CoinDetails | undefined>>()

function fetchCoinDetails(id: string): Promise<CoinDetails | undefined> {
  if (!coinDetails.has(id)) {
    const path = `/coins/${encodeURIComponent(
      id,
    )}?localization=false&tickers=false&market_data=false&community_data=false&developer_data=false`

    coinDetails.set(
      id,
      // A coin CoinGecko doesn't know is skipped. Any other failure aborts the run, so it can't drop the token
      coingecko<CoinDetails>(path).catch((error) => {
        if (!(error instanceof HttpError && error.status === 404)) throw error

        console.warn(`CoinGecko coin ${id} not found`)
        return undefined
      }),
    )
  }

  return coinDetails.get(id) as Promise<CoinDetails | undefined>
}

class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
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

      const delay = 2 ** attempt * 1000
      log(`${label} failed (${error instanceof Error ? error.message : error}), retry ${attempt + 1} in ${delay}ms`)
      await sleep(delay)
      continue
    }

    if ((response.status === 429 || response.status >= 500) && attempt < MAX_RETRIES) {
      const retryAfter = Number(response.headers?.get('retry-after'))
      const delay = retryAfter > 0 ? retryAfter * 1000 : 2 ** attempt * 1000
      log(`${label} responded with ${response.status}, retry ${attempt + 1} in ${delay}ms`)
      await sleep(delay)
      continue
    }

    if (!response.ok) throw new HttpError(`${label} responded with ${response.status}`, response.status)

    return response.json() as Promise<T>
  }
}

/** With `progressLabel`, logs the progress at every 10% */
async function mapConcurrent<T, R>(items: T[], fn: (item: T) => Promise<R>, progressLabel?: string): Promise<R[]> {
  const results = new Array<R>(items.length)
  const step = Math.max(1, Math.ceil(items.length / 10))
  let next = 0
  let done = 0

  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next++
      results[index] = await fn(items[index])
      done++

      if (progressLabel && (done % step === 0 || done === items.length)) {
        log(`${progressLabel}: ${done}/${items.length} (${Math.round((done / items.length) * 100)}%)`)
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker))

  return results
}

function log(message: string): void {
  console.log(`[rwa] ${message}`)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
