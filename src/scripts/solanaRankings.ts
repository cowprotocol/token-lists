import { createHash } from 'node:crypto'
import { setTimeout } from 'node:timers/promises'
import pRetry, { AbortError } from 'p-retry'
import type { TokenInfo } from '@uniswap/token-lists'

const QUERY_ID = 8910905
const DAY_MS = 86_400_000
const MAX_ROWS = 250_000
const PAGE_SIZE = 1_000
const MAX_PAGES = 1_000
const DUNE_ORIGIN = 'https://api.dune.com'
const EXECUTION_TIMEOUT_MS = 10 * 60_000
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

const METRICS = [
  { key: 'volume90dUsd', column: 'volume_90d' },
  { key: 'volume30dUsd', column: 'volume_30d' },
] as const
type MetricKey = (typeof METRICS)[number]['key']
type MetricValues = Record<MetricKey, number | null>
const SOURCE_WINDOW_DAYS = 90

interface SnapshotMetadata {
  queryId: number
  executionId: string
  executionEndedAt: string
  windowDays: number
  windowStart: string
  windowEnd: string
  rowCount: number
}

interface VolumeSnapshot {
  metadata: SnapshotMetadata
  volumes: Map<string, MetricValues>
  provenance: { rowsSha256: string }
}

function readObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid ' + label)
  return value as Record<string, unknown>
}

function readTimestamp(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value)) {
    throw new Error('Source timestamps must be UTC ISO dates')
  }
  const time = Date.parse(value)
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value.slice(0, 10)) {
    throw new Error('Invalid source timestamp')
  }
  return new Date(time).toISOString()
}

/** Check the source ID, full time window and age so old or incomplete data cannot replace approved ranks. */
function readMetadata(input: unknown): SnapshotMetadata {
  const raw = readObject(input, 'source metadata')
  if (raw.queryId !== QUERY_ID) throw new Error('Expected Dune query ' + QUERY_ID)
  if (typeof raw.executionId !== 'string' || !/^[A-Z0-9]{26}$/.test(raw.executionId)) {
    throw new Error('Invalid completed Dune execution ID')
  }
  if (!Number.isSafeInteger(raw.rowCount) || Number(raw.rowCount) < 0 || Number(raw.rowCount) > MAX_ROWS) {
    throw new Error('Invalid source row count (expected 0–250000)')
  }
  const executionEndedAt = readTimestamp(raw.executionEndedAt)
  const windowStart = readTimestamp(raw.windowStart)
  const windowEnd = readTimestamp(raw.windowEnd)
  const completedAtMs = Date.parse(executionEndedAt)
  const windowEndMs = Date.parse(windowEnd)
  const now = Date.now()
  if (raw.windowDays !== SOURCE_WINDOW_DAYS || windowEndMs - Date.parse(windowStart) !== SOURCE_WINDOW_DAYS * DAY_MS) {
    throw new Error(`Expected a complete ${SOURCE_WINDOW_DAYS}-day source window`)
  }
  const invalidOrder = windowEndMs > completedAtMs || completedAtMs > now
  const tooOld = now - completedAtMs > 7 * DAY_MS || now - windowEndMs > 7 * DAY_MS
  const tooLate = completedAtMs - windowEndMs > DAY_MS
  if (invalidOrder || tooOld || tooLate) {
    throw new Error('Source is stale, future-dated, or has an inconsistent window')
  }
  return {
    queryId: QUERY_ID,
    executionId: raw.executionId,
    executionEndedAt,
    windowDays: SOURCE_WINDOW_DAYS,
    windowStart,
    windowEnd,
    rowCount: Number(raw.rowCount),
  }
}

/** Accept only Solana keys that decode to 32 bytes, keeping exact spelling so different addresses never match. */
function isSolanaMint(value: unknown): value is string {
  if (typeof value !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) return false
  let decoded = 0n
  for (const char of value) decoded = decoded * 58n + BigInt(BASE58.indexOf(char))
  // A matching alphabet/length alone is not enough: a Solana key must decode to 32 bytes.
  const leadingZeroBytes = value.length - value.replace(/^1+/, '').length
  const byteCount = decoded === 0n ? 0 : Math.ceil(decoded.toString(2).length / 8)
  return byteCount + leadingZeroBytes === 32
}

