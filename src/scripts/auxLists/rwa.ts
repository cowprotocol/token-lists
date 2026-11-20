import { getAddressKey, isEvmAddress, isSolanaAddress, SupportedChainId } from '@cowprotocol/cow-sdk'
import { existsSync, readFileSync } from 'fs'
import pThrottle from 'p-throttle'
import { fetchJupiterTokens, getTokenProgramExtensions, hasValidMint } from '../utils/jupiter.js'
import { processTokenList } from './processTokenList.js'
import { COINGECKO_API_KEY, COINGECKO_CHAINS, DISPLAY_CHAIN_NAMES, getLogger, TokenInfo } from './utils.js'

/**
 * Builds `CoinGeckoRwa.<chainId>.json`: every tokenized real-world asset CoinGecko knows about, on each chain CoW
 * supports, from any issuer. Biggest token market cap first.
 *
 * Sources:
 * - Solana token metadata comes from Jupiter, which reads the mint: CoinGecko has wrong decimals for some mints and
 *   doesn't tell Token-2022 mints apart. Mints Jupiter doesn't know are skipped
 * - the RWA API (https://docs.coingecko.com/reference/rwa-overview): stocks, ETFs and commodities, with issuers
 * - `RWA_CATEGORIES`: what the RWA API misses, such as treasuries, money market funds, credit and non-US stocks.
 *   Category queries skip coins without market data, which is fine: CoW can't trade them without liquidity anyway
 * - `rwaSupplement.json`: RWA tokens CoinGecko doesn't know yet, written on demand by `yarn rwaSupplement`
 *   (`rwaSupplement.ts`). CoinGecko's entry wins when both have a token
 */

export const RWA_PREFIX = 'CoinGeckoRwa'
export const RWA_SUPPLEMENT_PATH = new URL('./rwaSupplement.json', import.meta.url)
const RWA_LOGO = 'https://files.cow.fi/token-lists/images/rwa-list-logo.svg'
const API_URL = 'https://pro-api.coingecko.com/api/v3'
const PAGE_SIZE = 250
const MAX_RETRIES = 5
// The Pro plan's 1,000 calls/min are shared by every key of the account: leave most of it to the services using it
const COINGECKO_REQUESTS_PER_MINUTE = 100

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

export async function fetchAndProcessRwaTokens(
  supplement: TokenInfo[] = JSON.parse(readFileSync(RWA_SUPPLEMENT_PATH, 'utf8')),
): Promise<void> {
  // Every token of these lists gets geoblocked: a bad supplement token aborts the run instead of being written
  validateRwaSupplement(supplement)

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
  const lists = await mapSequential(chains, async (chainId) => ({
    chainId,
    tokens: await buildChainTokens(chainId, coins, markets, supplement),
  }))

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

export function getRwaListPath(chainId: SupportedChainId): string {
  return `src/public/${RWA_PREFIX}.${chainId}.json`
}

/** EVM chains only: Solana tokens need the token program check of `buildToken` */
export function isRwaSupplementChain(chainId: number): boolean {
  return !!COINGECKO_CHAINS[chainId as SupportedChainId] && chainId !== SupportedChainId.SOLANA
}

/** Why a supplement token can't be listed, if it can't. CoW Swap rejects a whole list over one invalid token */
export function getRwaSupplementError({ chainId, address, name, symbol, decimals, logoURI }: TokenInfo): string | null {
  if (!isRwaSupplementChain(chainId)) return 'unsupported chain'
  if (!isEvmAddress(address)) return 'invalid address'
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) return 'invalid decimals'
  // The limits of CoW Swap's token list schema
  if (!/^[^<>]{1,100}$/.test(name) || !/^[^<>]{1,80}$/.test(symbol)) return 'invalid name or symbol'
  if (logoURI !== undefined && toLogoUrl(logoURI) !== logoURI) return 'invalid logo'
  return null
}

function validateRwaSupplement(tokens: TokenInfo[]): void {
  const keys = new Set<string>()

  for (const token of tokens) {
    const key = `${token.chainId}:${getAddressKey(token.address)}`
    const error = getRwaSupplementError(token) ?? (keys.has(key) ? 'duplicate' : null)

    if (error) throw new Error(`RWA supplement token ${token.symbol} (${key}): ${error}`)

    keys.add(key)
  }
}

/** RWA tokens of a chain, biggest market cap first, then the supplement tokens CoinGecko doesn't have */
async function buildChainTokens(
  chainId: SupportedChainId,
  coins: RwaCoin[],
  markets: Map<string, CoinMarket>,
  supplement: TokenInfo[],
): Promise<RwaTokenInfo[]> {
  const chainName = DISPLAY_CHAIN_NAMES[chainId]
  const platform = COINGECKO_CHAINS[chainId] as string
  const candidates = coins.filter((coin) => coin.platforms[platform])
  const listed =
    chainId === SupportedChainId.SOLANA
      ? await fetchJupiterTokenList(candidates.map((coin) => coin.platforms[platform] as string))
      : await fetchCoingeckoTokenList(platform)
  const tokens = new Map<string, RwaTokenInfo>()
  let skipped = 0
  let fromDetails = 0

  log(`${chainName}: ${candidates.length} candidate tokens, ${listed.size} tokens with metadata`)

  for (const coin of candidates) {
    const address = coin.platforms[platform] as string

    if (!isChainAddress(chainId, address)) {
      skipped++
      continue
    }

    const key = getAddressKey(address)

    if (tokens.has(key)) continue

    if (!listed.has(key) && chainId !== SupportedChainId.SOLANA) fromDetails++

    const info = await buildToken({ chainId, platform, key, coin, listed, market: markets.get(coin.id) })

    if (info) tokens.set(key, info)
    else skipped++
  }

  let supplemented = 0
  let onCoinGecko = 0

  for (const token of supplement) {
    if (token.chainId !== chainId) continue

    const key = getAddressKey(token.address)

    if (tokens.has(key)) {
      onCoinGecko++
    } else {
      tokens.set(key, { ...token, address: key, marketCap: 0 })
      supplemented++
    }
  }

  const sorted = [...tokens.values()].sort((a, b) => b.marketCap - a.marketCap || a.address.localeCompare(b.address))

  log(
    `${chainName}: ${sorted.length} tokens (${fromDetails} looked up in coin details, ${skipped} skipped, ` +
      `${supplemented} from the supplement)`,
  )

  if (onCoinGecko) {
    log(`${chainName}: ${onCoinGecko} supplement tokens are on CoinGecko now, run \`yarn rwaSupplement\` to drop them`)
  }

  return sorted
}

