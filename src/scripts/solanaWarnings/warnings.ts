import type { TokenList } from '@uniswap/token-lists'

const WARNING_SEVERITIES = ['info', 'warning', 'critical'] as const

export type WarningSeverity = (typeof WARNING_SEVERITIES)[number]

/** Severity and copy for one warning code. Both are properties of the code, not of the mint. */
export interface WarningType {
  severity: WarningSeverity
  message: string
}

export interface TokenWarningsFile {
  timestamp: string
  chainId: number
  types: Record<string, WarningType>
  /** Mint -> the codes it carries. Severity and copy are looked up in `types`. */
  warnings: Record<string, string[]>
}

export interface ShieldWarning {
  type: string
  message: string
  severity: string
}

export interface ShieldResponse {
  warnings: Record<string, ShieldWarning[]>
}

export type WarningsContent = Pick<TokenWarningsFile, 'types' | 'warnings'>

/**
 * Shield's type strings mapped to the short codes we publish.
 *
 * A type absent from this map is dropped. The transfer-fee family is deliberately excluded: the
 * interface already tells a user a token charges a fee, and the rate is encoded in the type name
 * (`2.69%_TRANSFER_FEES`), so the set of types would grow without bound as new rates appear.
 *
 * The codes are our contract with the interface, so renaming one is a breaking change.
 */
export const WARNING_CODES: Record<string, string> = {
  HAS_MINT_AUTHORITY: 'MINT',
  HAS_FREEZE_AUTHORITY: 'FREEZE',
  HAS_PERMANENT_DELEGATE: 'PERM_DEL',
  HIGH_SINGLE_OWNERSHIP: 'CONCENTRATED',
  LOW_LIQUIDITY: 'LOW_LIQ',
  LOW_ORGANIC_ACTIVITY: 'LOW_ORGANIC',
  VERY_LOW_TRADING_ACTIVITY: 'LOW_VOLUME',
  NOT_VERIFIED: 'UNVERIFIED',
  NOT_SELLABLE: 'NO_SELL',
}

/**
 * Native SOL is listed under the System Program id, which is not a mint. Shield
 * has nothing on it and answers with the defaults it gives any unknown address
 * — including `NOT_SELLABLE`, on the one asset every Solana trade needs — so it
 * is excluded rather than published.
 */
export const UNMINTED_ADDRESSES = new Set(['11111111111111111111111111111111'])

export function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = []

  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size))
  }

  return chunks
}

function isKnownSeverity(severity: string): severity is WarningSeverity {
  return (WARNING_SEVERITIES as readonly string[]).includes(severity)
}

/**
 * An unrecognised severity still means Jupiter flagged something, so it is
 * promoted to the middle bucket rather than dropped: showing a warning we
 * cannot rank beats hiding one.
 */
export function normalizeSeverity(severity: string): WarningSeverity {
  if (isKnownSeverity(severity)) {
    return severity
  }

  console.warn(`Unknown Shield severity "${severity}", treating it as "warning"`)
  return 'warning'
}

export function collectMints(lists: TokenList[]): string[] {
  const mints = new Set(
    lists.flatMap((list) =>
      list.tokens.map((token) => token.address).filter((address) => !UNMINTED_ADDRESSES.has(address)),
    ),
  )

  // base58 is case-sensitive, so this is a plain codepoint sort
  return [...mints].sort()
}

/**
 * Mints Shield did not answer for.
 *
 * Shield returns an entry for every mint it was asked about, an empty array when it has nothing to
 * report, so an omission is never "this mint is clean" — it means the request was truncated. It
 * truncates above its per-request cap with no error and nothing in the body to say so, and the
 * published file cannot tell a dropped mint from a clean one, so a short answer has to fail the
 * run rather than quietly under-report.
 */
export function findUnansweredMints(mints: string[], response: ShieldResponse): string[] {
  return mints.filter((mint) => !(mint in response.warnings))
}

/**
 * Severity and copy are hoisted into `types`: Shield reports the same severity for every
 * occurrence of a type, so carrying it on each of several hundred entries stores nothing extra.
 */
export function buildWarnings(responses: ShieldResponse[]): WarningsContent {
  const types: Record<string, WarningType> = {}
  const warnings: Record<string, string[]> = {}

  for (const response of responses) {
    for (const [mint, mintWarnings] of Object.entries(response.warnings)) {
      const codes = mintWarnings
        .map((warning) => recordType(types, warning))
        .filter((code): code is string => code !== undefined)
        .sort(compareKeys)

      if (codes.length > 0) {
        warnings[mint] = codes
      }
    }
  }

  return { types: sortByKey(types), warnings: sortByKey(warnings) }
}

/** Returns the code for a Shield warning, or undefined when we do not publish that type. */
function recordType(types: Record<string, WarningType>, warning: ShieldWarning): string | undefined {
  const code = WARNING_CODES[warning.type]

  if (!code) return undefined

  const severity = normalizeSeverity(warning.severity)
  const existing = types[code]

  // Hoisting severity assumes Shield is consistent about it. It has been so far; say so loudly
  // rather than silently publishing whichever occurrence happened to be read first.
  if (existing && existing.severity !== severity) {
    console.warn(`Shield reported ${warning.type} as both "${existing.severity}" and "${severity}"; keeping the first`)
    return code
  }

  types[code] = existing ?? { severity, message: warning.message }

  return code
}

function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function sortByKey<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => compareKeys(a, b)))
}

export function isUnchanged(next: WarningsContent, current: TokenWarningsFile | null): boolean {
  if (!current) return false

  return (
    JSON.stringify(current.types) === JSON.stringify(next.types) &&
    JSON.stringify(current.warnings) === JSON.stringify(next.warnings)
  )
}

/**
 * `JSON.stringify` puts every array element on its own line, which turns one mint gaining a
 * warning into a four-line diff. Keeping each mint on a single line halves the file and makes the
 * nightly commits readable.
 */
export function serializeWarningsFile(file: TokenWarningsFile): string {
  const { timestamp, chainId, types, warnings } = file

  const entries = Object.entries(warnings).map(
    ([mint, codes]) => `    ${JSON.stringify(mint)}: ${JSON.stringify(codes)}`,
  )

  return [
    '{',
    `  "timestamp": ${JSON.stringify(timestamp)},`,
    `  "chainId": ${chainId},`,
    `  "types": ${JSON.stringify(types, null, 2).split('\n').join('\n  ')},`,
    '  "warnings": {',
    entries.join(',\n'),
    '  }',
    '}',
    '',
  ].join('\n')
}
