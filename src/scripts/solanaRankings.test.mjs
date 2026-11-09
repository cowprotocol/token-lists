import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { register } from 'node:module'
import { test } from 'node:test'

register('ts-node/esm', import.meta.url)
const rankings = await import('./solanaRankings.ts')
const { prepareSolanaRankings, verifyDuneRankingQuery } = rankings
const chainId = 1000000001
const sol = 'So11111111111111111111111111111111111111112'
const usdc = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const variant = usdc.replace('jF', 'JF')
const fixtureMints = [sol, usdc, variant]
const loadDuneVolumeSnapshot = (metadata, key) => rankings.loadDuneVolumeSnapshot(metadata, key, fixtureMints)
const executeDuneVolumeSnapshot = (key, saveReceipt) =>
  rankings.executeDuneVolumeSnapshot(key, fixtureMints, saveReceipt)
const querySql = 'select mint, symbol, volume_90d, volume_30d from test_volumes'
const queryPin = { queryVersion: 1, querySqlSha256: createHash('sha256').update(querySql.trimEnd()).digest('hex') }
// Pin only synthetic SQL in mocks; the real query lives in Dune.
rankings.DUNE_QUERY.sqlSha256 = queryPin.querySqlSha256
function mockDuneExecution(t, handler) {
  t.mock.method(globalThis, 'fetch', async (url, options) =>
    new URL(url).pathname === '/api/v1/query/9087267' && options.method === 'GET'
      ? Response.json({ query_id: 9087267, version: 1, query_sql: querySql })
      : handler(url, options),
  )
}
/** Build a token with normal metadata so extension tests catch accidental data loss. */
const token = (address, extensions) => ({
  chainId,
  address,
  name: address,
  symbol: address,
  decimals: 9,
  ...(extensions ? { extensions } : {}),
})
/** Build checked metric data without coupling membership tests to network loading. */
const source = (rows) => ({
  volumes: new Map(rows.map(([mint, long, short = long]) => [mint, { volume90dUsd: long, volume30dUsd: short }])),
})
/** Read generated extension values in the input order. */
const ranks = (tokens) => tokens.map((t) => t.extensions?.rank)

test('attaches equal-weight position ranks and preserves token metadata and existing extensions', () => {
  const tokens = [token(sol, { isToken2022: true }), token(usdc, { custom: 'keep' }), token(variant)]
  const before = structuredClone(tokens)
  const result = prepareSolanaRankings(
    tokens,
    [],
    source([
      [sol, 1000000, 1],
      [usdc, 900000, 100],
      [variant, 800000, 50],
    ]),
  )
  assert.deepEqual(ranks(result), [2, 1, 3])
  assert.deepEqual(result[0], { ...tokens[0], extensions: { isToken2022: true, rank: 2 } })
  assert.deepEqual(result[1].extensions, { custom: 'keep', rank: 1 })
  assert.deepEqual(tokens, before)
})

test('uses either metric, preserves zero and removes stale ranks when both metrics are missing', () => {
  const tokens = [token(sol, { rank: 12, isToken2022: true }), token(usdc), token(variant, { rank: 3 })]
  assert.deepEqual(
    ranks(
      prepareSolanaRankings(
        tokens,
        [],
        source([
          [sol, null, 0],
          [usdc, 0, null],
          [variant, null, null],
        ]),
      ),
    ),
    [2, 1, undefined],
  )
  const empty = prepareSolanaRankings(tokens, [], source([]))
  assert.deepEqual(ranks(empty), [undefined, undefined, undefined])
  assert.deepEqual(empty[0].extensions, { isToken2022: true })
  assert.equal(Object.hasOwn(empty[2], 'extensions'), false)
})

test('does not broaden membership, match a differently cased mint or rank RWA tokens', () => {
  const rwa = [token(variant)]
  const result = prepareSolanaRankings(
    [token(usdc), token(sol)],
    rwa,
    source([
      [variant, 100000],
      [sol, 0],
    ]),
  )
  assert.deepEqual(ranks(result), [undefined, 1])
  assert.equal(rwa[0].extensions, undefined)
  assert.throws(() => prepareSolanaRankings([token(sol)], [token(sol)], source([])), /Duplicate mint/)
  assert.throws(() => prepareSolanaRankings([token(sol), token(sol)], [], source([])), /Duplicate/)
})

