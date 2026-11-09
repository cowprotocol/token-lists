import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import pRetry, { AbortError } from 'p-retry'
import type { TokenInfo, TokenList } from '@uniswap/token-lists'

export const DUNE_QUERY = {
  id: 9087267,
  version: 1,
  sqlSha256: 'c50b719206328eb73016cd03979a79e64469b4ab9980638febc8398041357b52',
}
const QUERY_ID = DUNE_QUERY.id
// Allow one day after a weekly refresh is due. Drop ranks after a second missed week.
const RANK_WARN_AFTER_DAYS = 8
const RANK_EXPIRE_AFTER_DAYS = 15
const DAY_MS = 86_400_000
const MINTS_PER_REQUEST = 100
const DUNE_ORIGIN = 'https://api.dune.com'
const HTTP_REQUEST_TIMEOUT_MS = 30_000
const DUNE_QUERY_TIMEOUT_MS = 30 * 60_000
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

const METRICS = [
  { key: 'volume90dUsd', column: 'volume_90d' },
  { key: 'volume30dUsd', column: 'volume_30d' },
] as const
type MetricKey = (typeof METRICS)[number]['key']
type MetricValues = Record<MetricKey, number | null>
const QUERY_PARAMETERS = Object.freeze({ days: 90, min_volume_usd: 100000 } as const)

export interface ExecutionReceipt {
  schemaVersion: 1
  executionId: string
  queryId: number
  queryVersion: number
  querySqlSha256: string
  parameters: typeof QUERY_PARAMETERS
  requestedPerformance: 'large'
  requestStartedAt: string
}

export function readExecutionReceipt(input: unknown, executionId: string): ExecutionReceipt {
  const raw = readObject(input, 'execution receipt')
  const parameters = readObject(raw.parameters, 'execution receipt parameters')
  if (
    raw.schemaVersion !== 1 ||
    raw.executionId !== executionId ||
    !/^[A-Z0-9]{26}$/.test(executionId) ||
    raw.queryId !== QUERY_ID ||
    raw.queryVersion !== DUNE_QUERY.version ||
    raw.querySqlSha256 !== DUNE_QUERY.sqlSha256 ||
    parameters.days !== QUERY_PARAMETERS.days ||
    parameters.min_volume_usd !== QUERY_PARAMETERS.min_volume_usd ||
    raw.requestedPerformance !== 'large' ||
    (raw.engineUsed !== undefined && raw.engineUsed !== 'large')
  )
    throw new Error('Execution receipt does not match the execution and reviewed query settings')
  return {
    schemaVersion: 1,
    executionId,
    queryId: QUERY_ID,
    queryVersion: DUNE_QUERY.version,
    querySqlSha256: DUNE_QUERY.sqlSha256,
    parameters: QUERY_PARAMETERS,
    requestedPerformance: 'large',
    requestStartedAt: readTimestamp(raw.requestStartedAt),
  }
}

interface SnapshotMetadata {
  queryId: number
  executionId: string
  executionEndedAt: string
  windowEnd: string
  rowCount: number
}

