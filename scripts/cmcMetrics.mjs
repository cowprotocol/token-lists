// Fetch CoinMarketCap DEX metrics (liquidity, 24h volume, holders) for a token
// and format them for inclusion in an automated PR description.
//
// Non-blocking by design: enrichWithCmcMetrics never throws. Any failure
// (unlisted token, unmapped chain, network error, timeout) leaves the metric
// fields at their 'n/a' defaults so PR creation can proceed.

// Map token-lists network identifiers (NETWORK_CONFIG keys) -> CMC DEX chain slug.
export const NETWORK_TO_CMC_SLUG = {
  MAINNET: 'ethereum',
  ARBITRUM_ONE: 'arbitrum',
  BASE: 'base',
  AVALANCHE: 'avalanche',
  POLYGON: 'polygon',
  BNB: 'bnb',
  GNOSIS_CHAIN: 'gnosis',
  LINEA: 'linea',
  // PLASMA, INK: no CMC DEX slug -> treated as "no data".
}

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Fetch a URL with a timeout and short retry/backoff. Tuned for CI. */
export async function fetchWithRetry(url, { attempts = 2, timeoutMs = 10000 } = {}) {
  let lastErr
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA },
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

/** Build the CMC DEX token page URL. */
export function cmcTokenUrl(slug, address) {
  return `https://dex.coinmarketcap.com/token/${slug}/${address}/`
}

/** Fetch the CMC DEX page and extract liquidity/volume/holders from __NEXT_DATA__. */
export async function fetchCmcData({ slug, address }) {
  const url = cmcTokenUrl(slug, address)
  const res = await fetchWithRetry(url)
  if (!res.ok) throw new Error(`CMC returned HTTP ${res.status} for ${url}`)
  const html = await res.text()

  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/)
  if (!m) throw new Error(`No __NEXT_DATA__ found for ${url} (token may be unlisted on CMC DEX)`)

  const pageProps = JSON.parse(m[1])?.props?.pageProps ?? {}
  const holders = pageProps.holdersCount ?? null
  const tokenInfo = (pageProps.dehydratedState?.queries ?? []).find(
    (q) => Array.isArray(q.queryKey) && q.queryKey[0] === 'dex-token-info',
  )?.state?.data

  const liquidity = tokenInfo?.liqUsd != null ? Number(tokenInfo.liqUsd) : null
  const stat24h = (tokenInfo?.sts ?? []).find((s) => s.tp === '24h')
  const volume24h = stat24h?.vu != null ? Number(stat24h.vu) : null

  return { liquidity, volume24h, holders }
}

/** Format a number as compact USD, or 'n/a'. */
export function usd(x) {
  if (x == null || Number.isNaN(x)) return 'n/a'
  return '$' + Math.round(x).toLocaleString('en-US')
}

/** Format a plain integer count, or 'n/a'. */
export function count(x) {
  if (x == null || Number.isNaN(Number(x))) return 'n/a'
  return Number(x).toLocaleString('en-US')
}

/**
 * Enrich `values` with formatted CMC DEX metrics. NEVER throws.
 * Sets: cmcLiquidity, cmcVolume24h, cmcHolders (formatted strings, 'n/a' on miss)
 * and cmcUrl (token page URL, or the DEX homepage when the chain is unmapped).
 */
export async function enrichWithCmcMetrics(values) {
  values.cmcLiquidity = 'n/a'
  values.cmcVolume24h = 'n/a'
  values.cmcHolders = 'n/a'
  values.cmcUrl = 'https://dex.coinmarketcap.com'

  try {
    const slug = NETWORK_TO_CMC_SLUG[String(values.network || '').toUpperCase()]
    if (!slug || !values.address) return

    values.cmcUrl = cmcTokenUrl(slug, values.address)

    const { liquidity, volume24h, holders } = await fetchCmcData({
      slug,
      address: values.address,
    })
    values.cmcLiquidity = usd(liquidity)
    values.cmcVolume24h = usd(volume24h)
    values.cmcHolders = count(holders)
  } catch (err) {
    console.warn(`Could not fetch CMC metrics for ${values.address}: ${err.message}`)
  }
}