test('real default membership and overrides remain separate from all real RWA mints', () => {
  /** Read the real lists independently of the small CLI membership fixture. */
  const read = (name) => JSON.parse(readFileSync(new URL('../public/' + name, import.meta.url)))
  const current = read('CowSwap.1000000001.json').tokens
  const rwa = read('Rwa.1000000001.json').tokens
  const overrides = read('SolanaOverrides.json')
  const result = prepareSolanaRankings(current, rwa, source([...current, ...rwa].map((t, i) => [t.address, i])))
  const eligible = new Set(result.map((t) => t.address))
  assert.deepEqual(eligible, new Set(current.map((t) => t.address)))
  for (const t of overrides) assert.ok(eligible.has(t.address))
  for (const t of rwa) assert.ok(!eligible.has(t.address))
  assert.ok(result.every((t) => Number.isSafeInteger(t.extensions.rank) && t.extensions.rank > 0))
})

const executionId = '01K8JEDB9CC4S5TR6V7W8X9Y0Z'
const receiptFixture = () => ({
  schemaVersion: 1,
  executionId,
  queryId: 9087267,
  ...queryPin,
  parameters: { days: 90, min_volume_usd: 100000 },
  requestedPerformance: 'large',
  requestStartedAt: '2026-10-29T13:49:59Z',
})
const day = 86_400_000

/** Use explicit synthetic provenance so historical test rows never become release data. */
function metadata(patch = {}) {
  const ended = Date.now() - 60_000
  return {
    queryId: 9087267,
    executionId,
    executionEndedAt: new Date(ended).toISOString(),
    windowEnd: new Date(ended).toISOString(),
    rowCount: 2,
    ...patch,
  }
}

function executionStatus(meta, patch = {}) {
  return {
    execution_id: meta.executionId,
    query_id: meta.queryId,
    is_execution_finished: true,
    state: 'QUERY_STATE_COMPLETED',
    execution_started_at: new Date(Date.parse(meta.executionEndedAt) - 60_000).toISOString(),
    execution_ended_at: meta.executionEndedAt,
    result_metadata: { total_row_count: meta.rowCount },
    ...patch,
  }
}

/** Model one completed Dune page, with patches for failure and pagination cases. */
function page(meta, rows, nextOffset = null, patch = {}) {
  return {
    ...executionStatus(meta),
    result: {
      metadata: { total_row_count: meta.rowCount, column_names: ['mint', 'volume_90d', 'volume_30d'] },
      rows: rows.map((row) => ({ volume_30d: row.volume_90d, ...row })),
    },
    next_offset: nextOffset,
    ...patch,
  }
}

test('reads zero and missing values without matching differently cased mints', async (t) => {
  const meta = metadata({ rowCount: 3 })
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json(
      page(meta, [
        { mint: sol, volume_90d: '2e2', volume_30d: '50.0' },
        { mint: usdc, volume_90d: 0, volume_30d: '0' },
        { mint: variant, volume_90d: '<nil>', volume_30d: '' },
      ]),
    ),
  )
  const result = await loadDuneVolumeSnapshot(meta, 'test-key')
  assert.deepEqual(
    [...result.volumes],
    [
      [sol, { volume90dUsd: 200, volume30dUsd: 50 }],
      [usdc, { volume90dUsd: 0, volume30dUsd: 0 }],
      [variant, { volume90dUsd: null, volume30dUsd: null }],
    ],
  )
})