/** Read a valid USD amount without turning missing data into zero, which would change a token's score. */
function readUsdVolume(value: unknown): number | null {
  if (value === null || (typeof value === 'string' && ['', '<nil>'].includes(value.trim()))) return null
  if (
    (typeof value !== 'number' && typeof value !== 'string') ||
    (typeof value === 'string' && !/^(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim()))
  ) {
    throw new Error('Invalid USD volume')
  }
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0 || number > Number.MAX_SAFE_INTEGER) {
    throw new Error('Invalid or unreliable USD volume')
  }
  return number
}

/** Add one mint's metrics and reject duplicates or extra rows so a source cannot silently change its size. */
function addRow(volumes: VolumeSnapshot['volumes'], input: unknown, expectedRows: number): void {
  const row = readObject(input, 'volume row')
  if (!isSolanaMint(row.mint)) throw new Error('Invalid mint in volume source')
  if (volumes.has(row.mint)) throw new Error('Duplicate mint in volume source: ' + row.mint)
  if (volumes.size >= expectedRows) throw new Error('Source exceeds expected row count')
  const values = {} as MetricValues
  for (const metric of METRICS) {
    const column = metric.column
    values[metric.key] = column in row ? readUsdVolume(row[column]) : null
  }
  volumes.set(row.mint, values)
}

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')

/** Check that every expected row arrived and hash metrics in exact mint order so input row order does not change the checksum. */
function completeSnapshot(metadata: SnapshotMetadata, volumes: VolumeSnapshot['volumes']): VolumeSnapshot {
  if (volumes.size !== metadata.rowCount) throw new Error('Incomplete source row count')
  const rows = [...volumes].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return {
    metadata,
    volumes,
    provenance: { rowsSha256: sha256(JSON.stringify(rows)) },
  }
}

/** Read one Dune page with time limits and at most three attempts so a network failure cannot leave generation waiting forever. */
async function fetchDunePage(url: string, key: string, deadline: number): Promise<unknown> {
  try {
    return await pRetry(
      async () => {
        const remaining = deadline - Date.now()
        if (remaining <= 0) throw new AbortError('Dune request deadline exceeded')
        let response: Response
        try {
          response = await fetch(url, {
            method: 'GET',
            headers: { 'X-Dune-Api-Key': key },
            redirect: 'error',
            signal: AbortSignal.timeout(Math.min(30_000, remaining)),
          })
        } catch {
          // Vendor errors can contain credentials or private response data.
          throw new Error('Dune network request failed')
        }
        if (!response.ok) {
          await response.body?.cancel()
          const message = 'Dune HTTP ' + response.status
          if (response.status !== 429 && response.status < 500) throw new AbortError(message)
          throw new Error(message)
        }
        try {
          return await response.json()
        } catch (error) {
          if (error instanceof SyntaxError) throw new AbortError('Invalid Dune JSON response')
          throw new Error('Dune response read failed')
        }
      },
      { retries: 2, minTimeout: 250, maxTimeout: 1_000 },
    )
  } catch (error) {
    throw new Error((error instanceof Error ? error.message : 'Dune read failed') + ' (at most 3 attempts)')
  }
}

/** Check that a page belongs to the completed source and has the expected columns and count so partial or mixed results fail. */
function readDuneRows(
  page: Record<string, unknown>,
  metadata: SnapshotMetadata,
): { rows: unknown[]; columns: string[] } {
  const matchesExecution = page.query_id === QUERY_ID && page.execution_id === metadata.executionId
  const isComplete =
    page.state === 'QUERY_STATE_COMPLETED' &&
    page.is_execution_finished === true &&
    page.error == null &&
    page.is_partial !== true
  if (!matchesExecution || !isComplete || readTimestamp(page.execution_ended_at) !== metadata.executionEndedAt)
    throw new Error('Dune results are partial or do not match the pinned completed execution')

  const result = readObject(page.result, 'Dune result')
  const details = readObject(result.metadata, 'Dune result metadata')
  const columns = details.column_names
  if (
    details.total_row_count !== metadata.rowCount ||
    !Array.isArray(columns) ||
    !columns.every((column) => typeof column === 'string') ||
    new Set(columns).size !== columns.length ||
    !columns.includes('mint') ||
    !METRICS.some((metric) => columns.includes(metric.column))
  )
    throw new Error('Dune source row count or columns changed')
  if (
    !Array.isArray(result.rows) ||
    (!result.rows.length && metadata.rowCount !== 0) ||
    result.rows.length > PAGE_SIZE
  ) {
    throw new Error('Invalid or empty Dune result page')
  }
  return { rows: result.rows, columns }
}

