import { getAddressKey, SupportedChainId } from '@cowprotocol/cow-sdk'
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
 *   lists are skipped
 * - `MANUAL_TOKENS`, for issuers without a token list
 *
 * Tokens in `CowSwap.json` are skipped and reported: geoblocking a default token in ~50 countries is a human call.
 */

const CMS_URL = 'https://cms.cow.fi/api/restricted-token-lists?pagination[pageSize]=100'

/** Issuers without a token list. Check `name()`, `symbol()` and `decimals()` on-chain and the explorer label first */
const MANUAL_TOKENS: TokenInfo[] = [
  // Binance bStocks
  {
    chainId: SupportedChainId.BNB,
    address: '0x38dd26788cf2d901e3abf04efe3007d459d0fc53',
    name: 'Anthropic (bStocks Tokenized Stock)',
    symbol: 'ANTB',
    decimals: 18,
    extensions: { assetType: 'stock', issuer: 'BTech Holdings Limited' },
  },
]

/** Extensions CoW Swap reads from the RWA lists. Providers' own extensions are dropped */
const RWA_EXTENSIONS = ['assetType', 'issuer']

interface CmsRecords {
  data: { attributes: { name: string; tokenListUrl: string } }[]
  meta: { pagination: { total: number } }
}

export async function generateRwaSupplement(outputPath: string | URL = RWA_SUPPLEMENT_PATH): Promise<void> {
  const { data, meta } = await request<CmsRecords>(CMS_URL)

  if (meta.pagination.total > data.length) {
    throw new Error(`Only ${data.length} of ${meta.pagination.total} CMS records were fetched`)
  }

  const sources = [{ name: 'Manual', tokens: MANUAL_TOKENS }]

  for (const { name, tokenListUrl } of data.map((record) => record.attributes)) {
    if (tokenListUrl.startsWith('https://files.cow.fi/')) continue

    sources.push({ name, tokens: (await request<{ tokens: TokenInfo[] }>(tokenListUrl)).tokens })
  }

  // Must exist: without it, default tokens would slip into the supplement
  const cowSwap = new Set((JSON.parse(readFileSync('src/public/CowSwap.json', 'utf8')).tokens as TokenInfo[]).map(getKey))
  const onCoinGecko = new Set(
    Object.keys(COINGECKO_CHAINS)
      .map((chainId) => getRwaListPath(Number(chainId)))
      .filter((path) => existsSync(path))
      .flatMap((path) => (JSON.parse(readFileSync(path, 'utf8')).tokens as TokenInfo[]).map(getKey)),
  )
  const supplement = new Map<string, TokenInfo>()

  for (const source of sources) {
    const before = supplement.size
    let otherChains = 0
    let listed = 0

    for (const token of source.tokens) {
      const key = getKey(token)

      if (!isRwaSupplementChain(token.chainId)) {
        otherChains++
        continue
      }

      if (onCoinGecko.has(key)) {
        listed++
        continue
      }

      if (supplement.has(key)) continue

      const entry = toSupplementToken(token)
      const error = cowSwap.has(key) ? 'in CowSwap.json' : getRwaSupplementError(entry)

      if (error) {
        console.warn(`[rwa] Skipping ${token.symbol} (${key}) of ${source.name}: ${error}`)
        continue
      }

      supplement.set(key, entry)
    }

    log(`${source.name}: ${supplement.size - before} added, ${listed} already listed, ${otherChains} on other chains`)
  }

  const tokens = [...supplement.values()].sort((a, b) => a.chainId - b.chainId || a.address.localeCompare(b.address))

  writeFileSync(outputPath, JSON.stringify(tokens, null, 2) + '\n')
  log(`${tokens.length} tokens written`)
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

function log(message: string): void {
  console.log(`[rwa] ${message}`)
}
