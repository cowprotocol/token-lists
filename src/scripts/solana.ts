import path from 'path'
import fs from 'fs'
import { randomUUID } from 'node:crypto'
import type { TokenInfo, TokenList } from '@uniswap/token-lists'
import { BUILD_DIR, SRC_DIR, writeTokenListToBuild, writeTokenListToSrc } from './tokenListUtils.js'
import { fetchJson } from './utils/fetchJson.js'
import { fetchJupiterTokens, getTokenProgramExtensions, hasValidMint, JupiterToken } from './utils/jupiter.js'
import { executeDuneVolumeSnapshot, prepareSolanaRankings, compareTokenAddresses } from './solanaRankings.js'

/**
 * Fetches Solana tokens and writes them as two lists: `CowSwap.1000000001.json`
 * and `Rwa.1000000001.json`.
 *
 * how does it work: a token has to clear two independent bars.
 *
 * 1. Jupiter must not flag it as suspicious. New tokens also need the legacy
 *    `strict` tag or an Organic Score of at least MIN_ORGANIC_SCORE.
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
  outputFile: 'CowSwap.1000000001.json',
  name: 'Solana Default',
  keywords: ['default', 'list', 'solana', 'jupiter', 'coingecko'],
  overridesFile: 'SolanaOverrides.json',
}

const RWA_LIST: ListConfig = {
  outputFile: 'Rwa.1000000001.json',
  name: 'Solana RWA',
  keywords: ['rwa', 'list', 'solana', 'jupiter', 'coingecko'],
}

// Tokenised real-world assets: equities, pre-IPO exposure, commodities, treasuries.
// Jupiter currently puts `rwa` on every one of these, so the rest are redundant
// today. They are spelled out anyway so a new category that skips `rwa` lands in
// the RWA list instead of silently entering the default one.
const RWA_TAGS = new Set(['rwa', 'stocks', 'xstocks', 'equities', 'prestocks', 'pre-ipo', 'ondo', 'commodities'])

const SOLANA_CHAIN_ID = 1000000001
const COINGECKO_SOLANA_LIST_URL = 'https://tokens.coingecko.com/solana/all.json'
const STRICT_TAG = 'strict'
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

// CoinGecko ships a Uniswap-style list, so `chainId` is null for Solana and
// `decimals` occasionally carries an EVM-shaped 18. We only trust the address.
interface CoingeckoToken {
  address: string
  name: string
  symbol: string
  decimals: number
  logoURI?: string
}

async function fetchJupiterTokenList(requiredMints: Set<string>): Promise<JupiterToken[]> {
  return [...(await fetchJupiterTokens(requiredMints, { strict: true })).values()]
}

async function fetchCoingeckoSolana(): Promise<Map<string, CoingeckoToken>> {
  console.log(`Fetching CoinGecko Solana list: ${COINGECKO_SOLANA_LIST_URL}`)
  const json = (await fetchJson(COINGECKO_SOLANA_LIST_URL)) as { tokens?: CoingeckoToken[] }

  if (!Array.isArray(json?.tokens)) {
    throw new Error('Unexpected CoinGecko response shape: expected a `tokens` array')
  }

  return new Map(json.tokens.map((token) => [token.address, token]))
}

function isEligible(t: JupiterToken, wasListed: boolean): boolean {
  if (t.audit?.isSus) {
    return false
  }

  return wasListed || (t.tags ?? []).includes(STRICT_TAG) || (t.organicScore ?? 0) >= MIN_ORGANIC_SCORE
}

function isValidToken(t: JupiterToken): boolean {
  // drop entries without the minimum data we need to render a token
  return Boolean(t.id && t.symbol && t.name && hasValidMint(t))
}

function toTokenInfo(t: JupiterToken, coingecko: CoingeckoToken | undefined): TokenInfo {
  const extensions = getTokenProgramExtensions(t)
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
    ...(extensions.isToken2022 ? { extensions } : {}),
  }
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

function prepareList(config: ListConfig, tokens: TokenInfo[]): PreparedList {
  const current = readCurrentList(config.outputFile)
  assertNoMassiveShrink(config.outputFile, tokens, current)

  return { config, tokens, version: getNextVersion(config, current, tokens) }
}

/** Write temporary files first, then replace each output file. A failed rename can leave a partial update. */
function writeLists(prepared: PreparedList[]): void {
  const staged: { temporary: string; destination: string }[] = []
  try {
    for (const { config, tokens, version } of prepared) {
      const tokenList = buildTokenList(config, tokens, version)
      const temporaryName = '.' + config.outputFile + '.' + randomUUID() + '.tmp'
      staged.push(
        {
          temporary: path.join(BUILD_DIR, 'lists', temporaryName),
          destination: path.join(BUILD_DIR, 'lists', config.outputFile),
        },
        { temporary: path.join(SRC_DIR, temporaryName), destination: path.join(SRC_DIR, config.outputFile) },
      )
      writeTokenListToBuild(temporaryName, tokenList)
      writeTokenListToSrc(temporaryName, tokenList)
    }
    for (const { temporary, destination } of staged) fs.renameSync(temporary, destination)
  } finally {
    // A cleanup failure must not hide the original write error.
    for (const { temporary } of staged) {
      try {
        fs.rmSync(temporary, { force: true })
      } catch {}
    }
  }
  for (const { config, tokens, version } of prepared) {
    console.log(
      `Wrote ${tokens.length} tokens to ${config.outputFile} (v${version.major}.${version.minor}.${version.patch})`,
    )
  }
}

