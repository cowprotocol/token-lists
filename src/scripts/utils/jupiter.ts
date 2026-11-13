import { fetchJson } from './fetchJson.js'

const JUPITER_VERIFIED_URL = 'https://lite-api.jup.ag/tokens/v2/tag?query=verified'
const JUPITER_SEARCH_URL = 'https://lite-api.jup.ag/tokens/v2/search'
const SEARCH_BATCH_SIZE = 100
const NATIVE_SOL_MINT = '11111111111111111111111111111111'

// SPL Token program IDs. Needed downstream so the FE knows whether to issue
// instructions through the classic Token program or Token-2022.
export const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
export const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'

// Raw Jupiter v2 token shape (only the fields we care about).
export interface JupiterToken {
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

export interface FetchJupiterTokensOptions {
  /** Throw when Jupiter does not resolve one of `requiredMints`, instead of leaving it out */
  strict?: boolean
}

/**
 * Jupiter's verified tokens, plus `requiredMints` it does not tag as verified, looked up one batch at a time.
 * Jupiter reads decimals and the token program from the mint account, so it is the source of truth for both.
 */
export async function fetchJupiterTokens(
  requiredMints: Iterable<string>,
  { strict = false }: FetchJupiterTokensOptions = {},
): Promise<Map<string, JupiterToken>> {
  console.log(`Fetching Jupiter verified tokens: ${JUPITER_VERIFIED_URL}`)
  const json = await fetchJson(JUPITER_VERIFIED_URL)

  if (!Array.isArray(json)) {
    throw new Error(`Unexpected Jupiter response shape: ${typeof json}`)
  }

  const tokens = new Map((json as JupiterToken[]).map((token) => [token.id, token]))
  // Native SOL is not an SPL mint, Jupiter can't resolve it.
  const missing = [...new Set(requiredMints)].filter((mint) => mint !== NATIVE_SOL_MINT && !tokens.has(mint))

  for (let offset = 0; offset < missing.length; offset += SEARCH_BATCH_SIZE) {
    const batch = missing.slice(offset, offset + SEARCH_BATCH_SIZE)
    const matches = await fetchJson(`${JUPITER_SEARCH_URL}?query=${batch.join(',')}`)
    if (!Array.isArray(matches)) throw new Error('Unexpected Jupiter mint lookup response: expected an array')
    for (const token of matches as JupiterToken[]) {
      if (batch.includes(token.id)) tokens.set(token.id, token)
    }
    const unresolved = batch.filter((mint) => !tokens.has(mint))
    if (strict && unresolved.length) throw new Error('Jupiter did not return required mints: ' + unresolved.join(', '))
  }

  return tokens
}

/** Decimals are an integer and the mint is owned by one of the two SPL Token programs */
export function hasValidMint(token: JupiterToken): boolean {
  return (
    Number.isInteger(token.decimals) &&
    token.decimals >= 0 &&
    (token.tokenProgram === TOKEN_PROGRAM_ID || token.tokenProgram === TOKEN_2022_PROGRAM_ID)
  )
}

/** `extensions` marking a Token-2022 mint, empty for classic SPL mints */
export function getTokenProgramExtensions(token: JupiterToken): { isToken2022?: true } {
  return token.tokenProgram === TOKEN_2022_PROGRAM_ID ? { isToken2022: true } : {}
}
