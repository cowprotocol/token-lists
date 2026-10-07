import path from 'path'
import fs from 'fs'
import type { TokenInfo, TokenList } from '@uniswap/token-lists'
import pRetry, { AbortError } from 'p-retry'
import { SRC_DIR, writeTokenListToBuild, writeTokenListToSrc } from './tokenListUtils'

/**
 * Fetches Solana tokens and writes them as two lists: `SolanaDefault.json` and
 * `SolanaRwa.json`.
 *
 * how does it work: a token has to clear two independent bars.
 *
 * 1. Jupiter decides whether it is legitimate — either it carries the legacy
 *    `strict` tag, or its Organic Score clears MIN_ORGANIC_SCORE.
 * 2. CoinGecko has to list it too, otherwise we cannot price it, and a token we
 *    cannot price is a token we cannot settle.
 *
 * Whatever clears both is then split by kind: tokenised real-world assets go to
 * the RWA list, everything else to the default one. The two lists never overlap.
 *
 * Metadata always comes from Jupiter; CoinGecko only decides membership and
 * fills in a logo when Jupiter has none.
 */

interface ListConfig {
  outputFile: string
  name: string
  keywords: string[]
  overridesFile?: string
}

const DEFAULT_LIST: ListConfig = {
  outputFile: 'SolanaDefault.json',
  name: 'Solana Default',
  keywords: ['default', 'list', 'solana', 'jupiter', 'coingecko'],
  overridesFile: 'SolanaOverrides.json',
}

const RWA_LIST: ListConfig = {
  outputFile: 'SolanaRwa.json',
  name: 'Solana RWA',
  keywords: ['rwa', 'list', 'solana', 'jupiter', 'coingecko'],
}

// Tokenised real-world assets: equities, pre-IPO exposure, commodities, treasuries.
// Jupiter currently puts `rwa` on every one of these, so the rest are redundant
// today. They are spelled out anyway so a new category that skips `rwa` lands in
// the RWA list instead of silently entering the default one.
const RWA_TAGS = new Set(['rwa', 'stocks', 'xstocks', 'equities', 'prestocks', 'pre-ipo', 'ondo', 'commodities'])

const SOLANA_CHAIN_ID = 1000000001
const JUPITER_VERIFIED_URL = 'https://lite-api.jup.ag/tokens/v2/tag?query=verified'
const COINGECKO_SOLANA_LIST_URL = 'https://tokens.coingecko.com/solana/all.json'
const STRICT_TAG = 'strict'
const REQUEST_TIMEOUT_MS = 15_000
const MAX_RETRIES = 3
const LOGO_URI =
  'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png'

// Organic Score (0-100) is Jupiter's measure of how genuine a token's trading
// activity is. 25 is roughly where their own `medium` bucket starts.
// https://developers.jup.ag/docs/tokens/organic-score
const MIN_ORGANIC_SCORE = 25

// Refuse to overwrite the list when it loses more than this share of its tokens
// in one run — that usually means an upstream filter changed under us, not that
// the tokens went away. Set ALLOW_LIST_SHRINK to override for a one-off run.
const MAX_SHRINK_RATIO = 0.3

const DEFAULT_VERSION = { major: 1, minor: 0, patch: 0 }

// SPL Token program IDs. Needed downstream so the FE knows whether to issue
// instructions through the classic Token program or Token-2022.
const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'

// Raw Jupiter v2 token shape (only the fields we care about).
interface JupiterToken {
  id: string // mint address
  name: string
  symbol: string
  icon: string | null
  decimals: number
  tokenProgram: string
  tags?: string[]
  organicScore?: number
  audit?: {
    isSus?: boolean
  }
}

// CoinGecko ships a Uniswap-style list, so `chainId` is null for Solana and
// `decimals` occasionally carries an EVM-shaped 18. We only trust the address.
interface CoingeckoToken {
  address: string
  name: string
  symbol: string
  decimals: number
  logoURI?: string
}

async function fetchJson(url: string): Promise<unknown> {
  return pRetry(
    async () => {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      if (!res.ok) {
        const body = await res.text()
        // 429 (rate limit) is transient — let p-retry back off and retry.
        // Other 4xx are client errors (bad query, removed endpoint) — abort.
        if (res.status >= 400 && res.status < 500 && res.status !== 429) {
          throw new AbortError(`Request to ${url} failed: ${res.status} ${body}`)
        }
        throw new Error(`Request to ${url} failed: ${res.status} ${body}`)
      }
      return res.json()
    },
    {
      retries: MAX_RETRIES,
      onFailedAttempt: (err) => {
        console.warn(`${url} attempt ${err.attemptNumber} failed (${err.retriesLeft} retries left): ${err.message}`)
      },
    },
  )
}

async function fetchJupiterVerified(): Promise<JupiterToken[]> {
  console.log(`Fetching Jupiter verified tokens: ${JUPITER_VERIFIED_URL}`)
  const json = await fetchJson(JUPITER_VERIFIED_URL)

  if (!Array.isArray(json)) {
    throw new Error(`Unexpected Jupiter response shape: ${typeof json}`)
  }

  return json as JupiterToken[]
}