test('rejects invalid mints and unreliable volume values in Dune rows', async (t) => {
  const meta = metadata({ rowCount: 1 })
  for (const mint of ['not-a-mint', '1111', '1'.repeat(44)]) {
    t.mock.method(globalThis, 'fetch', async () => Response.json(page(meta, [{ mint, volume_90d: 1 }])))
    await assert.rejects(loadDuneVolumeSnapshot(meta, 'test-key'), /Invalid mint/)
  }
  for (const value of ['-1', 'NaN', 'Infinity', '0x10', '9007199254740992', '1,000', true]) {
    t.mock.method(globalThis, 'fetch', async () => Response.json(page(meta, [{ mint: sol, volume_90d: value }])))
    await assert.rejects(loadDuneVolumeSnapshot(meta, 'test-key'), /volume/)
  }
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json(page(meta, [{ mint: sol, volume_90d: 100, volume_30d: -1 }])),
  )
  await assert.rejects(loadDuneVolumeSnapshot(meta, 'test-key'), /volume/)
})
test('rejects missing, stale, future, or inconsistent source metadata before fetching', async (t) => {
  const future = new Date(Date.now() + day).toISOString()
  const old = Date.now() - 8 * day
  const cases = [
    { queryId: 1 },
    { executionId: '' },
    { rowCount: -1 },
    { windowEnd: 'invalid' },
    { executionEndedAt: future },
    {
      executionEndedAt: new Date(old).toISOString(),
      windowEnd: new Date(old).toISOString(),
    },
    {
      windowEnd: new Date(Date.now() - 2 * day).toISOString(),
    },
  ]
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => {
    calls++
    throw new Error('must not fetch')
  })
  for (const patch of cases) await assert.rejects(loadDuneVolumeSnapshot(metadata(patch), 'test-key'))
  await assert.rejects(loadDuneVolumeSnapshot(null, 'test-key'))
  await assert.rejects(loadDuneVolumeSnapshot(metadata(), ''))
  assert.equal(calls, 0)
})

test('downloads only requested mints from a completed execution, including zero 30-day volume', async (t) => {
  const meta = metadata({ rowCount: 93000 })
  const requests = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url: String(url), options })
    return Response.json(
      page(meta, [
        { mint: sol, volume_90d: 200, volume_30d: 0 },
        { mint: usdc, volume_90d: '100' },
      ]),
    )
  })
  const result = await loadDuneVolumeSnapshot(meta, 'test-key')
  assert.deepEqual(
    [...result.volumes],
    [
      [sol, { volume90dUsd: 200, volume30dUsd: 0 }],
      [usdc, { volume90dUsd: 100, volume30dUsd: 100 }],
    ],
  )
  assert.equal(requests.length, 1)
  assert.equal(result.metadata.rowCount, 2)
  for (const { url, options } of requests) {
    assert.equal(new URL(url).origin, 'https://api.dune.com')
    assert.equal(new URL(url).pathname, '/api/v1/execution/' + executionId + '/results')
    assert.equal(new URL(url).searchParams.has('columns'), false)
    assert.equal(new URL(url).searchParams.get('allow_partial_results'), 'false')
    assert.equal(new URL(url).searchParams.get('filters'), `mint IN ('${sol}','${usdc}','${variant}')`)
    assert.equal(options.method, 'GET')
    assert.equal(options.redirect, 'error')
    assert.equal(options.headers['X-Dune-Api-Key'], 'test-key')
    assert.ok(options.signal instanceof AbortSignal)
  }
})

test('batches mint filters and accepts empty matches without downloading the full source', async (t) => {
  const mints = JSON.parse(readFileSync(new URL('../public/CowSwap.1000000001.json', import.meta.url)))
    .tokens.slice(0, 201)
    .map((token) => token.address)
  const requested = []
  const meta = metadata({ rowCount: 93000 })
  t.mock.method(globalThis, 'fetch', async (input) => {
    const url = new URL(input)
    const batch = [...url.searchParams.get('filters').matchAll(/'([^']+)'/g)].map((match) => match[1])
    requested.push(batch)
    assert.ok(batch.length <= 100)
    assert.ok(url.href.length < 8192)
    const rows = requested.length === 2 ? [] : [{ mint: batch[0], volume_90d: 1 }]
    return Response.json(page(meta, rows))
  })
  const result = await rankings.loadDuneVolumeSnapshot(meta, 'test-key', mints)
  assert.deepEqual(requested.flat(), mints)
  assert.equal(result.volumes.size, 2)
  assert.equal(result.metadata.rowCount, 2)
})

