import path from 'path'
import fs from 'fs'
import type { TokenInfo, TokenList } from '@uniswap/token-lists'
import pRetry, { AbortError } from 'p-retry'
import { getTokenListVersion, SRC_DIR, writeTokenListToBuild, writeTokenListToSrc } from './tokenListUtils'

/**
 * Fetches the Solana default token list from Jupiter and writes it as
 * `SolanaDefault.json`
 *
 * how does it work: pull Jupiter's `verified` set
 * and keep only those *also* tagged `strict`. The `strict` tag is Jupiter's
 * hand-curated "definitely not a scam" subset
 */

const OUTPUT_FILE = 'SolanaDefault.json'
const OVERRIDES_FILE = 'SolanaOverrides.json'
const LIST_NAME = 'Solana Default'
const SOLANA_CHAIN_ID = 1000000001
const JUPITER_VERIFIED_URL = 'https://lite-api.jup.ag/tokens/v2/tag?query=verified'
const STRICT_TAG = 'strict'
const REQUEST_TIMEOUT_MS = 15_000
const MAX_RETRIES = 3
const LOGO_URI =
  'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png'

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
}

async function fetchJupiterVerified(): Promise<JupiterToken[]> {
  console.log(`Fetching Jupiter verified tokens: ${JUPITER_VERIFIED_URL}`)
  return pRetry(
    async () => {
      const res = await fetch(JUPITER_VERIFIED_URL, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      if (!res.ok) {
        const body = await res.text()
        // 429 (rate limit) is transient — let p-retry back off and retry.
        // Other 4xx are client errors (bad query, removed endpoint) — abort.
        if (res.status >= 400 && res.status < 500 && res.status !== 429) {
          throw new AbortError(`Jupiter request failed: ${res.status} ${body}`)
        }
        throw new Error(`Jupiter request failed: ${res.status} ${body}`)
      }
      const json = (await res.json()) as JupiterToken[]
      if (!Array.isArray(json)) {
        throw new AbortError(`Unexpected Jupiter response shape: ${typeof json}`)
      }
      return json
    },
    {
      retries: MAX_RETRIES,
      onFailedAttempt: (err) => {
        console.warn(
          `Jupiter attempt ${err.attemptNumber} failed (${err.retriesLeft} retries left): ${err.message}`,
        )
      },
    },
  )
}

function isStrict(t: JupiterToken): boolean {
  return (t.tags ?? []).includes(STRICT_TAG)
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

function toTokenInfo(t: JupiterToken): TokenInfo {
  const isToken2022 = t.tokenProgram === TOKEN_2022_PROGRAM_ID
  return {
    chainId: SOLANA_CHAIN_ID,
    address: t.id, // base58
    name: t.name,
    symbol: t.symbol,
    decimals: t.decimals,
    // omit logoURI when Jupiter has no icon
    ...(t.icon ? { logoURI: t.icon } : {}),
    // Mark only the Token-2022 mints.
    ...(isToken2022 ? { extensions: { isToken2022: true } } : {}),
  }
}

// sort by mint address to handle a lot off diffs regarding every token list update
function sortByAddress(a: TokenInfo, b: TokenInfo): number {
  return a.address < b.address ? -1 : a.address > b.address ? 1 : 0
}

// Read hand-maintained overrides. Missing/invalid file → no overrides applied.
function readOverrides(): TokenInfo[] {
  const filePath = path.join(SRC_DIR, OVERRIDES_FILE)
  if (!fs.existsSync(filePath)) {
    console.log(`No overrides file at ${filePath}, skipping`)
    return []
  }
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
  if (!Array.isArray(parsed)) {
    console.warn(`Unexpected ${OVERRIDES_FILE} shape (expected array), skipping overrides`)
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

function buildTokenList(tokens: TokenInfo[], version: TokenList['version']): TokenList {
  return {
    name: LIST_NAME,
    timestamp: new Date().toISOString(),
    version,
    logoURI: LOGO_URI,
    keywords: ['default', 'list', 'solana', 'jupiter'],
    tokens,
  }
}

async function main() {
  const raw = await fetchJupiterVerified()
  console.log(`Got ${raw.length} verified tokens from Jupiter`)

  const strict = raw.filter(isStrict)
  console.log(`${strict.length} carry the "strict" tag`)

  const jupiterTokens = strict.filter(isValidToken).map(toTokenInfo)

  const dropped = strict.length - jupiterTokens.length
  console.log(`Kept ${jupiterTokens.length} tokens, dropped ${dropped} (bad fields / unknown program)`)

  const tokens = applyOverrides(jupiterTokens, readOverrides()).sort(sortByAddress)

  const version = await getTokenListVersion(OUTPUT_FILE)
  const tokenList = buildTokenList(tokens, version)

  writeTokenListToBuild(OUTPUT_FILE, tokenList)
  writeTokenListToSrc(OUTPUT_FILE, tokenList)
  console.log(`Wrote ${tokens.length} tokens to ${OUTPUT_FILE} (v${version.major}.${version.minor}.${version.patch})`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