async function fetchCoingeckoSolana(): Promise<Map<string, CoingeckoToken>> {
  console.log(`Fetching CoinGecko Solana list: ${COINGECKO_SOLANA_LIST_URL}`)
  const json = (await fetchJson(COINGECKO_SOLANA_LIST_URL)) as { tokens?: CoingeckoToken[] }

  if (!Array.isArray(json?.tokens)) {
    throw new Error('Unexpected CoinGecko response shape: expected a `tokens` array')
  }

  return new Map(json.tokens.map((token) => [token.address, token]))
}

/**
 * `strict` is a frozen leftover from Jupiter's V1 token list: the API no longer
 * accepts it as a query tag and the set only shrinks. We keep honouring it so
 * tokens already on the list don't vanish from under users, but it is no longer
 * the only way in.
 *
 * `audit.isSus` is checked first and overrides both routes. Organic Score says
 * whether the trading is genuine, not whether the contract is — a honeypot can
 * have perfectly real volume — so Jupiter's own fraud flag is the one signal that
 * has to win outright.
 */
function isEligible(t: JupiterToken): boolean {
  if (t.audit?.isSus) {
    return false
  }

  if ((t.tags ?? []).includes(STRICT_TAG)) {
    return true
  }

  return (t.organicScore ?? 0) >= MIN_ORGANIC_SCORE
}

function isValidToken(t: JupiterToken): boolean {
  // drop entries without the minimum data we need to render a token
  return Boolean(
    t.id &&
      t.symbol &&
      t.name &&
      Number.isInteger(t.decimals) &&
      t.decimals >= 0 &&
      (t.tokenProgram === TOKEN_PROGRAM_ID || t.tokenProgram === TOKEN_2022_PROGRAM_ID),
  )
}

function toTokenInfo(t: JupiterToken, coingecko: CoingeckoToken | undefined): TokenInfo {
  const isToken2022 = t.tokenProgram === TOKEN_2022_PROGRAM_ID
  const logoURI = t.icon || coingecko?.logoURI

  return {
    chainId: SOLANA_CHAIN_ID,
    address: t.id, // base58
    name: t.name,
    symbol: t.symbol,
    // Always Jupiter's: it reads the mint account, whereas CoinGecko has handed
    // out 18 for SPL mints that actually use 8.
    decimals: t.decimals,
    // omit logoURI when neither source has an icon
    ...(logoURI ? { logoURI } : {}),
    // Mark only the Token-2022 mints.
    ...(isToken2022 ? { extensions: { isToken2022: true } } : {}),
  }
}

// sort by mint address to handle a lot off diffs regarding every token list update
function sortByAddress(a: TokenInfo, b: TokenInfo): number {
  return a.address < b.address ? -1 : a.address > b.address ? 1 : 0
}

function isRwa(t: JupiterToken): boolean {
  return (t.tags ?? []).some((tag) => RWA_TAGS.has(tag))
}

function readCurrentList(outputFile: string): TokenList | null {
  const filePath = path.join(SRC_DIR, outputFile)

  if (!fs.existsSync(filePath)) {
    return null
  }

  return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as TokenList
}

// Read hand-maintained overrides. Missing/invalid file → no overrides applied.
function readOverrides(overridesFile: string | undefined): TokenInfo[] {
  if (!overridesFile) return []

  const filePath = path.join(SRC_DIR, overridesFile)
  if (!fs.existsSync(filePath)) {
    console.log(`No overrides file at ${filePath}, skipping`)
    return []
  }
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
  if (!Array.isArray(parsed)) {
    console.warn(`Unexpected ${overridesFile} shape (expected array), skipping overrides`)
    return []
  }
  return parsed as TokenInfo[]
}

// Merge overrides into the token list, keyed by `address`.
// An override replaces a matching token entirely; otherwise it's appended.
function applyOverrides(tokens: TokenInfo[], overrides: TokenInfo[]): TokenInfo[] {
  if (overrides.length === 0) return tokens

  const byAddress = new Map<string, TokenInfo>()
  for (const token of tokens) {
    byAddress.set(token.address, token)
  }

  let replaced = 0
  let added = 0
  for (const override of overrides) {
    if (byAddress.has(override.address)) {
      replaced++
    } else {
      added++
    }
    byAddress.set(override.address, override)
  }

  console.log(`Applied ${overrides.length} overrides (${replaced} replaced, ${added} added)`)
  return [...byAddress.values()]
}

function assertNoMassiveShrink(outputFile: string, tokens: TokenInfo[], current: TokenList | null): void {
  const previousCount = current?.tokens.length ?? 0
  if (previousCount === 0) return

  const shrinkRatio = 1 - tokens.length / previousCount
  if (shrinkRatio <= MAX_SHRINK_RATIO) return

  const percentage = Math.round(shrinkRatio * 100)
  if (process.env.ALLOW_LIST_SHRINK) {
    console.warn(`${outputFile} shrank by ${percentage}% — writing anyway because ALLOW_LIST_SHRINK is set`)
    return
  }

  throw new Error(
    `Refusing to write ${outputFile}: token count dropped from ${previousCount} to ${tokens.length} (-${percentage}%). ` +
      `Check whether an upstream filter changed, then re-run with ALLOW_LIST_SHRINK=1 if the drop is expected.`,
  )
}