interface VolumeSnapshot {
  metadata: SnapshotMetadata
  volumes: Map<string, MetricValues>
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

/** Reject the wrong query, inconsistent timestamps, and stale data. */
function readMetadata(input: unknown): SnapshotMetadata {
  const raw = readObject(input, 'source metadata')
  if (raw.queryId !== QUERY_ID) throw new Error('Expected Dune query ' + QUERY_ID)
  if (typeof raw.executionId !== 'string' || !/^[A-Z0-9]{26}$/.test(raw.executionId)) {
    throw new Error('Invalid completed Dune execution ID')
  }
  if (!Number.isSafeInteger(raw.rowCount) || Number(raw.rowCount) < 0) {
    throw new Error('Invalid source row count')
  }
  const executionEndedAt = readTimestamp(raw.executionEndedAt)
  const windowEnd = readTimestamp(raw.windowEnd)
  const completedAtMs = Date.parse(executionEndedAt)
  const windowEndMs = Date.parse(windowEnd)
  const now = Date.now()
  const invalidOrder = windowEndMs > completedAtMs || completedAtMs > now
  const tooOld = now - completedAtMs > 7 * DAY_MS || now - windowEndMs > 7 * DAY_MS
  // A query started before midnight can finish on the next UTC day.
  const tooLate = completedAtMs - windowEndMs > DAY_MS + DUNE_QUERY_TIMEOUT_MS
  if (invalidOrder || tooOld || tooLate) {
    throw new Error('Source is stale, future-dated, or has an inconsistent window')
  }
  return {
    queryId: QUERY_ID,
    executionId: raw.executionId,
    executionEndedAt,
    windowEnd,
    rowCount: Number(raw.rowCount),
  }
}

/** Validate a 32-byte Solana mint without changing its case. */
function isSolanaMint(value: unknown): value is string {
  if (typeof value !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) return false
  let decoded = 0n
  for (const char of value) decoded = decoded * 58n + BigInt(BASE58.indexOf(char))
  // A matching alphabet/length alone is not enough: a Solana key must decode to 32 bytes.
  const leadingZeroBytes = value.length - value.replace(/^1+/, '').length
  const byteCount = decoded === 0n ? 0 : Math.ceil(decoded.toString(2).length / 8)
  return byteCount + leadingZeroBytes === 32
}

/** Keep missing volumes as null; zero would affect ranking. */
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

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')

/** Fetch a Dune page with a timeout and at most three attempts. */
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
            signal: AbortSignal.timeout(Math.min(HTTP_REQUEST_TIMEOUT_MS, remaining)),
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
          const value = await response.json()
          if (Date.now() >= deadline) throw new AbortError('Dune request deadline exceeded')
          return value
        } catch (error) {
          if (error instanceof AbortError) throw error
          if (error instanceof SyntaxError) throw new AbortError('Invalid Dune JSON response')
          throw new Error('Dune response read failed')
        }
      },
      { retries: 2, minTimeout: 250, maxTimeout: 1_000, maxRetryTime: Math.max(0, deadline - Date.now()) },
    )
  } catch (error) {
    throw new Error((error instanceof Error ? error.message : 'Dune read failed') + ' (at most 3 attempts)')
  }
}

/** Safe preflight: a changed remote query must be reviewed before spending credits. */
export async function verifyDuneRankingQuery(
  apiKey: string,
  deadline = Date.now() + HTTP_REQUEST_TIMEOUT_MS,
): Promise<{ queryVersion: number; querySqlSha256: string }> {
  const key = apiKey.trim()
  if (!key) throw new Error('Set DUNE_API_KEY to read the ranking query')
  const query = readObject(await fetchDunePage(`${DUNE_ORIGIN}/api/v1/query/${QUERY_ID}`, key, deadline), 'Dune query')
  if (
    query.query_id !== QUERY_ID ||
    query.version !== DUNE_QUERY.version ||
    typeof query.query_sql !== 'string' ||
    sha256(query.query_sql.trimEnd()) !== DUNE_QUERY.sqlSha256
  ) {
    throw new Error('Ranking query SQL/version differs from the reviewed query')
  }
  return { queryVersion: DUNE_QUERY.version, querySqlSha256: DUNE_QUERY.sqlSha256 }
}

/** Each mint filter fits in one response. Reject partial or unexpected results. */
function readDuneRows(page: Record<string, unknown>, metadata: SnapshotMetadata): unknown[] {
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
    !['mint', ...METRICS.map((metric) => metric.column)].every((column) => columns.includes(column))
  )
    throw new Error('Dune source row count or columns changed')
  if (!Array.isArray(result.rows) || page.next_offset != null || page.next_uri != null) {
    throw new Error('Invalid or partial filtered Dune result')
  }
  return result.rows
}