async function main() {
  if (process.argv.length > 2) throw new Error('yarn solana does not accept arguments')
  const apiKey = process.env.DUNE_API_KEY?.trim()
  if (!apiKey) throw new Error('Set DUNE_API_KEY to execute the Solana volume query')
  const overrides = readOverrides(DEFAULT_LIST.overridesFile)
  const currentMints = new Set(
    [DEFAULT_LIST, RWA_LIST].flatMap(
      (config) => readCurrentList(config.outputFile)?.tokens.map((token) => token.address) ?? [],
    ),
  )
  const requiredMints = new Set([...currentMints, ...overrides.map((token) => token.address)])
  const [raw, coingecko] = await Promise.all([fetchJupiterTokenList(requiredMints), fetchCoingeckoSolana()])
  console.log(`Got ${raw.length} tokens from Jupiter, ${coingecko.size} Solana tokens from CoinGecko`)

  const eligible = raw.filter((token) => isEligible(token, currentMints.has(token.id)))
  console.log(
    `${eligible.length} pass safety checks and are existing members, "${STRICT_TAG}", or organicScore >= ${MIN_ORGANIC_SCORE}`,
  )

  const priceable = eligible.filter((t) => coingecko.has(t.id))
  console.log(`${priceable.length} of those are listed on CoinGecko (dropped ${eligible.length - priceable.length})`)

  const valid = priceable.filter(isValidToken)

  const dropped = priceable.length - valid.length
  console.log(`Kept ${valid.length} tokens, dropped ${dropped} (bad fields / unknown program)`)

  const rwa = valid.filter(isRwa)
  const rest = valid.filter((t) => !isRwa(t))
  console.log(`Split into ${rest.length} default and ${rwa.length} RWA tokens`)

  const toInfo = (t: JupiterToken): TokenInfo => toTokenInfo(t, coingecko.get(t.id))

  const safeOverrides = overrides.filter(
    (override) => !raw.some((token) => token.id === override.address && token.audit?.isSus),
  )
  const defaultTokens = applyOverrides(rest.map(toInfo), safeOverrides).sort(compareTokenAddresses)
  const rwaTokens = rwa.map(toInfo).sort(compareTokenAddresses)
  // Reject membership loss before starting a paid execution.
  assertNoMassiveShrink(DEFAULT_LIST.outputFile, defaultTokens, readCurrentList(DEFAULT_LIST.outputFile))
  assertNoMassiveShrink(RWA_LIST.outputFile, rwaTokens, readCurrentList(RWA_LIST.outputFile))
  const snapshot = await executeDuneVolumeSnapshot(apiKey)
  const ranked = prepareSolanaRankings(defaultTokens, rwaTokens, snapshot)
  const prepared = [prepareList(DEFAULT_LIST, ranked), prepareList(RWA_LIST, rwaTokens)]
  console.log(
    JSON.stringify({
      ...snapshot.metadata,
      ...snapshot.provenance,
      rankedTokens: ranked.filter((token) => token.extensions?.rank != null).length,
      defaultTokens: ranked.length,
    }),
  )
  writeLists(prepared)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