test('retries rate limits and transient server errors before accepting a completed result', async (t) => {
  const meta = metadata({ rowCount: 1 })
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => {
    calls++
    return calls < 3
      ? new Response(null, { status: calls === 1 ? 429 : 503 })
      : Response.json(page(meta, [{ mint: sol, volume_90d: 100 }]))
  })
  assert.equal((await loadDuneVolumeSnapshot(meta, 'test-key')).volumes.get(sol).volume90dUsd, 100)
  assert.equal(calls, 3)
})

test('bounds network/timeout retries and does not put credentials or response bodies in errors', async (t) => {
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => {
    calls++
    throw new DOMException('secret-key', 'TimeoutError')
  })
  await assert.rejects(
    loadDuneVolumeSnapshot(metadata(), 'secret-key'),
    (error) => /3 attempts/.test(error.message) && !error.message.includes('secret-key'),
  )
  assert.equal(calls, 3)
})

test('rejects incomplete, unrelated or malformed filtered Dune results', async (t) => {
  const variants = [
    ['partial', (p) => ({ ...p, is_partial: true })],
    ['unfinished', (p) => ({ ...p, is_execution_finished: false })],
    ['failed state', (p) => ({ ...p, state: 'QUERY_STATE_FAILED' })],
    ['execution error', (p) => ({ ...p, error: { message: 'query failed' } })],
    ['wrong execution', (p) => ({ ...p, execution_id: 'different' })],
    ['wrong query', (p) => ({ ...p, query_id: 1 })],
    ['different completion', (p) => ({ ...p, execution_ended_at: '2020-01-01T00:00:00.000Z' })],
    ['unexpected pagination', (p) => ({ ...p, next_offset: 1 })],
    [
      'changed count',
      (p) => ({ ...p, result: { ...p.result, metadata: { ...p.result.metadata, total_row_count: 3 } } }),
    ],
    [
      'missing column',
      (p) => ({ ...p, result: { ...p.result, metadata: { ...p.result.metadata, column_names: ['mint'] } } }),
    ],
    ['invalid numeric type', (p) => ({ ...p, result: { ...p.result, rows: [{ mint: sol, volume_90d: true }] } })],
    [
      'unrequested mint',
      (p) => ({ ...p, result: { ...p.result, rows: [{ mint: '11111111111111111111111111111111', volume_90d: 1 }] } }),
    ],
    ['duplicate mint', (p) => ({ ...p, result: { ...p.result, rows: [p.result.rows[0], p.result.rows[0]] } })],
  ]
  for (const [name, change] of variants) {
    await t.test(name, async (t) => {
      const meta = metadata()
      let calls = 0
      t.mock.method(globalThis, 'fetch', async () => {
        calls++
        return Response.json(change(page(meta, [{ mint: sol, volume_90d: 200 }])))
      })
      await assert.rejects(loadDuneVolumeSnapshot(meta, 'test-key'))
      assert.equal(calls, 1)
    })
  }
})

test('requires both volume columns returned by the pinned query', async (t) => {
  const meta = metadata({ rowCount: 1 })
  for (const column of ['volume_90d', 'volume_30d']) {
    const response = page(meta, [{ mint: sol, volume_90d: 100 }])
    response.result.metadata.column_names = ['mint', column]
    t.mock.method(globalThis, 'fetch', async () => Response.json(response))
    await assert.rejects(loadDuneVolumeSnapshot(meta, 'test-key'), /columns/)
  }
})

test('keeps HTTP error response bodies and credentials out of client and server errors', async (t) => {
  for (const status of [401, 503]) {
    await t.test('HTTP ' + status, async (t) => {
      let calls = 0
      t.mock.method(globalThis, 'fetch', async () => {
        calls++
        return new Response('private-server-response', { status })
      })
      await assert.rejects(
        loadDuneVolumeSnapshot(metadata(), 'private-api-key'),
        (error) =>
          error.message.includes('HTTP ' + status) &&
          !error.message.includes('private-server-response') &&
          !error.message.includes('private-api-key'),
      )
      assert.equal(calls, status === 401 ? 1 : 3)
    })
  }
})

