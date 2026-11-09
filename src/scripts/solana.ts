import path from 'path'
import fs from 'fs'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { isDeepStrictEqual } from 'node:util'
import { pathToFileURL } from 'node:url'
import type { TokenInfo, TokenList } from '@uniswap/token-lists'
import { BUILD_DIR, SRC_DIR } from './tokenListUtils.js'
import { fetchJson } from './utils/fetchJson.js'
import {
  compareTokenAddresses,
  applyApprovedRanking,
  loadApprovedRanking,
  readRankingSnapshot,
  validateRankingCandidate,
  refreshSolanaRankings,
  SNAPSHOT_PATH,
} from './solanaRankings.js'
import { generateSolanaWarnings } from './solanaWarnings/index.js'
import { serializeWarningsFile, type TokenWarningsFile } from './solanaWarnings/warnings.js'

/**
 * Daily build of the default and RWA lists, with Jupiter Shield warnings.
 * Jupiter supplies metadata and safety flags. New tokens need verification or
 * MIN_ORGANIC_SCORE; existing members stay unless they fail safety or pricing checks.
 * CoinGecko confirms pricing support and supplies missing logos.
 *
 * Daily runs copy saved ranks by mint. Only --refresh-rankings calls Dune,
 * and that mode changes the separate ranking file for review.
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
const NATIVE_SOL_MINT = '11111111111111111111111111111111'
const JUPITER_VERIFIED_URL = 'https://lite-api.jup.ag/tokens/v2/tag?query=verified'
const JUPITER_SEARCH_URL = 'https://lite-api.jup.ag/tokens/v2/search'
const COINGECKO_SOLANA_LIST_URL = 'https://tokens.coingecko.com/solana/all.json'
const STRICT_TAG = 'strict'
const LOGO_URI =
  'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png'

// Organic Score (0-100) is Jupiter's measure of how genuine a token's trading
// activity is. 25 is roughly where their own `medium` bucket starts.
// https://developers.jup.ag/docs/tokens/organic-score
const MIN_ORGANIC_SCORE = 25

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

async function fetchJupiterTokens(requiredMints: Set<string>): Promise<JupiterToken[]> {
  console.log(`Fetching Jupiter verified tokens: ${JUPITER_VERIFIED_URL}`)
  const json = await fetchJson(JUPITER_VERIFIED_URL)

  if (!Array.isArray(json)) {
    throw new Error(`Unexpected Jupiter response shape: ${typeof json}`)
  }

  const tokens = new Map((json as JupiterToken[]).map((token) => [token.id, token]))
  // Recheck missing members and overrides; native SOL is not an SPL mint.
  const missing = [...requiredMints].filter((mint) => mint !== NATIVE_SOL_MINT && !tokens.has(mint))
  for (let offset = 0; offset < missing.length; offset += 100) {
    const batch = missing.slice(offset, offset + 100)
    const matches = await fetchJson(`${JUPITER_SEARCH_URL}?query=${batch.join(',')}`)
    if (!Array.isArray(matches)) throw new Error('Unexpected Jupiter mint lookup response: expected an array')
    for (const token of matches as JupiterToken[]) {
      if (batch.includes(token.id)) tokens.set(token.id, token)
    }
    const unresolved = batch.filter((mint) => !tokens.has(mint))
    if (unresolved.length) throw new Error('Jupiter did not return required mints: ' + unresolved.join(', '))
  }
  return [...tokens.values()]
}

async function fetchCoingeckoSolana(): Promise<Map<string, CoingeckoToken>> {
  console.log(`Fetching CoinGecko Solana list: ${COINGECKO_SOLANA_LIST_URL}`)
  const json = (await fetchJson(COINGECKO_SOLANA_LIST_URL)) as { tokens?: CoingeckoToken[] }

  if (!Array.isArray(json?.tokens) || json.tokens.length === 0) {
    throw new Error('Unexpected CoinGecko response: expected a non-empty `tokens` array')
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

function prepareList(config: ListConfig, tokens: TokenInfo[]): TokenList {
  const current = readCurrentList(config.outputFile)
  return buildTokenList(config, tokens, getNextVersion(config, current, tokens))
}

// Stage all files first. Attempt to restore replaced files if a write fails.
function writeSolanaBundle(files: Record<string, string>): void {
  const staged: { temporary: string; destination: string; previous: Buffer | null }[] = []
  const replaced: typeof staged = []
  try {
    for (const [name, content] of Object.entries(files)) {
      for (const directory of [path.join(BUILD_DIR, 'lists'), SRC_DIR]) {
        fs.mkdirSync(directory, { recursive: true })
        const destination = path.join(directory, name)
        const temporary = path.join(directory, '.' + name + '.' + randomUUID() + '.tmp')
        staged.push({
          temporary,
          destination,
          previous: fs.existsSync(destination) ? fs.readFileSync(destination) : null,
        })
        fs.writeFileSync(temporary, content)
      }
    }
    for (const item of staged) {
      fs.renameSync(item.temporary, item.destination)
      replaced.push(item)
    }
  } catch (error) {
    const errors = [error]
    for (const { destination, previous } of replaced.reverse()) {
      try {
        if (previous === null) fs.rmSync(destination, { force: true })
        else fs.writeFileSync(destination, previous)
      } catch (restoreError) {
        errors.push(restoreError)
      }
    }
    if (errors.length > 1) throw new AggregateError(errors, 'Solana bundle write and restoration failed')
    throw error
  } finally {
    // A cleanup failure must not hide the original write error.
    for (const { temporary } of staged) {
      try {
        fs.rmSync(temporary, { force: true })
      } catch {}
    }
  }
}

const readJson = (name: string) => JSON.parse(fs.readFileSync(path.join(SRC_DIR, name), 'utf8'))

/** PRs validate the candidate against current main; deploys validate the approved public bundle. */
function validateSolana(): void {
  // A proposal must use current main's membership, while published lists keep the old ranks.
  const baseRef = process.env.RANKING_BASE_REF
  if (baseRef && !/^[A-Za-z0-9_./-]+$/.test(baseRef)) throw new Error('Invalid ranking base ref')
  const readBase = (path: string) =>
    JSON.parse(execFileSync('git', ['show', `${baseRef}:${path}`], { encoding: 'utf8' }))
  const candidate = loadApprovedRanking()
  const hasPrevious =
    baseRef && execFileSync('git', ['ls-tree', '--name-only', baseRef, SNAPSHOT_PATH], { encoding: 'utf8' }).trim()
  const previous = hasPrevious ? readRankingSnapshot(readBase(SNAPSHOT_PATH)) : undefined
  if (baseRef) {
    const list = readBase('src/public/CowSwap.1000000001.json') as TokenList
    const rwa = readBase('src/public/Rwa.1000000001.json') as TokenList
    if (previous && !isDeepStrictEqual(candidate, previous)) {
      validateRankingCandidate(candidate, list, rwa.tokens)
    } else if (!previous) {
      // Bootstrap may import only ranks already approved on the trusted base.
      const ranks = new Map(
        list.tokens.filter((t) => t.extensions?.rank !== undefined).map((t) => [t.address, t.extensions!.rank]),
      )
      if (
        candidate.queryId !== 8910905 ||
        Object.keys(candidate.ranks).length !== ranks.size ||
        Object.entries(candidate.ranks).some(([mint, rank]) => ranks.get(mint) !== rank)
      )
        throw new Error('Initial snapshot must preserve the currently approved embedded ranks')
    }
  }
  const [list, rwa] = [DEFAULT_LIST, RWA_LIST].map(({ outputFile }) => readJson(outputFile) as TokenList)
  if (rwa.tokens.some((t) => t.extensions?.rank !== undefined)) throw new Error('RWA tokens must remain unranked')
  const expected = applyApprovedRanking(list.tokens, rwa.tokens, previous ?? candidate)
  if (list.tokens.some((token, index) => token.extensions?.rank !== expected[index].extensions?.rank))
    throw new Error('Public ranks do not match the approved snapshot; run the daily bundle generator')

  // Every published warning must refer to a listed token and a defined warning code.
  const mints = new Set([...list.tokens, ...rwa.tokens].map((token) => token.address))
  const warnings = readJson('TokenWarnings.1000000001.json') as TokenWarningsFile
  if (warnings.chainId !== SOLANA_CHAIN_ID || !warnings.types || !warnings.warnings || Array.isArray(warnings.warnings))
    throw new Error('Invalid Solana warnings')
  for (const [mint, codes] of Object.entries(warnings.warnings)) {
    if (!mints.has(mint) || !Array.isArray(codes) || codes.some((code) => !Object.hasOwn(warnings.types, code)))
      throw new Error('Warnings contain invalid mints or codes')
    for (const code of codes) {
      const type = warnings.types[code]
      if (
        !type ||
        !['info', 'warning', 'critical'].includes(type.severity) ||
        typeof type.message !== 'string' ||
        !type.message.trim()
      )
        throw new Error('Invalid Solana warning definition')
    }
  }
  console.log('Validated Solana lists, approved ranks and warnings')
}