async function fetchRwaApiCoins(): Promise<RwaCoin[]> {
  const list = await coingecko<RwaListItem[]>('/rwas/list')

  log(`Fetching tokens of ${list.length} RWAs`)

  const rwas = await mapSequential(
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

  const categoryMarkets = await mapSequential(categories, fetchCategoryMarkets, 'Categories')
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

  if (chainId === SupportedChainId.SOLANA && !fromList) {
    // CoinGecko can't tell the token program, and a wrong one reads the user's balance as 0
    console.warn(`Skipping RWA token ${coin.id} on ${platform}: unknown to Jupiter`)
    return null
  }

  const details = fromList ? undefined : await fetchCoinDetails(coin.id)
  const decimals = fromList?.decimals ?? details?.detail_platforms?.[platform]?.decimal_place

  if (!Number.isInteger(decimals) || (decimals as number) < 0) {
    console.warn(`Skipping RWA token ${coin.id} on ${platform}: unknown decimals`)
    return null
  }

  return {
    chainId,
    address: key,
    name: fromList?.name || coin.name,
    symbol: fromList?.symbol || coin.symbol.toUpperCase(),
    decimals: decimals as number,
    logoURI: toLogoUrl(market?.image) ?? toLogoUrl(fromList?.logoURI) ?? toLogoUrl(details?.image?.large),
    // The token list schema limits extension strings to 42 characters, too short for CoinGecko ids
    extensions: {
      ...fromList?.extensions,
      ...Object.fromEntries(
        Object.entries({ assetType: coin.assetType, issuer: coin.issuer }).filter(
          (entry): entry is [string, string] => !!entry[1] && entry[1].length <= 42,
        ),
      ),
    },
    marketCap: market?.market_cap ?? 0,
  }
}

function isChainAddress(chainId: SupportedChainId, address: string): boolean {
  return chainId === SupportedChainId.SOLANA ? isSolanaAddress(address) : isEvmAddress(address)
}

/** CoinGecko answers `missing_large.png`, a relative path, for coins without an image */
export function toLogoUrl(image: string | null | undefined): string | undefined {
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

/** Mint -> token, with `isToken2022` in the extensions of Token-2022 mints */
async function fetchJupiterTokenList(mints: string[]): Promise<Map<string, TokenInfo>> {
  const jupiter = await fetchJupiterTokens(mints)
  const tokens = new Map<string, TokenInfo>()

  for (const token of jupiter.values()) {
    if (!hasValidMint(token)) continue

    const extensions = getTokenProgramExtensions(token)

    tokens.set(getAddressKey(token.id), {
      chainId: SupportedChainId.SOLANA,
      address: token.id,
      name: token.name,
      symbol: token.symbol,
      decimals: token.decimals,
      ...(token.icon ? { logoURI: token.icon } : {}),
      ...(extensions.isToken2022 ? { extensions } : {}),
    })
  }

  return tokens
}

async function fetchCoinMarkets(ids: string[]): Promise<Map<string, CoinMarket>> {
  const batches: string[][] = []

  for (let i = 0; i < ids.length; i += PAGE_SIZE) batches.push(ids.slice(i, i + PAGE_SIZE))

  log(`Fetching market data of ${ids.length} coins`)

  const results = await mapSequential(
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

const throttledRequest = pThrottle({ limit: COINGECKO_REQUESTS_PER_MINUTE, interval: 60_000 })(request)

function coingecko<T>(path: string): Promise<T> {
  return throttledRequest(`${API_URL}${path}`, { 'x-cg-pro-api-key': COINGECKO_API_KEY as string }) as Promise<T>
}

export async function request<T>(url: string, headers: Record<string, string> = {}): Promise<T> {
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

/**
 * One request at a time: parallel requests trip CoinGecko's per-minute rate limit, and the job runs once a day.
 * With `progressLabel`, logs the progress at every 10%
 */
async function mapSequential<T, R>(items: T[], fn: (item: T) => Promise<R>, progressLabel?: string): Promise<R[]> {
  const results: R[] = []
  const step = Math.max(1, Math.ceil(items.length / 10))

  for (const item of items) {
    results.push(await fn(item))

    if (progressLabel && (results.length % step === 0 || results.length === items.length)) {
      log(`${progressLabel}: ${results.length}/${items.length} (${Math.round((results.length / items.length) * 100)}%)`)
    }
  }

  return results
}

function log(message: string): void {
  console.log(`[rwa] ${message}`)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