test('accepts Dune documented nanosecond completion timestamps and normalizes them deterministically', async (t) => {
  const original = metadata({ rowCount: 1 })
  const input = { ...original, executionEndedAt: original.executionEndedAt.replace('Z', '654321Z') }
  t.mock.method(globalThis, 'fetch', async () => Response.json(page(input, [{ mint: sol, volume_90d: 100 }])))
  const result = await loadDuneVolumeSnapshot(input, 'test-key')
  assert.equal(result.metadata.executionEndedAt, original.executionEndedAt)
  assert.equal(result.volumes.get(sol).volume90dUsd, 100)
})

test('executes once with verified parameters and uses complete UTC days', async (t) => {
  t.mock.method(Date, 'now', () => Date.parse('2026-10-29T14:00:00Z'))
  const meta = metadata({
    executionEndedAt: '2026-10-29T13:51:00.000Z',
    windowEnd: '2026-10-29T00:00:00.000Z',
  })
  const requests = []
  let posted
  let polls = 0
  let savedReceipt
  mockDuneExecution(t, async (url, options) => {
    const u = new URL(url)
    requests.push([u.pathname, options.method])
    if (options.method === 'POST') {
      posted = options
      return Response.json({ execution_id: executionId, state: 'QUERY_STATE_PENDING' })
    }
    if (u.pathname.endsWith('/status')) {
      assert.equal(savedReceipt.executionId, executionId)
      assert.deepEqual(savedReceipt.parameters, { days: 90, min_volume_usd: 100000 })
      polls++
      return Response.json(
        executionStatus(meta, {
          state: polls === 1 ? 'QUERY_STATE_EXECUTING' : 'QUERY_STATE_COMPLETED',
          is_execution_finished: polls > 1,
          execution_started_at: '2026-10-29T13:50:00.123456Z',
        }),
      )
    }
    return Response.json(
      page(
        meta,
        [sol, usdc].map((mint) => ({ mint, volume_90d: 100 })),
      ),
    )
  })
  const result = await executeDuneVolumeSnapshot('test-key', (receipt) => {
    savedReceipt = receipt
  })
  assert.deepEqual(result.metadata, meta)
  assert.deepEqual(JSON.parse(posted.body), {
    performance: 'large',
    query_parameters: { days: 90, min_volume_usd: 100000 },
  })
  assert.equal(posted.headers['Content-Type'], 'application/json')
  assert.equal(result.volumes.size, 2)
  assert.equal(requests.filter(([, method]) => method === 'POST').length, 1)
  assert.ok(requests.slice(1).every(([path]) => path.includes(executionId)))
})

test('accepts a Dune execution crossing midnight without moving its UTC volume window', async (t) => {
  t.mock.method(Date, 'now', () => Date.parse('2026-10-30T00:31:00Z'))
  const meta = metadata({
    executionEndedAt: '2026-10-30T00:03:00.000Z',
    windowEnd: '2026-10-29T00:00:00.000Z',
    rowCount: 1,
  })
  let posts = 0
  mockDuneExecution(t, async (url, options) => {
    if (options.method === 'POST') {
      posts++
      return Response.json({ execution_id: executionId })
    }
    if (new URL(url).pathname.endsWith('/status')) {
      return Response.json(executionStatus(meta, { execution_started_at: '2026-10-29T23:58:00Z' }))
    }
    return Response.json(page(meta, [{ mint: sol, volume_90d: 100 }]))
  })
  const result = await executeDuneVolumeSnapshot('test-key')
  assert.deepEqual(result.metadata, meta)
  assert.equal(result.volumes.get(sol).volume90dUsd, 100)
  assert.equal(posts, 1)

  const atLimit = { ...meta, executionEndedAt: '2026-10-30T00:30:00.000Z' }
  t.mock.method(globalThis, 'fetch', async () => Response.json(page(atLimit, [{ mint: sol, volume_90d: 100 }])))
  assert.equal((await loadDuneVolumeSnapshot(atLimit, 'test-key')).volumes.size, 1)
  t.mock.method(globalThis, 'fetch', async () => assert.fail('Late metadata must fail before fetching'))
  await assert.rejects(
    loadDuneVolumeSnapshot({ ...meta, executionEndedAt: '2026-10-30T00:30:00.001Z' }, 'test-key'),
    /inconsistent window/,
  )
})

