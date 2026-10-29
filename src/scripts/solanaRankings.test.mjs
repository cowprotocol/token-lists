import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { register } from 'node:module'
import { test } from 'node:test'

register('ts-node/esm', import.meta.url)
const { prepareSolanaRankings, loadDuneVolumeSnapshot, executeDuneVolumeSnapshot } = await import('./solanaRankings.ts')
const chainId = 1000000001
const sol = 'So11111111111111111111111111111111111111112'
const usdc = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const variant = usdc.replace('jF', 'JF')
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
  assert.throws(() => prepareSolanaRankings([token(sol)], [token(sol)], source([])), /overlap/)
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
const day = 86_400_000
const hash = (value) => createHash('sha256').update(value).digest('hex')

/** Use explicit synthetic provenance so historical test rows never become release data. */
function metadata(patch = {}) {
  const ended = Date.now() - 60_000
  return {
    queryId: 8910905,
    executionId,
    executionEndedAt: new Date(ended).toISOString(),
    windowDays: 90,
    windowStart: new Date(ended - 90 * day).toISOString(),
    windowEnd: new Date(ended).toISOString(),
    rowCount: 2,
    ...patch,
  }
}

/** Model one completed Dune page, with patches for failure and pagination cases. */
function page(meta, rows, nextOffset = null, patch = {}) {
  return {
    execution_id: meta.executionId,
    query_id: meta.queryId,
    is_execution_finished: true,
    state: 'QUERY_STATE_COMPLETED',
    execution_ended_at: meta.executionEndedAt,
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
    { rowCount: 250001 },
    { windowDays: 30 },
    { windowStart: 'invalid' },
    { executionEndedAt: future },
    {
      executionEndedAt: new Date(old).toISOString(),
      windowEnd: new Date(old).toISOString(),
      windowStart: new Date(old - 90 * day).toISOString(),
    },
    { windowStart: new Date(Date.now() - 88 * day).toISOString() },
    {
      windowEnd: new Date(Date.now() - 2 * day).toISOString(),
      windowStart: new Date(Date.now() - 92 * day).toISOString(),
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

test('reads all pages of one completed Dune execution with GET only and pinned provenance', async (t) => {
  const meta = metadata()
  const requests = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url: String(url), options })
    const offset = Number(new URL(url).searchParams.get('offset'))
    return Response.json(
      offset === 0 ? page(meta, [{ mint: sol, volume_90d: 200 }], 1) : page(meta, [{ mint: usdc, volume_90d: '100' }]),
    )
  })
  const result = await loadDuneVolumeSnapshot(meta, 'test-key')
  assert.deepEqual(
    [...result.volumes],
    [
      [sol, { volume90dUsd: 200, volume30dUsd: 200 }],
      [usdc, { volume90dUsd: 100, volume30dUsd: 100 }],
    ],
  )
  assert.equal(requests.length, 2)
  assert.deepEqual(
    requests.map(({ url }) => new URL(url).searchParams.get('offset')),
    ['0', '1'],
  )
  for (const { url, options } of requests) {
    assert.equal(new URL(url).origin, 'https://api.dune.com')
    assert.equal(new URL(url).pathname, '/api/v1/execution/' + executionId + '/results')
    assert.equal(new URL(url).searchParams.has('columns'), false)
    assert.equal(new URL(url).searchParams.get('allow_partial_results'), 'false')
    assert.equal(options.method, 'GET')
    assert.equal(options.redirect, 'error')
    assert.equal(options.headers['X-Dune-Api-Key'], 'test-key')
    assert.ok(options.signal instanceof AbortSignal)
  }
  const expectedRows = [
    [usdc, { volume90dUsd: 100, volume30dUsd: 100 }],
    [sol, { volume90dUsd: 200, volume30dUsd: 200 }],
  ]
  assert.equal(result.provenance.rowsSha256, hash(JSON.stringify(expectedRows)))
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

test('rejects partial, changing, truncated, duplicate, or unsafe paginated Dune results', async (t) => {
  const variants = [
    ['partial', (p) => ({ ...p, is_partial: true })],
    ['unfinished', (p) => ({ ...p, is_execution_finished: false })],
    ['failed state', (p) => ({ ...p, state: 'QUERY_STATE_FAILED' })],
    ['execution error', (p) => ({ ...p, error: { message: 'query failed' } })],
    ['wrong execution', (p) => ({ ...p, execution_id: 'different' })],
    ['wrong query', (p) => ({ ...p, query_id: 1 })],
    ['different completion', (p) => ({ ...p, execution_ended_at: '2020-01-01T00:00:00.000Z' })],
    ['truncated', (p) => ({ ...p, next_offset: null })],
    ['offset gap', (p) => ({ ...p, next_offset: 2 })],
    ['offset loop', (p) => ({ ...p, next_offset: 0 })],
    ['foreign next URI', (p) => ({ ...p, next_uri: 'https://example.com/steal?offset=1' })],
    [
      'wrong execution URI',
      (p) => ({ ...p, next_uri: 'https://api.dune.com/api/v1/execution/different/results?offset=1' }),
    ],
    [
      'changed count',
      (p) => ({ ...p, result: { ...p.result, metadata: { ...p.result.metadata, total_row_count: 3 } } }),
    ],
    [
      'missing column',
      (p) => ({ ...p, result: { ...p.result, metadata: { ...p.result.metadata, column_names: ['mint'] } } }),
    ],
    ['invalid numeric type', (p) => ({ ...p, result: { ...p.result, rows: [{ mint: sol, volume_90d: true }] } })],
  ]
  for (const [name, change] of variants) {
    await t.test(name, async (t) => {
      const meta = metadata()
      let calls = 0
      t.mock.method(globalThis, 'fetch', async () => {
        calls++
        return Response.json(change(page(meta, [{ mint: sol, volume_90d: 200 }], 1)))
      })
      await assert.rejects(loadDuneVolumeSnapshot(meta, 'test-key'))
      assert.equal(calls, 1)
    })
  }
  await t.test('duplicate across pages', async (t) => {
    const meta = metadata()
    let calls = 0
    t.mock.method(globalThis, 'fetch', async () =>
      Response.json(page(meta, [{ mint: sol, volume_90d: 100 }], ++calls === 1 ? 1 : null)),
    )
    await assert.rejects(loadDuneVolumeSnapshot(meta, 'test-key'), /Duplicate mint/)
    assert.equal(calls, 2)
  })
})

test('accepts either Dune metric column but rejects a changed schema across pages', async (t) => {
  for (const [column, key] of [
    ['volume_90d', 'volume90dUsd'],
    ['volume_30d', 'volume30dUsd'],
  ]) {
    const meta = metadata({ rowCount: 1 })
    t.mock.method(globalThis, 'fetch', async () =>
      Response.json(
        page(meta, [], null, {
          result: {
            metadata: { total_row_count: 1, column_names: ['mint', column] },
            rows: [{ mint: sol, [column]: 0 }],
          },
        }),
      ),
    )
    const result = await loadDuneVolumeSnapshot(meta, 'test-key')
    assert.deepEqual(result.volumes.get(sol), { volume90dUsd: null, volume30dUsd: null, [key]: 0 })
  }
  const meta = metadata()
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => {
    const column = ++calls === 1 ? 'volume_90d' : 'volume_30d'
    return Response.json(
      page(meta, [], calls === 1 ? 1 : null, {
        result: {
          metadata: { total_row_count: 2, column_names: ['mint', column] },
          rows: [{ mint: calls === 1 ? sol : usdc, [column]: 100 }],
        },
      }),
    )
  })
  await assert.rejects(loadDuneVolumeSnapshot(meta, 'test-key'), /columns changed/)
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

test('executes with verified parameters, uses complete UTC days and downloads every page from that execution', async (t) => {
  t.mock.method(Date, 'now', () => Date.parse('2026-10-29T14:00:00Z'))
  const meta = metadata({
    executionEndedAt: '2026-10-29T13:51:00.000Z',
    windowStart: '2026-07-31T00:00:00.000Z',
    windowEnd: '2026-10-29T00:00:00.000Z',
  })
  const requests = []
  let posted
  let polls = 0
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const u = new URL(url)
    requests.push([u.pathname, options.method])
    if (options.method === 'POST') {
      posted = options
      return Response.json({ execution_id: executionId, state: 'QUERY_STATE_PENDING' })
    }
    if (u.pathname.endsWith('/status')) {
      polls++
      return Response.json({
        execution_id: executionId,
        query_id: 8910905,
        state: polls === 1 ? 'QUERY_STATE_EXECUTING' : 'QUERY_STATE_COMPLETED',
        is_execution_finished: polls > 1,
        execution_started_at: '2026-10-29T13:50:00.123456Z',
        execution_ended_at: meta.executionEndedAt,
        result_metadata: { total_row_count: 2 },
      })
    }
    return Response.json(
      page(
        meta,
        [{ mint: u.searchParams.get('offset') === '0' ? sol : usdc, volume_90d: 100 }],
        u.searchParams.get('offset') === '0' ? 1 : null,
      ),
    )
  })
  const result = await executeDuneVolumeSnapshot('test-key')
  assert.deepEqual(result.metadata, meta)
  assert.deepEqual(JSON.parse(posted.body), { query_parameters: { days: 90, min_volume_usd: 100000 } })
  assert.equal(posted.headers['Content-Type'], 'application/json')
  assert.equal(result.volumes.size, 2)
  assert.equal(requests.filter(([, method]) => method === 'POST').length, 1)
  assert.ok(requests.slice(1).every(([path]) => path.includes(executionId)))
})

test('never retries an ambiguous paid execution and hides credentials in its error', async (t) => {
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => {
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
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    calls++
    if (options.method === 'POST') return Response.json({ execution_id: executionId })
    return Response.json({
      execution_id: executionId,
      query_id: 8910905,
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
  t.mock.method(globalThis, 'fetch', async () => {
    calls++
    return Response.json(
      calls === 1
        ? { execution_id: executionId }
        : { execution_id: executionId, query_id: 8910905, state: 'QUERY_STATE_CANCELLED', is_execution_finished: true },
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
  const now = Date.now()
  let ticks = 0
  t.mock.method(Date, 'now', () => now + (ticks++ === 0 ? 0 : 600_001))
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => {
    calls++
    return Response.json({ execution_id: executionId })
  })
  await assert.rejects(executeDuneVolumeSnapshot('test-key'), /deadline exceeded/)
  assert.equal(calls, 1)
})