/** Download only current default-list mints from one completed execution. */
export async function loadDuneVolumeSnapshot(
  input: unknown,
  apiKey: string,
  eligibleMints: string[],
  deadline = Date.now() + DUNE_QUERY_TIMEOUT_MS,
): Promise<VolumeSnapshot> {
  const metadata = readMetadata(input)
  const key = apiKey.trim()
  if (!key) throw new Error('Set DUNE_API_KEY to read Dune results')
  const volumes: VolumeSnapshot['volumes'] = new Map()
  if (!eligibleMints.length || eligibleMints.some((mint) => !isSolanaMint(mint)))
    throw new Error('Expected eligible Solana mints')
  // Small filters keep URLs short. A batch has at most 100 matches, so no pagination is needed.
  for (let i = 0; i < eligibleMints.length; i += MINTS_PER_REQUEST) {
    const mints = eligibleMints.slice(i, i + MINTS_PER_REQUEST)
    const url = new URL(`/api/v1/execution/${metadata.executionId}/results`, DUNE_ORIGIN)
    url.searchParams.set('allow_partial_results', 'false')
    url.searchParams.set('limit', String(MINTS_PER_REQUEST + 1))
    url.searchParams.set('filters', 'mint IN (' + mints.map((mint) => "'" + mint + "'").join(',') + ')')
    const page = readObject(await fetchDunePage(url.toString(), key, deadline), 'Dune response')
    for (const input of readDuneRows(page, metadata)) {
      const row = readObject(input, 'volume row')
      // Every requested mint was checked above, so membership also validates its format.
      if (typeof row.mint !== 'string' || !mints.includes(row.mint)) throw new Error('Invalid mint in Dune result')
      if (volumes.has(row.mint)) throw new Error('Duplicate mint in Dune result')
      volumes.set(row.mint, {
        volume90dUsd: 'volume_90d' in row ? readUsdVolume(row.volume_90d) : null,
        volume30dUsd: 'volume_30d' in row ? readUsdVolume(row.volume_30d) : null,
      })
    }
  }
  if (Date.now() >= deadline) throw new Error('Dune result download deadline exceeded')
  if (volumes.size > metadata.rowCount) throw new Error('Dune results exceed the source row count')
  // Dune's total_row_count includes unrequested mints. Save only the downloaded count.
  return { metadata: { ...metadata, rowCount: volumes.size }, volumes }
}