async function generateSolanaLists() {
  const approvedRanking = loadApprovedRanking()
  const overrides = readOverrides(DEFAULT_LIST.overridesFile)
  const currentMints = new Set(
    [DEFAULT_LIST, RWA_LIST].flatMap(
      (config) => readCurrentList(config.outputFile)?.tokens.map((token) => token.address) ?? [],
    ),
  )
  const requiredMints = new Set([...currentMints, ...overrides.map((token) => token.address)])
  const [raw, coingecko] = await Promise.all([fetchJupiterTokens(requiredMints), fetchCoingeckoSolana()])
  console.log(`Got ${raw.length} tokens from Jupiter, ${coingecko.size} Solana tokens from CoinGecko`)

  const eligible = raw.filter((token) => isEligible(token, currentMints.has(token.id)))
  console.log(
    `${eligible.length} pass safety checks and are existing members, "${STRICT_TAG}", or organicScore >= ${MIN_ORGANIC_SCORE}`,
  )

  const priceable = eligible.filter((t) => coingecko.has(t.id))
  console.log(`${priceable.length} of those are listed on CoinGecko (dropped ${eligible.length - priceable.length})`)

  // A truncated pricing feed must not empty the lists. Jupiter safety removals have no limit.
  const existing = eligible.filter((token) => currentMints.has(token.id))
  const missingPrices = existing.filter((token) => !coingecko.has(token.id))
  if (missingPrices.length > existing.length * 0.3)
    throw new Error('CoinGecko is missing prices for over 30% of otherwise eligible existing tokens')

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
  const ranked = applyApprovedRanking(defaultTokens, rwaTokens, approvedRanking)
  const defaultList = prepareList(DEFAULT_LIST, ranked)
  const rwaList = prepareList(RWA_LIST, rwaTokens)
  // Check warnings for the new membership before replacing any published file.
  const warnings = await generateSolanaWarnings([defaultList, rwaList])
  writeSolanaBundle({
    [DEFAULT_LIST.outputFile]: JSON.stringify(defaultList, null, 2),
    [RWA_LIST.outputFile]: JSON.stringify(rwaList, null, 2),
    'TokenWarnings.1000000001.json': serializeWarningsFile(warnings),
  })
  console.log(`Wrote complete Solana bundle; ${ranked.length} default tokens, source ${approvedRanking.timestamp}`)
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  if (args.length === 1 && args[0] === '--validate') return validateSolana()
  if (args[0] === '--refresh-rankings') {
    if (args.length !== 1 && (args.length !== 3 || args[1] !== '--execution-id' || !/^[A-Z0-9]{26}$/.test(args[2])))
      throw new Error('Use yarn solana --refresh-rankings [--execution-id ID]')
    return refreshSolanaRankings(args[2])
  }
  if (args.length) throw new Error('Use yarn solana [--refresh-rankings [--execution-id ID] | --validate]')
  return generateSolanaLists()
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