test('never retries an ambiguous paid execution and hides credentials in its error', async (t) => {
  let calls = 0
  mockDuneExecution(t, async () => {
    calls++
    throw new Error('private-api-key')
  })
  await assert.rejects(
    executeDuneVolumeSnapshot('private-api-key'),
    (error) => /not retried/.test(error.message) && !error.message.includes('private-api-key'),
  )
  assert.equal(calls, 1)
})

test('rejects reversed execution times before flooring the window to a complete UTC day', async (t) => {
  t.mock.method(Date, 'now', () => Date.parse('2026-10-29T14:00:00Z'))
  let calls = 0
  mockDuneExecution(t, async (_url, options) => {
    calls++
    if (options.method === 'POST') return Response.json({ execution_id: executionId })
    return Response.json({
      execution_id: executionId,
      query_id: 9087267,
      state: 'QUERY_STATE_COMPLETED',
      is_execution_finished: true,
      execution_started_at: '2026-10-29T23:00:00Z',
      execution_ended_at: '2026-10-29T13:55:00Z',
      result_metadata: { total_row_count: 0 },
    })
  })
  await assert.rejects(executeDuneVolumeSnapshot('test-key'), /started after completion/)
  assert.equal(calls, 2)
})

test('fails live runs before POST without a key and rejects terminal failed executions', async (t) => {
  let calls = 0
  mockDuneExecution(t, async () => {
    calls++
    return Response.json(
      calls === 1
        ? { execution_id: executionId }
        : { execution_id: executionId, query_id: 9087267, state: 'QUERY_STATE_CANCELLED', is_execution_finished: true },
    )
  })
  await assert.rejects(executeDuneVolumeSnapshot(''), /DUNE_API_KEY/)
  assert.equal(calls, 0)
  await assert.rejects(executeDuneVolumeSnapshot('test-key'), /QUERY_STATE_CANCELLED/)
  assert.equal(calls, 2)
})

test('accepts a complete empty source without a coverage threshold', async (t) => {
  const meta = metadata({ rowCount: 0 })
  t.mock.method(globalThis, 'fetch', async () => Response.json(page(meta, [])))
  assert.equal((await loadDuneVolumeSnapshot(meta, 'test-key')).volumes.size, 0)
})

test('bounds execution polling without starting another paid execution', async (t) => {
  let current = Date.now()
  t.mock.method(Date, 'now', () => current)
  let calls = 0
  mockDuneExecution(t, async () => {
    calls++
    current += 1_800_001
    return Response.json({ execution_id: executionId })
  })
  await assert.rejects(executeDuneVolumeSnapshot('test-key'), /deadline exceeded/)
  assert.equal(calls, 1)
})

test('the same thirty-minute deadline covers submission, polling and final result retrieval', async (t) => {
  const start = Date.parse('2026-11-07T12:00:00Z')
  let current = start
  t.mock.method(Date, 'now', () => current)
  let posts = 0
  const meta = metadata({
    executionEndedAt: '2026-11-07T12:29:00.000Z',
    windowEnd: '2026-11-07T00:00:00.000Z',
    rowCount: 1,
  })
  mockDuneExecution(t, async (input, options) => {
    if (options.method === 'POST') {
      posts++
      current += 28 * 60_000
      return Response.json({ execution_id: executionId })
    }
    if (new URL(input).pathname.endsWith('/status')) {
      current += 60_000
      return Response.json(executionStatus(meta, { execution_started_at: new Date(start).toISOString() }))
    }
    current += 60_000
    return Response.json(page(meta, [{ mint: sol, volume_90d: 100 }]))
  })
  await assert.rejects(executeDuneVolumeSnapshot('test-key'), /deadline exceeded/)
  assert.equal(posts, 1)
  assert.equal(current - start, 30 * 60_000)
})