/** Start one paid query without retrying, wait for completion, and fetch its results. */
export async function executeDuneVolumeSnapshot(
  apiKey: string,
  eligibleMints: string[],
  saveReceipt: (receipt: ExecutionReceipt) => void = () => {},
): Promise<VolumeSnapshot> {
  const key = apiKey.trim()
  if (!key) throw new Error('Set DUNE_API_KEY to execute the Solana volume query')
  const pinnedQuery = await verifyDuneRankingQuery(key)
  const deadline = Date.now() + DUNE_QUERY_TIMEOUT_MS
  const requestStartedAt = new Date(Date.now()).toISOString()
  let started: Record<string, unknown>
  try {
    const response = await fetch(`${DUNE_ORIGIN}/api/v1/query/${QUERY_ID}/execute`, {
      method: 'POST',
      headers: { 'X-Dune-Api-Key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        performance: 'large',
        query_parameters: QUERY_PARAMETERS,
      }),
      redirect: 'error',
      signal: AbortSignal.timeout(HTTP_REQUEST_TIMEOUT_MS),
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
  const receipt = readExecutionReceipt(
    {
      schemaVersion: 1,
      executionId,
      queryId: QUERY_ID,
      ...pinnedQuery,
      parameters: QUERY_PARAMETERS,
      requestedPerformance: 'large',
      engineUsed: started.engine_used,
      requestStartedAt,
    },
    executionId,
  )
  saveReceipt(receipt)
  return pollDuneVolumeSnapshot(executionId, key, receipt, eligibleMints, deadline)
}

/** Resume an existing execution using safe reads only; the caller's budget also covers download. */
export async function pollDuneVolumeSnapshot(
  executionId: string,
  apiKey: string,
  inputReceipt: ExecutionReceipt,
  eligibleMints: string[],
  deadline = Date.now() + DUNE_QUERY_TIMEOUT_MS,
): Promise<VolumeSnapshot> {
  const key = apiKey.trim()
  if (!key) throw new Error('Set DUNE_API_KEY to read Dune results')
  const receipt = readExecutionReceipt(inputReceipt, executionId)
  let status: Record<string, unknown>
  for (;;) {
    if (Date.now() >= deadline) throw new Error('Dune execution deadline exceeded; execution was not retried')
    status = readObject(
      await fetchDunePage(`${DUNE_ORIGIN}/api/v1/execution/${executionId}/status`, key, deadline),
      'Dune execution status',
    )
    if (status.execution_id !== executionId || status.query_id !== QUERY_ID) {
      throw new Error('Dune status does not match the requested execution')
    }
    if (status.query_parameters !== undefined) {
      const parameters = readObject(status.query_parameters, 'execution parameters')
      if (
        parameters.days !== receipt.parameters.days ||
        parameters.min_volume_usd !== receipt.parameters.min_volume_usd
      )
        throw new Error('Dune execution parameters differ from its receipt')
    }
    if (
      status.submitted_at !== undefined &&
      Math.abs(Date.parse(readTimestamp(status.submitted_at)) - Date.parse(receipt.requestStartedAt)) > 5 * 60_000
    )
      throw new Error('Dune execution submission time differs from its receipt')
    console.log({ executionId, state: status.state, executionCostCredits: status.execution_cost_credits })
    if (status.state === 'QUERY_STATE_COMPLETED' && status.is_execution_finished === true && status.error == null) break
    if (
      status.is_execution_finished === true ||
      status.error != null ||
      !['QUERY_STATE_PENDING', 'QUERY_STATE_EXECUTING'].includes(String(status.state))
    ) {
      throw new Error('Dune execution did not complete: ' + String(status.state))
    }
    await setTimeout(Math.min(2_000, Math.max(0, deadline - Date.now())))
  }
  const details = readObject(status.result_metadata, 'Dune result metadata')
  // The query filters block_date < CURRENT_DATE, excluding the current UTC day.
  const startedAt = readTimestamp(status.execution_started_at)
  const executionEndedAt = readTimestamp(status.execution_ended_at)
  if (Date.parse(startedAt) > Date.parse(executionEndedAt)) throw new Error('Dune execution started after completion')
  const windowEnd = startedAt.slice(0, 10) + 'T00:00:00.000Z'
  const metadata = {
    queryId: QUERY_ID,
    executionId,
    executionEndedAt,
    windowEnd,
    rowCount: details.total_row_count,
  }
  const snapshot = await loadDuneVolumeSnapshot(metadata, key, eligibleMints, deadline)
  await verifyDuneRankingQuery(key, deadline)
  return snapshot
}

export const compareTokenAddresses = (a: { address: string }, b: { address: string }): number =>
  a.address < b.address ? -1 : a.address > b.address ? 1 : 0

function validateTokens(tokens: TokenInfo[]): void {
  const seen = new Set<string>()
  for (const token of tokens) {
    if (token.chainId !== 1000000001 || !isSolanaMint(token.address)) throw new Error('Invalid mint in Solana lists')
    if (seen.has(token.address)) throw new Error('Duplicate mint in Solana lists')
    seen.add(token.address)
  }
}

function withTokenRank(token: TokenInfo, rank: number | undefined): TokenInfo {
  const extensions = { ...token.extensions }
  delete extensions.rank
  if (rank !== undefined) extensions.rank = rank
  const result = { ...token }
  if (Object.keys(extensions).length) result.extensions = extensions
  else delete result.extensions
  return result
}

// Rank only current default-list mints. Extra Dune rows never add picker tokens.
// Average each mint's positions by 90-day and 30-day volume, breaking ties by mint.
export function prepareSolanaRankings(
  tokens: TokenInfo[],
  rwaTokens: TokenInfo[],
  snapshot: VolumeSnapshot,
): TokenInfo[] {
  validateTokens([...tokens, ...rwaTokens])

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

  return tokens.map((token) => withTokenRank(token, ranks.get(token.address)))
}

// A weekly PR changes this one file; daily generation only reads its approved ranks.
export const SNAPSHOT_PATH = 'src/public/TokenRanking.1000000001.json'

export interface RankingSnapshot {
  timestamp: string
  queryId: number
  executionId: string
  windowEnd: string
  rowCount: number
  eligibleMintsSha256: string
  ranks: Record<string, number>
}

export const membershipHash = (tokens: TokenInfo[]): string =>
  sha256(JSON.stringify(tokens.map((t) => t.address).sort()))

export function readRankingSnapshot(value: unknown): RankingSnapshot {
  const snapshot = value as RankingSnapshot
  if (!snapshot || typeof snapshot !== 'object' || ![8910905, QUERY_ID].includes(snapshot.queryId))
    throw new Error('Invalid ranking source query')
  const timestamp = Date.parse(readTimestamp(snapshot.timestamp))
  const windowEnd = Date.parse(readTimestamp(snapshot.windowEnd))
  if (
    !/^[A-Z0-9]{26}$/.test(snapshot.executionId) ||
    timestamp > Date.now() ||
    windowEnd > timestamp ||
    timestamp - windowEnd > DAY_MS + DUNE_QUERY_TIMEOUT_MS ||
    windowEnd % DAY_MS !== 0 ||
    !Number.isSafeInteger(snapshot.rowCount) ||
    snapshot.rowCount <= 0 ||
    !/^[a-f0-9]{64}$/.test(snapshot.eligibleMintsSha256) ||
    !snapshot.ranks ||
    typeof snapshot.ranks !== 'object' ||
    Array.isArray(snapshot.ranks)
  )
    throw new Error('Invalid ranking source provenance')
  const entries = Object.entries(snapshot.ranks)
  const ranks = new Set<number>()
  for (const [mint, rank] of entries) {
    if (!isSolanaMint(mint) || !Number.isSafeInteger(rank) || rank <= 0 || ranks.has(rank))
      throw new Error('Invalid or duplicate ranking mint/rank')
    ranks.add(rank)
  }
  if (!entries.length || entries.length > snapshot.rowCount) throw new Error('Empty or inconsistent ranking snapshot')
  return snapshot
}

export function loadApprovedRanking(): RankingSnapshot {
  return readRankingSnapshot(JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8')))
}

export function rankingFreshness(snapshot: RankingSnapshot): 'fresh' | 'grace' | 'expired' {
  const age = (Date.now() - Date.parse(snapshot.timestamp)) / DAY_MS
  if (age > RANK_EXPIRE_AFTER_DAYS) return 'expired'
  return age > RANK_WARN_AFTER_DAYS ? 'grace' : 'fresh'
}

/** Keep today's membership and metadata; copy only exact-mint ranks from the approved source. */
export function applyApprovedRanking(tokens: TokenInfo[], rwa: TokenInfo[], snapshot: RankingSnapshot): TokenInfo[] {
  validateTokens([...tokens, ...rwa])
  const status = rankingFreshness(snapshot)
  if (status !== 'fresh')
    console.warn(`Ranking source ${snapshot.timestamp} is ${status}. Execution ${snapshot.executionId}`)
  return tokens.map((token) => withTokenRank(token, status === 'expired' ? undefined : snapshot.ranks[token.address]))
}

export function validateRankingCandidate(next: RankingSnapshot, list: TokenList, rwa: TokenInfo[]): void {
  readRankingSnapshot(next)
  if (next.queryId !== QUERY_ID) throw new Error('Candidate uses a different source query')
  if (rankingFreshness(next) !== 'fresh') throw new Error('Ranking candidate source is stale')
  validateTokens([...list.tokens, ...rwa])
  if (next.eligibleMintsSha256 !== membershipHash(list.tokens)) {
    throw new Error(
      'Eligible membership changed on the current base. Regenerate from the existing execution and renew review.',
    )
  }
  const eligible = new Set(list.tokens.map((t) => t.address))
  if (Object.entries(next.ranks).some(([mint, rank]) => !eligible.has(mint) || rank > eligible.size))
    throw new Error('Candidate ranks ineligible mints')
}

function createRankingCandidate(list: TokenList, rwa: TokenInfo[], volume: VolumeSnapshot): RankingSnapshot {
  if (!volume.volumes.size) throw new Error('Empty ranking source')
  const tokens = prepareSolanaRankings(list.tokens, rwa, volume)
  const next: RankingSnapshot = {
    timestamp: volume.metadata.executionEndedAt,
    queryId: volume.metadata.queryId,
    executionId: volume.metadata.executionId,
    windowEnd: volume.metadata.windowEnd,
    rowCount: volume.metadata.rowCount,
    eligibleMintsSha256: membershipHash(tokens),
    ranks: Object.fromEntries(
      tokens
        .filter((t) => t.extensions?.rank !== undefined)
        .sort(compareTokenAddresses)
        .map((t) => [t.address, t.extensions!.rank as number]),
    ),
  }
  validateRankingCandidate(next, list, rwa)
  return next
}

const receiptPath = (id: string) => process.env.SOLANA_EXECUTION_RECEIPT || join(tmpdir(), `solana-ranking-${id}.json`)

function loadReceipt(executionId: string): ExecutionReceipt {
  const path = receiptPath(executionId)
  if (!fs.existsSync(path))
    throw new Error('Missing execution receipt. Restore the receipt from the original run before reusing its ID.')
  return readExecutionReceipt(JSON.parse(fs.readFileSync(path, 'utf8')), executionId)
}

function saveReceipt(receipt: ExecutionReceipt): void {
  const path = receiptPath(receipt.executionId)
  try {
    fs.writeFileSync(path + '.tmp', JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 })
    fs.renameSync(path + '.tmp', path)
  } finally {
    fs.rmSync(path + '.tmp', { force: true })
  }
  console.log('Dune execution receipt: ' + path)
}

/** Explicit weekly/manual mode. Daily generation never reaches Dune. */
export async function refreshSolanaRankings(executionId?: string): Promise<void> {
  const key = process.env.DUNE_API_KEY ?? ''
  const list = JSON.parse(fs.readFileSync('src/public/CowSwap.1000000001.json', 'utf8')) as TokenList
  const rwa = JSON.parse(fs.readFileSync('src/public/Rwa.1000000001.json', 'utf8')) as TokenList
  validateTokens([...list.tokens, ...rwa.tokens])
  const mints = list.tokens.map((token) => token.address)
  if (!mints.length) throw new Error('No eligible Solana mints to rank')
  // Save the paid request immediately, so recovery never needs another POST.
  const volume = executionId
    ? await pollDuneVolumeSnapshot(executionId, key, loadReceipt(executionId), mints)
    : await executeDuneVolumeSnapshot(key, mints, saveReceipt)
  const candidate = createRankingCandidate(list, rwa.tokens, volume)
  // Replace the proposal only after the complete result has passed validation.
  const staged = SNAPSHOT_PATH + '.tmp'
  try {
    fs.writeFileSync(staged, JSON.stringify(candidate, null, 2) + '\n')
    fs.renameSync(staged, SNAPSHOT_PATH)
  } finally {
    fs.rmSync(staged, { force: true })
  }
  console.log('Wrote ' + Object.keys(candidate.ranks).length + ' ranks from Dune execution ' + candidate.executionId)
}