/** Check page offsets and returned URLs so missing rows, repeated pages or another server cannot enter the source. */
function validatePagination(page: Record<string, unknown>, end: number, total: number, pathname: string): number {
  const lastPage = end === total
  const expectedNext = lastPage ? null : end
  if (end > total || (page.next_offset ?? null) !== expectedNext) {
    throw new Error('Dune pagination is truncated, repeating, or has an offset gap')
  }
  if (page.next_uri != null) {
    const next = new URL(String(page.next_uri))
    if (
      lastPage ||
      next.origin !== DUNE_ORIGIN ||
      next.pathname !== pathname ||
      next.username ||
      next.password ||
      next.hash ||
      next.searchParams.get('offset') !== String(end)
    )
      throw new Error('Unsafe or inconsistent Dune pagination URI')
  }
  return end
}

/** Read every page from one completed execution, keeping its identity and source checks fixed. */
export async function loadDuneVolumeSnapshot(
  input: unknown,
  apiKey: string,
  deadline = Date.now() + EXECUTION_TIMEOUT_MS,
): Promise<VolumeSnapshot> {
  const metadata = readMetadata(input)
  const key = apiKey.trim()
  if (!key) throw new Error('Set DUNE_API_KEY to read Dune results')
  const pathname = '/api/v1/execution/' + metadata.executionId + '/results'
  const volumes: VolumeSnapshot['volumes'] = new Map()
  let offset = 0
  let pages = 0
  let columns: string[] | undefined
  do {
    if (++pages > MAX_PAGES) throw new Error('Dune pagination exceeded 1000 pages')
    const url = new URL(pathname, DUNE_ORIGIN)
    // Read the result's actual columns: either metric may be absent from this snapshot.
    url.searchParams.set('allow_partial_results', 'false')
    url.searchParams.set('limit', String(PAGE_SIZE))
    url.searchParams.set('offset', String(offset))
    const page = readObject(await fetchDunePage(url.toString(), key, deadline), 'Dune response')
    const result = readDuneRows(page, metadata)
    if (columns && JSON.stringify(columns) !== JSON.stringify(result.columns)) {
      throw new Error('Dune source columns changed across pages')
    }
    columns = result.columns
    const rows = result.rows
    const next = validatePagination(page, offset + rows.length, metadata.rowCount, pathname)
    for (const row of rows) addRow(volumes, row, metadata.rowCount)
    offset = next
  } while (offset < metadata.rowCount)
  return completeSnapshot(metadata, volumes)
}