// Key order is not guaranteed across runs, so compare entries, not raw JSON.
function serializeExtensions(token: TokenInfo): string {
  if (!token.extensions) return ''

  return JSON.stringify(Object.entries(token.extensions).sort(([a], [b]) => (a < b ? -1 : 1)))
}

// Follows the token list spec the way the aux lists already do it: tokens
// removed → major, tokens added → minor, metadata only → patch. The shared
// patch-only helper is not enough here, because a list that both gains and
// loses tokens needs a major bump to be picked up by clients.
// Addresses are compared case-sensitively: base58 is not hex.
function getNextVersion(config: ListConfig, current: TokenList | null, tokens: TokenInfo[]): TokenList['version'] {
  const version = current?.version ?? DEFAULT_VERSION
  if (!current) return version

  const currentTokens = new Map(current.tokens.map((token) => [token.address, token]))
  const newTokens = new Map(tokens.map((token) => [token.address, token]))

  const removed = [...currentTokens.keys()].some((address) => !newTokens.has(address))
  if (removed) return { major: version.major + 1, minor: 0, patch: 0 }

  const added = [...newTokens.keys()].some((address) => !currentTokens.has(address))
  if (added) return { ...version, minor: version.minor + 1, patch: 0 }

  // `keywords` is part of the written list, so changing it has to bump too.
  const keywordsChanged =
    (current.keywords ?? []).length !== config.keywords.length ||
    config.keywords.some((keyword, i) => current.keywords?.[i] !== keyword)

  const changed = [...currentTokens.values()].some((listToken) => {
    const token = newTokens.get(listToken.address)

    return (
      token &&
      (listToken.name !== token.name ||
        listToken.symbol !== token.symbol ||
        listToken.decimals !== token.decimals ||
        listToken.logoURI !== token.logoURI ||
        // isToken2022 decides which program the FE talks to, so a correction
        // here has to reach clients even when nothing else moved.
        serializeExtensions(listToken) !== serializeExtensions(token))
    )
  })
  if (keywordsChanged || changed) return { ...version, patch: version.patch + 1 }

  return version
}

function buildTokenList(config: ListConfig, tokens: TokenInfo[], version: TokenList['version']): TokenList {
  return {
    name: config.name,
    timestamp: new Date().toISOString(),
    version,
    logoURI: LOGO_URI,
    keywords: config.keywords,
    tokens,
  }
}

interface PreparedList {
  config: ListConfig
  tokens: TokenInfo[]
  version: TokenList['version']
}

// Everything that can reject a list — overrides, the shrink guard, reading the
// current file — happens here, so it happens before anything is written.
function prepareList(config: ListConfig, jupiterTokens: TokenInfo[]): PreparedList {
  const tokens = applyOverrides(jupiterTokens, readOverrides(config.overridesFile)).sort(sortByAddress)

  const current = readCurrentList(config.outputFile)
  assertNoMassiveShrink(config.outputFile, tokens, current)

  return { config, tokens, version: getNextVersion(config, current, tokens) }
}

function writeList({ config, tokens, version }: PreparedList): void {
  const tokenList = buildTokenList(config, tokens, version)

  writeTokenListToBuild(config.outputFile, tokenList)
  writeTokenListToSrc(config.outputFile, tokenList)
  console.log(
    `Wrote ${tokens.length} tokens to ${config.outputFile} (v${version.major}.${version.minor}.${version.patch})`,
  )
}

async function main() {
  const [raw, coingecko] = await Promise.all([fetchJupiterVerified(), fetchCoingeckoSolana()])
  console.log(`Got ${raw.length} verified tokens from Jupiter, ${coingecko.size} Solana tokens from CoinGecko`)

  const eligible = raw.filter(isEligible)
  console.log(`${eligible.length} clear the quality bar ("${STRICT_TAG}" tag or organicScore >= ${MIN_ORGANIC_SCORE})`)

  const priceable = eligible.filter((t) => coingecko.has(t.id))
  console.log(`${priceable.length} of those are listed on CoinGecko (dropped ${eligible.length - priceable.length})`)

  const valid = priceable.filter(isValidToken)

  const dropped = priceable.length - valid.length
  console.log(`Kept ${valid.length} tokens, dropped ${dropped} (bad fields / unknown program)`)

  const rwa = valid.filter(isRwa)
  const rest = valid.filter((t) => !isRwa(t))
  console.log(`Split into ${rest.length} default and ${rwa.length} RWA tokens`)

  const toInfo = (t: JupiterToken): TokenInfo => toTokenInfo(t, coingecko.get(t.id))

  // Both lists are prepared and validated before either is written: a guard that
  // trips on the second one would otherwise leave the first already rewritten, and
  // the two published files describing overlapping sets of tokens.
  const prepared = [prepareList(DEFAULT_LIST, rest.map(toInfo)), prepareList(RWA_LIST, rwa.map(toInfo))]

  prepared.forEach(writeList)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