test('query preflight uses safe reads and rejects changed SQL/version before any paid execution', async (t) => {
  const sql = querySql
  let calls = 0
  for (const patch of [{}, { query_sql: sql + '-- changed' }, { version: 2 }]) {
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      calls++
      assert.equal(options.method, 'GET')
      assert.equal(new URL(url).pathname, '/api/v1/query/9087267')
      return Response.json({ query_id: 9087267, version: 1, query_sql: sql, ...patch })
    })
    if (Object.keys(patch).length)
      await assert.rejects(verifyDuneRankingQuery('test-key'), /differs from the reviewed query/)
    else assert.equal((await verifyDuneRankingQuery('test-key')).queryVersion, 1)
  }
  assert.equal(calls, 3)
})

test('recovery rejects an execution without a matching receipt before any Dune read', async (t) => {
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => {
    calls++
    return Response.json({ query_id: 9087267, execution_id: executionId, query_parameters: { days: 30 } })
  })
  await assert.rejects(rankings.pollDuneVolumeSnapshot(executionId, 'test-key'), /receipt/i)
  assert.equal(calls, 0)
})

test('recovery receipts reject other executions, parameters, SQL versions and engine tiers', () => {
  const receipt = receiptFixture()
  assert.equal(rankings.readExecutionReceipt(receipt, executionId).queryVersion, 1)
  assert.equal(rankings.readExecutionReceipt({ ...receipt, engineUsed: 'large' }, executionId).executionId, executionId)
  for (const patch of [
    { executionId: '01AAAAAAAAAAAAAAAAAAAAAAAA' },
    { parameters: { days: 30, min_volume_usd: 100000 } },
    { parameters: { days: 90, min_volume_usd: 1 } },
    { queryVersion: 2 },
    { querySqlSha256: '0'.repeat(64) },
    { requestedPerformance: 'medium' },
    { engineUsed: 'medium' },
  ])
    assert.throws(() => rankings.readExecutionReceipt({ ...receipt, ...patch }, executionId), /receipt/i)
})

test('recovery verifies receipt settings against any execution-specific metadata and uses safe reads only', async (t) => {
  t.mock.method(Date, 'now', () => Date.parse('2026-10-29T14:00:00Z'))
  const meta = metadata({ rowCount: 1 })
  for (const patch of [
    {},
    { query_parameters: { days: 30, min_volume_usd: 100000 } },
    { submitted_at: '2026-10-29T12:00:00Z' },
  ]) {
    let resultReads = 0
    mockDuneExecution(t, async (input, options) => {
      assert.equal(options.method, 'GET')
      if (new URL(input).pathname.endsWith('/status'))
        return Response.json(
          executionStatus(meta, {
            submitted_at: '2026-10-29T13:50:00Z',
            execution_started_at: '2026-10-29T13:50:00Z',
            query_parameters: { days: 90, min_volume_usd: 100000 },
            ...patch,
          }),
        )
      resultReads++
      return Response.json(page(meta, [{ mint: sol, volume_90d: 100 }]))
    })
    if (Object.keys(patch).length) {
      await assert.rejects(
        rankings.pollDuneVolumeSnapshot(executionId, 'test-key', receiptFixture(), fixtureMints),
        /receipt/i,
      )
      assert.equal(resultReads, 0)
    } else {
      const snapshot = await rankings.pollDuneVolumeSnapshot(executionId, 'test-key', receiptFixture(), fixtureMints)
      assert.equal(snapshot.metadata.executionId, executionId)
      assert.equal(resultReads, 1)
    }
  }
})