/** Start one paid execution without retries, then poll and download only that execution's results. */
export async function executeDuneVolumeSnapshot(apiKey: string): Promise<VolumeSnapshot> {
  const key = apiKey.trim()
  if (!key) throw new Error('Set DUNE_API_KEY to execute the Solana volume query')
  const deadline = Date.now() + EXECUTION_TIMEOUT_MS
  let started: Record<string, unknown>
  try {
    const response = await fetch(`${DUNE_ORIGIN}/api/v1/query/${QUERY_ID}/execute`, {
      method: 'POST',
      headers: { 'X-Dune-Api-Key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query_parameters: { days: SOURCE_WINDOW_DAYS, min_volume_usd: 100000 } }),
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error('Dune execution HTTP ' + response.status)
    }
    started = readObject(await response.json(), 'Dune execution')
  } catch {
    // A lost response does not mean Dune rejected the paid execution.
    throw new Error('Dune execution request failed and was not retried; check Dune before starting another run')
  }
  const executionId = started.execution_id
  if (typeof executionId !== 'string' || !/^[A-Z0-9]{26}$/.test(executionId)) {
    throw new Error('Invalid Dune execution ID; execution request was not retried')
  }
  console.log('Dune execution: ' + executionId)
  while (Date.now() < deadline) {
    const status = readObject(
      await fetchDunePage(`${DUNE_ORIGIN}/api/v1/execution/${executionId}/status`, key, deadline),
      'Dune execution status',
    )
    if (status.execution_id !== executionId || status.query_id !== QUERY_ID) {
      throw new Error('Dune status does not match the requested execution')
    }
    if (status.state === 'QUERY_STATE_COMPLETED' && status.is_execution_finished === true && status.error == null) {
      const details = readObject(status.result_metadata, 'Dune result metadata')
      // The query filters block_date < CURRENT_DATE, excluding the current UTC day.
      const startedAt = readTimestamp(status.execution_started_at)
      const executionEndedAt = readTimestamp(status.execution_ended_at)
      if (Date.parse(startedAt) > Date.parse(executionEndedAt))
        throw new Error('Dune execution started after completion')
      const windowEnd = startedAt.slice(0, 10) + 'T00:00:00.000Z'
      const metadata = readMetadata({
        queryId: QUERY_ID,
        executionId,
        executionEndedAt,
        windowDays: SOURCE_WINDOW_DAYS,
        windowStart: new Date(Date.parse(windowEnd) - SOURCE_WINDOW_DAYS * DAY_MS).toISOString(),
        windowEnd,
        rowCount: details.total_row_count,
      })
      return loadDuneVolumeSnapshot(metadata, key, deadline)
    }
    if (
      status.is_execution_finished === true ||
      status.error != null ||
      !['QUERY_STATE_PENDING', 'QUERY_STATE_EXECUTING'].includes(String(status.state))
    ) {
      throw new Error('Dune execution did not complete: ' + String(status.state))
    }
    await setTimeout(Math.min(2_000, Math.max(0, deadline - Date.now())))
  }
  throw new Error('Dune execution deadline exceeded; execution was not retried')
}

export const compareTokenAddresses = (a: { address: string }, b: { address: string }): number =>
  a.address < b.address ? -1 : a.address > b.address ? 1 : 0

function validateTokens(tokens: TokenInfo[], label: string): void {
  const seen = new Set<string>()
  for (const token of tokens) {
    if (token.chainId !== 1000000001 || !isSolanaMint(token.address)) throw new Error('Invalid mint in ' + label)
    if (seen.has(token.address)) throw new Error('Duplicate mint in ' + label)
    seen.add(token.address)
  }
}

export function prepareSolanaRankings(
  tokens: TokenInfo[],
  rwaTokens: TokenInfo[],
  snapshot: VolumeSnapshot,
): TokenInfo[] {
  validateTokens(tokens, 'default list')
  validateTokens(rwaTokens, 'RWA list')
  const rwa = new Set(rwaTokens.map((token) => token.address))
  if (tokens.some((token) => rwa.has(token.address))) throw new Error('Default and RWA lists overlap')

  const scored = tokens.map((token) => ({
    address: token.address,
    values: snapshot.volumes.get(token.address),
    score: 0,
    count: 0,
  }))
  for (const { key } of METRICS) {
    const ordered = scored
      .filter((token) => token.values?.[key] != null)
      .sort((a, b) => b.values![key]! - a.values![key]! || compareTokenAddresses(a, b))
    for (const [index, token] of ordered.entries()) {
      token.score += index + 1
      token.count++
    }
  }
  const ranked = scored.filter((token) => token.count > 0)
  for (const token of ranked) token.score /= token.count
  ranked.sort((a, b) => a.score - b.score || compareTokenAddresses(a, b))
  const ranks = new Map(ranked.map((token, index) => [token.address, index + 1]))

  return tokens.map((token) => {
    const extensions = { ...token.extensions }
    delete extensions.rank
    const rank = ranks.get(token.address)
    if (rank != null) extensions.rank = rank
    const rankedToken = { ...token }
    if (Object.keys(extensions).length) rankedToken.extensions = extensions
    else delete rankedToken.extensions
    return rankedToken
  })
}
