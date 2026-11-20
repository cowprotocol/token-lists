import { getAddressKey } from '@cowprotocol/cow-sdk'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import {
  getRwaListPath,
  getRwaSupplementError,
  isRwaSupplementChain,
  request,
  RWA_SUPPLEMENT_PATH,
  toLogoUrl,
} from './rwa.js'
import { COINGECKO_CHAINS, TokenInfo } from './utils.js'

/**
 * Writes `rwaSupplement.json`, on demand (`yarn rwaSupplement`): RWA tokens that aren't in any
 * `CoinGeckoRwa.<chainId>.json` because CoinGecko doesn't know them yet. `rwa.ts` adds them to those lists on every
 * run, so they show up with the RWA badge, and are geoblocked wherever a CMS record points at those lists.
 *
 * Sources:
 * - the token lists of the CMS `restricted-token-lists` records, which pin them by commit. Our own `files.cow.fi`
 *   lists are skipped. Their tokens in `CowSwap.json` are skipped and reported: geoblocking a default token in ~50
 *   countries is a human call
 * - `rwaManual.json`: tokens added by hand, for issuers without a token list. Check `name()`, `symbol()` and
 *   `decimals()` on-chain and the explorer label before adding one. A token CoinGecko or a provider list has by now
 *   is removed from it. An invalid one, or one in `CowSwap.json`, aborts the run
 */

const CMS_URL = 'https://cms.cow.fi/api/restricted-token-lists?pagination[pageSize]=100'
const RWA_MANUAL_PATH = new URL('./rwaManual.json', import.meta.url)

/** Extensions CoW Swap reads from the RWA lists. Providers' own extensions are dropped */
const RWA_EXTENSIONS = ['assetType', 'issuer']

interface CmsRecords {
  data: { attributes: { name: string; tokenListUrl: string } }[]
  meta: { pagination: { total: number } }
}

export async function generateRwaSupplement({
  manualPath = RWA_MANUAL_PATH,
  outputPath = RWA_SUPPLEMENT_PATH,
}: { manualPath?: string | URL; outputPath?: string | URL } = {}): Promise<void> {
  const { data, meta } = await request<CmsRecords>(CMS_URL)

  if (meta.pagination.total > data.length) {
    throw new Error(`Only ${data.length} of ${meta.pagination.total} CMS records were fetched`)
  }

  // Must exist: without it, default tokens would slip into the supplement
  const cowSwap = new Set((JSON.parse(readFileSync('src/public/CowSwap.json', 'utf8')).tokens as TokenInfo[]).map(getKey))
  const onCoinGecko = new Set(
    Object.keys(COINGECKO_CHAINS)
      .map((chainId) => getRwaListPath(Number(chainId)))
      .filter((path) => existsSync(path))
      .flatMap((path) => (JSON.parse(readFileSync(path, 'utf8')).tokens as TokenInfo[]).map(getKey)),
  )
  const fromProviders = new Map<string, TokenInfo>()

  for (const { name, tokenListUrl } of data.map((record) => record.attributes)) {
    if (tokenListUrl.startsWith('https://files.cow.fi/')) continue

    const { tokens } = await request<{ tokens: TokenInfo[] }>(tokenListUrl)
    const before = fromProviders.size
    let otherChains = 0
    let listed = 0

    for (const token of tokens) {
      const key = getKey(token)

      if (!isRwaSupplementChain(token.chainId)) {
        otherChains++
        continue
      }

      if (onCoinGecko.has(key)) {
        listed++
        continue
      }

      if (fromProviders.has(key)) continue

      const entry = toSupplementToken(token)
      const error = cowSwap.has(key) ? 'in CowSwap.json' : getRwaSupplementError(entry)

      if (error) {
        console.warn(`[rwa] Skipping ${token.symbol} (${key}) of ${name}: ${error}`)
        continue
      }

      fromProviders.set(key, entry)
    }

    log(`${name}: ${fromProviders.size - before} added, ${listed} on CoinGecko, ${otherChains} on other chains`)
  }

  const manual = JSON.parse(readFileSync(manualPath, 'utf8')) as TokenInfo[]
  const kept = new Map<string, TokenInfo>()

  for (const token of manual) {
    const key = getKey(token)

    if (onCoinGecko.has(key) || fromProviders.has(key)) {
      log(`Removing ${token.symbol} (${key}) from the manual tokens: ${onCoinGecko.has(key) ? 'CoinGecko' : 'a provider'} lists it`)
      continue
    }

    const error = kept.has(key) ? 'duplicate' : cowSwap.has(key) ? 'in CowSwap.json' : getRwaSupplementError(token)

    if (error) throw new Error(`Manual RWA token ${token.symbol} (${key}): ${error}`)

    kept.set(key, token)
  }

  if (kept.size < manual.length) writeJson(manualPath, [...kept.values()])

  const supplement = [...[...kept.values()].map(toSupplementToken), ...fromProviders.values()].sort(
    (a, b) => a.chainId - b.chainId || a.address.localeCompare(b.address),
  )

  writeJson(outputPath, supplement)
  log(`${supplement.length} tokens written, ${kept.size} of them manual`)
}

function getKey({ chainId, address }: TokenInfo): string {
  return `${chainId}:${getAddressKey(address)}`
}

function toSupplementToken({ chainId, address, name, symbol, decimals, logoURI, extensions }: TokenInfo): TokenInfo {
  const logo = toLogoUrl(logoURI)
  const rwaExtensions = Object.entries(extensions ?? {}).filter(([key]) => RWA_EXTENSIONS.includes(key))

  return {
    chainId,
    address: getAddressKey(address),
    name,
    symbol,
    decimals,
    ...(logo ? { logoURI: logo } : {}),
    ...(rwaExtensions.length ? { extensions: Object.fromEntries(rwaExtensions) } : {}),
  }
}

function writeJson(path: string | URL, data: unknown): void {
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n')
}

function log(message: string): void {
  console.log(`[rwa] ${message}`)
}
