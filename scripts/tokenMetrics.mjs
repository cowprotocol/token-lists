// Fetch token market metrics for automated PR descriptions.
//
//   - Liquidity + 24h volume: GeckoTerminal public API (keyless, token-aggregate
//     across pools, documented JSON contract).
//   - Holders: scraped from the CoinMarketCap DEX page — holder count is not
//     exposed by GeckoTerminal, and CMC's free API does not provide it either.
//
// Non-blocking by design: enrichWithTokenMetrics never throws, and the two
// sources are fetched independently so either can fail (unlisted token,
// unmapped chain, network error, timeout, markup change) while the other still
// populates. Any failure leaves that metric at its 'n/a' default so PR
// creation always proceeds.

// token-lists network identifiers (NETWORK_CONFIG keys) -> GeckoTerminal network id.
export const NETWORK_TO_GECKOTERMINAL = {
  MAINNET: 'eth',
  ARBITRUM_ONE: 'arbitrum',
  BASE: 'base',
  AVALANCHE: 'avax',
  POLYGON: 'polygon_pos',
  BNB: 'bsc',
  GNOSIS_CHAIN: 'xdai',
  LINEA: 'linea',
  // PLASMA, INK: not on GeckoTerminal -> liquidity/volume stay 'n/a'.
}

// token-lists network identifiers (NETWORK_CONFIG keys) -> CoinMarketCap DEX chain slug.
export const NETWORK_TO_CMC_SLUG = {
  MAINNET: 'ethereum',
  ARBITRUM_ONE: 'arbitrum',
  BASE: 'base',
  AVALANCHE: 'avalanche',
  POLYGON: 'polygon',
  BNB: 'bnb',
  GNOSIS_CHAIN: 'gnosis',
  LINEA: 'linea',
  // PLASMA, INK: no CMC DEX slug -> holders stay 'n/a'.
}

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Fetch a URL with a timeout and short retry/backoff. Tuned for CI. */
export async function fetchWithRetry(url, { attempts = 2, timeoutMs = 10000, headers = {} } = {}) {
  let lastErr
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (res.status === 429 || res.status >= 500) {
        throw new Error(`HTTP ${res.status}`)
      }
      return res
    } catch (err) {
      lastErr = err
      if (i < attempts - 1) await sleep(1000 * (i + 1)) // linear backoff
    }
  }
  throw lastErr
}

/** GeckoTerminal token page URL (human-facing). */
export function geckoTerminalUrl(gtNetwork, address) {
  return `https://www.geckoterminal.com/${gtNetwork}/tokens/${address}`
}

/** CoinMarketCap DEX token page URL (human-facing, and the scrape target). */
export function cmcTokenUrl(cmcSlug, address) {
  return `https://dex.coinmarketcap.com/token/${cmcSlug}/${address}/`
}

/** Fetch token-aggregate liquidity + 24h volume (USD) from GeckoTerminal. */
export async function fetchLiquidityAndVolume({ gtNetwork, address }) {
  const url = `https://api.geckoterminal.com/api/v2/networks/${gtNetwork}/tokens/${address}`
  const res = await fetchWithRetry(url, { headers: { Accept: 'application/json' } })
  if (!res.ok) throw new Error(`GeckoTerminal returned HTTP ${res.status} for ${url}`)

  const attr = (await res.json())?.data?.attributes ?? {}
  const liquidity = attr.total_reserve_in_usd != null ? Number(attr.total_reserve_in_usd) : null
  const volume24h = attr.volume_usd?.h24 != null ? Number(attr.volume_usd.h24) : null
  return { liquidity, volume24h }
}

/** Scrape the holder count from the CoinMarketCap DEX page's __NEXT_DATA__ JSON. */
export async function fetchHolders({ cmcSlug, address }) {
  const url = cmcTokenUrl(cmcSlug, address)
  const res = await fetchWithRetry(url, { headers: { 'User-Agent': UA } })
  if (!res.ok) throw new Error(`CMC returned HTTP ${res.status} for ${url}`)

  const html = await res.text()
  const matchData = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/)
  if (!matchData) throw new Error(`No __NEXT_DATA__ found for ${url} (token may be unlisted on CMC DEX)`)

  return JSON.parse(matchData[1])?.props?.pageProps?.holdersCount ?? null
}

/** Format a number as compact USD, or 'n/a'. */
export function usd(x) {
  if (x == null || Number.isNaN(Number(x))) return 'n/a'
  return '$' + Math.round(Number(x)).toLocaleString('en-US')
}

/** Format a plain integer count, or 'n/a'. */
export function count(x) {
  if (x == null || Number.isNaN(Number(x))) return 'n/a'
  return Number(x).toLocaleString('en-US')
}

/**
 * Enrich `values` with formatted token metrics. NEVER throws.
 *
 * Sets (all formatted strings, 'n/a' on miss):
 *   - tokenLiquidity, tokenVolume24h  (via GeckoTerminal)
 *   - tokenHolders                    (scraped from CoinMarketCap)
 * and the source page URLs geckoTerminalUrl / cmcUrl (token pages when the
 * chain is mapped, otherwise the site homepages).
 *
 * The two sources are independent: a failure in one never affects the other.
 */
export async function enrichWithTokenMetrics(values) {
  values.tokenLiquidity = 'n/a'
  values.tokenVolume24h = 'n/a'
  values.tokenHolders = 'n/a'
  values.geckoTerminalUrl = 'https://www.geckoterminal.com'
  values.cmcUrl = 'https://dex.coinmarketcap.com'

  const network = String(values.network || '').toUpperCase()
  const address = values.address

  // Liquidity + 24h volume via GeckoTerminal.
  const gtNetwork = NETWORK_TO_GECKOTERMINAL[network]
  if (gtNetwork && address) {
    values.geckoTerminalUrl = geckoTerminalUrl(gtNetwork, address)
    try {
      const { liquidity, volume24h } = await fetchLiquidityAndVolume({ gtNetwork, address })
      values.tokenLiquidity = usd(liquidity)
      values.tokenVolume24h = usd(volume24h)
    } catch (err) {
      console.warn(`Could not fetch liquidity/volume for ${address}: ${err?.message ?? err}`)
    }
  }

  // Holders via CoinMarketCap DEX page scrape.
  const cmcSlug = NETWORK_TO_CMC_SLUG[network]
  if (cmcSlug && address) {
    values.cmcUrl = cmcTokenUrl(cmcSlug, address)
    try {
      values.tokenHolders = count(await fetchHolders({ cmcSlug, address }))
    } catch (err) {
      console.warn(`Could not fetch holders for ${address}: ${err?.message ?? err}`)
    }
  }
}