test('a query edit after submission rejects the completed result instead of stamping new provenance', async (t) => {
  t.mock.method(Date, 'now', () => Date.parse('2026-10-29T14:00:00Z'))
  const meta = metadata({ rowCount: 1 })
  let queryReads = 0
  let posts = 0
  let receipt
  t.mock.method(globalThis, 'fetch', async (input, options) => {
    const path = new URL(input).pathname
    if (path === '/api/v1/query/9087267')
      return Response.json({
        query_id: 9087267,
        version: ++queryReads,
        query_sql: querySql,
      })
    if (options.method === 'POST') {
      posts++
      return Response.json({ execution_id: executionId })
    }
    if (path.endsWith('/status'))
      return Response.json(executionStatus(meta, { execution_started_at: '2026-10-29T13:50:00Z' }))
    return Response.json(page(meta, [{ mint: sol, volume_90d: 100 }]))
  })
  await assert.rejects(
    executeDuneVolumeSnapshot('test-key', (value) => {
      receipt = value
    }),
    /SQL\/version differs/,
  )
  assert.equal(posts, 1)
  assert.equal(receipt.queryVersion, 1)
  assert.equal(queryReads, 2)
})

// Saved ranks keep daily generation independent from Dune.
const { applyApprovedRanking, membershipHash, rankingFreshness, readRankingSnapshot, validateRankingCandidate } =
  rankings
const tokens = [token(sol), token(usdc)]
const now = Date.parse('2026-11-07T12:00:00Z')
const ended = '2026-11-07T11:00:00.000Z'

function snapshot() {
  return {
    timestamp: ended,
    queryId: 9087267,
    executionId: '01M6TRHC2XKY4T9J45QXVJFZ0P',
    windowEnd: '2026-11-07T00:00:00.000Z',
    rowCount: 2,
    eligibleMintsSha256: membershipHash(tokens),
    ranks: Object.fromEntries(tokens.map((t, i) => [t.address, i + 1])),
  }
}
const list = () => ({ timestamp: new Date(now).toISOString(), tokens })

test('ranking source age has an eight-day warning boundary and a seven-day grace period', (t) => {
  const approved = snapshot()
  const start = Date.parse(ended)
  for (const [age, expected] of [
    [8 * day, 'fresh'],
    [8 * day + 1, 'grace'],
    [15 * day, 'grace'],
    [15 * day + 1, 'expired'],
  ]) {
    t.mock.method(Date, 'now', () => start + age)
    assert.equal(rankingFreshness(approved), expected)
    assert.equal(
      applyApprovedRanking([tokens[0]], [], approved)[0].extensions?.rank,
      expected === 'expired' ? undefined : 1,
    )
  }
  assert.equal(approved.timestamp, ended)
})

test('snapshot rejects malformed, empty, future, duplicate and frontend-invalid ranks', (t) => {
  t.mock.method(Date, 'now', () => now)
  for (const rank of [0, -1, '1', null, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const bad = snapshot()
    bad.ranks[tokens[0].address] = rank
    assert.throws(() => readRankingSnapshot(bad))
  }
  for (const patch of [
    { ranks: {} },
    { queryId: 1 },
    { rowCount: 0 },
    { ranks: { [sol]: 1, [usdc]: 1 } },
    { eligibleMintsSha256: 'bad' },
    { timestamp: '2026-11-08T00:00:00.000Z' },
  ])
    assert.throws(() => readRankingSnapshot({ ...snapshot(), ...patch }))
})

test('ranking proposals allow volume changes but reject stale sources and different membership', (t) => {
  t.mock.method(Date, 'now', () => now)
  for (const ranks of [{ [sol]: 2, [usdc]: 1 }, { [sol]: 1 }])
    assert.doesNotThrow(() => validateRankingCandidate({ ...snapshot(), ranks }, list(), []))
  for (const [patch, error] of [
    [{ eligibleMintsSha256: 'b'.repeat(64) }, /membership changed/],
    [{ queryId: 8910905 }, /different source/],
    [{ ranks: { [variant]: 1 } }, /ineligible mints/],
    [{ ranks: { [sol]: 3 } }, /ineligible mints/],
  ]) {
    assert.throws(() => validateRankingCandidate({ ...snapshot(), ...patch }, list(), []), error)
  }
  assert.throws(() => validateRankingCandidate(snapshot(), list(), [tokens[0]]), /Duplicate mint/)
  t.mock.method(Date, 'now', () => now + 9 * day)
  assert.throws(() => validateRankingCandidate(snapshot(), list(), []), /stale/)
})
