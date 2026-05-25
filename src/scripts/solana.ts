import type { TokenInfo, TokenList } from '@uniswap/token-lists'
import { getTokenListVersion, writeTokenListToBuild, writeTokenListToSrc } from './tokenListUtils'

/**
 * Fetches the Solana default token list from Jupiter and writes it as
 * `SolanaDefault.json`
 *
 * how does it work: pull Jupiter's `verified` set
 * and keep only those *also* tagged `strict`. The `strict` tag is Jupiter's
 * hand-curated "definitely not a scam" subset
 */

const OUTPUT_FILE = 'SolanaDefault.json'
const LIST_NAME = 'Solana Default'
const SOLANA_CHAIN_ID = 1000000001
const JUPITER_VERIFIED_URL = 'https://lite-api.jup.ag/tokens/v2/tag?query=verified'
const STRICT_TAG = 'strict'
const LOGO_URI =
  'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png'

// SPL Token program IDs. Needed downstream so the FE knows whether to issue
// instructions through the classic Token program or Token-2022.
const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'

interface JupiterStats {
  buyVolume?: number | null
  sellVolume?: number | null
}

// Raw Jupiter v2 token shape (only the fields we care about).
interface JupiterToken {
  id: string // mint address
  name: string
  symbol: string
  icon: string | null
  decimals: number
  tokenProgram: string
  tags?: string[]
  stats24h?: JupiterStats | null
  mcap?: number | null
}

async function fetchJupiterVerified(): Promise<JupiterToken[]> {
  console.log(`Fetching Jupiter verified tokens: ${JUPITER_VERIFIED_URL}`)
  const res = await fetch(JUPITER_VERIFIED_URL)
  if (!res.ok) {
    throw new Error(`Jupiter request failed: ${res.status} ${await res.text()}`)
  }
  const json = (await res.json()) as JupiterToken[]
  if (!Array.isArray(json)) {
    throw new Error(`Unexpected Jupiter response shape: ${typeof json}`)
  }
  return json
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
      typeof t.decimals === 'number' &&
      t.decimals >= 0 &&
      (t.tokenProgram === TOKEN_PROGRAM_ID || t.tokenProgram === TOKEN_2022_PROGRAM_ID),
  )
}

function volume24h(t: JupiterToken): number {
  const s = t.stats24h ?? {}
  return (s.buyVolume ?? 0) + (s.sellVolume ?? 0)
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

function sortByVolumeDesc(a: JupiterToken, b: JupiterToken): number {
  return volume24h(b) - volume24h(a)
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

  const tokens = strict.filter(isValidToken).sort(sortByVolumeDesc).map(toTokenInfo)

  const dropped = strict.length - tokens.length
  console.log(`Kept ${tokens.length} tokens, dropped ${dropped} (bad fields / unknown program)`)

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
