import type { TokenList } from '@uniswap/token-lists'

const WARNING_SEVERITIES = ['info', 'warning', 'critical'] as const

export type WarningSeverity = (typeof WARNING_SEVERITIES)[number]

export interface TokenWarning {
  type: string
  severity: WarningSeverity
}

export interface TokenWarningsFile {
  timestamp: string
  chainId: number
  messages: Record<string, string>
  warnings: Record<string, TokenWarning[]>
}

export interface ShieldWarning {
  type: string
  message: string
  severity: string
}

export interface ShieldResponse {
  warnings: Record<string, ShieldWarning[]>
}

export type WarningsContent = Pick<TokenWarningsFile, 'messages' | 'warnings'>

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

/**
 * Native SOL is listed under the System Program id, which is not a mint. Shield
 * has nothing on it and answers with the defaults it gives any unknown address
 * — including `NOT_SELLABLE`, on the one asset every Solana trade needs — so it
 * is excluded rather than published.
 */
export const UNMINTED_ADDRESSES = new Set(['11111111111111111111111111111111'])

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
 * Shield answers only for mints it has something to say about, so a mint
 * missing from the response is a mint with no warnings.
 */
export function buildWarnings(responses: ShieldResponse[]): WarningsContent {
  const messages: Record<string, string> = {}
  const warnings: Record<string, TokenWarning[]> = {}

  for (const response of responses) {
    for (const [mint, mintWarnings] of Object.entries(response.warnings)) {
      if (mintWarnings.length === 0) continue

      warnings[mint] = [...mintWarnings]
        .sort((a, b) => compareKeys(a.type, b.type))
        .map(({ type, message, severity }) => {
          messages[type] = message

          return { type, severity: normalizeSeverity(severity) }
        })
    }
  }

  return { messages: sortByKey(messages), warnings: sortByKey(warnings) }
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
    JSON.stringify(current.messages) === JSON.stringify(next.messages) &&
    JSON.stringify(current.warnings) === JSON.stringify(next.warnings)
  )
}
