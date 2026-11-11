import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { register } from 'node:module'
import { createHash } from 'node:crypto'
import fs, { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import csv from 'csv-parser'
import Ajv from 'ajv'
import addFormats from 'ajv-formats'

register('ts-node/esm', import.meta.url)
const { main } = await import('./solana.ts')
const { DUNE_QUERY } = await import('./solanaRankings.ts')

const repo = new URL('../../', import.meta.url)
// The upstream TokenList schema assumes hex addresses; retain its other constraints for Solana.
const schema = JSON.parse(readFileSync(new URL('node_modules/@uniswap/token-lists/dist/tokenlist.schema.json', repo)))
schema.definitions.TokenInfo.properties.address.pattern = '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
schema.definitions.TokenInfo.properties.symbol = { type: 'string', minLength: 1, maxLength: 20 }
schema.definitions.TokenInfo.properties.name.maxLength = 128
const ajv = new Ajv({ allErrors: true, strict: false })
addFormats(ajv)
const validateList = ajv.compile(schema)
const defaultFile = 'CowSwap.1000000001.json'
const rwaFile = 'Rwa.1000000001.json'
const nativeSol = '11111111111111111111111111111111'
const wrappedSol = 'So11111111111111111111111111111111111111112'
const tokenProgram = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
const token2022Program = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'
const executionId = '01K8JEDB9CC4S5TR6V7W8X9Y0Z'
/** Read the checked-in membership independently of the generator. */
const readPublic = (name) => JSON.parse(readFileSync(new URL('src/public/' + name, repo)))
const defaultList = readPublic(defaultFile)
const rwaList = readPublic(rwaFile)
const overrides = readPublic('SolanaOverrides.json')
// Historical solana-qos/token-universe data; expected ranks were calculated independently with Python Decimal.
const historicalCsv = readFileSync(new URL('./fixtures/solana-volume-2026-10.csv', import.meta.url), 'utf8')
const rows = []
for await (const row of Readable.from([historicalCsv]).pipe(csv({ strict: true }))) rows.push(row)
const eligibleRows = rows.filter((row) => row.rank !== '')
const expectedRanks = Object.fromEntries(eligibleRows.map((row) => [row.mint, Number(row.rank)]))
const unmeasured = defaultList.tokens.find((t) => t.address !== nativeSol && !Object.hasOwn(expectedRanks, t.address))
const members = [
  ...eligibleRows.map(
    (row) =>
      defaultList.tokens.find((t) => t.address === row.mint) ?? {
        chainId: 1000000001,
        address: row.mint,
        name: row.name,
        symbol: row.symbol,
        decimals: 9,
      },
  ),
  defaultList.tokens.find((t) => t.address === nativeSol),
  unmeasured,
]
const rwa = rwaList.tokens.find((t) => rows.some((row) => row.mint === t.address))
const outsiders = defaultList.tokens.filter((t) => !members.some((m) => m.address === t.address)).slice(0, 5)
/** Pin exact CSV bytes rather than deriving expected ranks from production code. */
const hash = (value) => createHash('sha256').update(value).digest('hex')
/** Model provider metadata, retaining the program that controls generated extensions. */
const jupiter = (token) => ({
  id: token.address,
  name: token.name,
  symbol: token.symbol,
  decimals: token.decimals,
  icon: token.logoURI,
  tokenProgram: token.extensions?.isToken2022 ? token2022Program : tokenProgram,
  tags: ['strict'],
})

// Each test writes to its own folder and mocks APIs before calling the real entry point.
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'solana-test-'))
  const cwd = process.cwd()
  process.chdir(root)
  t.after(() => {
    process.chdir(cwd)
    rmSync(root, { recursive: true, force: true })
  })
  mkdirSync('src/public', { recursive: true })
  const read = (name) => JSON.parse(readFileSync(join(root, 'src/public', name)))
  const write = (name, value) => writeFileSync(join(root, 'src/public', name), JSON.stringify(value))
  write(defaultFile, { ...defaultList, version: { major: 2, minor: 3, patch: 4 }, tokens: members })
  write(rwaFile, { ...rwaList, tokens: [rwa] })
  write('SolanaOverrides.json', overrides)
  const sourceDay = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
  const snapshot = {
    timestamp: sourceDay + 'T12:01:00.000Z',
    queryId: DUNE_QUERY.id,
    executionId,
    windowEnd: sourceDay + 'T00:00:00.000Z',
    rowCount: rows.length,
    eligibleMintsSha256: hash(JSON.stringify(members.map((m) => m.address).sort())),
    ranks: expectedRanks,
  }
  write('TokenRanking.1000000001.json', snapshot)
  const providers = {
    jupiter: [
      ...members.filter((t) => t.address !== nativeSol).map(jupiter),
      { ...jupiter(rwa), tags: ['strict', 'rwa'] },
    ],
    coingecko: { tokens: [...members, rwa] },
  }
  const requests = []
  const output = []
  t.mock.method(console, 'log', (...args) => output.push(args.join(' ')))
  t.mock.method(console, 'warn', (...args) => output.push(args.join(' ')))
  t.mock.method(globalThis, 'fetch', async (input, options = {}) => {
    const url = new URL(input)
    requests.push({ url: String(url), method: options.method ?? 'GET' })
    if (url.host === 'lite-api.jup.ag') {
      if (!url.pathname.endsWith('/shield'))
        return Response.json(url.pathname.endsWith('/search') ? providers.jupiterLookup ?? [] : providers.jupiter)
      if (providers.shieldFailure) return new Response('{}', { status: 400 })
      const mints = url.searchParams.get('mints').split(',')
      return Response.json({
        warnings: Object.fromEntries(
          Object.entries(providers.shield?.warnings ?? {}).filter(([mint]) => mints.includes(mint)),
        ),
      })
    }
    if (url.host === 'tokens.coingecko.com') return Response.json(providers.coingecko)
    throw new Error('Unexpected HTTP request ' + url)
  })

  const run = async (args = [], env = {}) => {
    const values = {
      DUNE_API_KEY: 'test-key-never-log',
      SOLANA_EXECUTION_RECEIPT: join(root, 'execution-receipt.json'),
      RANKING_BASE_REF: '',
      ...env,
    }
    const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]))
    Object.assign(process.env, values)
    try {
      await main(args)
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  }
  const preserved = () =>
    [defaultFile, rwaFile, 'SolanaOverrides.json'].map((file) => hash(readFileSync(join(root, 'src/public', file))))
  const refresh = (args = [], env = {}) => run(['--refresh-rankings', ...args], env)
  return { root, providers, run, refresh, read, write, preserved, snapshot, requests, output }
}

/** A tree object supplies trusted base files without creating any commits. */
function validationBase(f, includeSnapshot = true) {
  const git = (args) =>
    execFileSync('git', args, { cwd: f.root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git(['init', '--quiet'])
  git(['add', '--', 'src/public'])
  if (!includeSnapshot) git(['update-index', '--force-remove', 'src/public/TokenRanking.1000000001.json'])
  return git(['write-tree'])
}

function changedCandidate(f) {
  const candidate = structuredClone(f.snapshot)
  const [first, second] = Object.keys(candidate.ranks).sort((a, b) => candidate.ranks[a] - candidate.ranks[b])
  ;[candidate.ranks[first], candidate.ranks[second]] = [candidate.ranks[second], candidate.ranks[first]]
  return candidate
}

test('existing provider eligibility, overrides, native SOL and RWA separation survive generation', async (t) => {
  const f = fixture(t)
  f.providers.jupiter.find((token) => token.id === wrappedSol).name = 'Changed Jupiter name'
  f.providers.jupiter.push(
    { ...jupiter(outsiders[0]), audit: { isSus: true } },
    { ...jupiter(outsiders[1]), tags: [], organicScore: 24 },
    { ...jupiter(outsiders[2]), name: '' },
    { ...jupiter(outsiders[3]), tokenProgram: 'unknown' },
    jupiter(outsiders[4]), // Not on CoinGecko.
  )
  f.providers.coingecko.tokens.push(...outsiders.slice(0, 4))
  await f.run([], { DUNE_API_KEY: '' })
  const requests = f.requests
  assert.ok(requests.every((request) => !request.url.includes('api.dune.com')))
  const list = f.read(defaultFile)
  assert.equal(list.tokens.length, 100)
  assert.deepEqual(
    list.tokens.map((t) => t.address),
    members.map((t) => t.address).sort(),
  )
  assert.ok(list.tokens.some((t) => t.address === nativeSol))
  assert.equal(
    list.tokens.find((t) => t.address === wrappedSol).name,
    overrides.find((t) => t.address === wrappedSol).name,
  )
  assert.deepEqual(f.read(rwaFile).tokens, [rwa])
  assert.equal(f.read(rwaFile).tokens[0].extensions?.rank, undefined)
  assert.equal(f.read(defaultFile).tokens.find((t) => t.address === unmeasured.address).address, unmeasured.address)
})

test('ranking validation accepts unchanged legacy snapshots and bootstraps only approved ranks', async (t) => {
  const f = fixture(t)
  const candidate = { ...f.snapshot, queryId: 8910905 }
  f.write('TokenRanking.1000000001.json', candidate)
  await f.run()
  const base = validationBase(f, false)
  await f.run(['--validate'], { RANKING_BASE_REF: base })
  const baseWithSnapshot = validationBase(f)
  f.write('TokenRanking.1000000001.json', {
    ...Object.fromEntries(Object.entries(candidate).reverse()),
    ranks: Object.fromEntries(Object.entries(candidate.ranks).reverse()),
  })
  await f.run(['--validate'], { RANKING_BASE_REF: baseWithSnapshot })
  const altered = changedCandidate({ ...f, snapshot: candidate })
  f.write('TokenRanking.1000000001.json', altered)
  await assert.rejects(() => f.run(['--validate'], { RANKING_BASE_REF: base }), /Initial snapshot must preserve/)
})

test('ranking validation accepts a pending candidate, but public lists must keep the approved ranks', async (t) => {
  const f = fixture(t)
  await f.run()
  const base = validationBase(f)
  const validate = () => f.run(['--validate'], { RANKING_BASE_REF: base })
  await validate()
  const before = f.preserved()
  f.write('TokenRanking.1000000001.json', changedCandidate(f))
  await validate()
  assert.deepEqual(f.preserved(), before)
  const list = f.read(defaultFile)
  const ranked = list.tokens.filter((token) => token.extensions?.rank)
  ;[ranked[0].extensions.rank, ranked[1].extensions.rank] = [ranked[1].extensions.rank, ranked[0].extensions.rank]
  f.write(defaultFile, list)
  await assert.rejects(() => validate(), /Public ranks do not match/)
})

test('ranking validator uses current-base membership even when the proposal checkout still has older lists', async (t) => {
  const f = fixture(t)
  await f.run()
  const previousList = f.read(defaultFile)
  const currentList = {
    ...previousList,
    tokens: previousList.tokens.filter((token) => token.address !== members[5].address),
  }
  f.write(defaultFile, currentList)
  const currentBase = validationBase(f)
  f.write(defaultFile, previousList)
  f.write('TokenRanking.1000000001.json', changedCandidate(f))
  await assert.rejects(
    () => f.run(['--validate'], { RANKING_BASE_REF: currentBase }),
    /Eligible membership changed on the current base/,
  )
})

test('mint lookup retains existing zero-score tokens without bypassing safety or pricing rules', async (t) => {
  const f = fixture(t)
  const candidates = members
    .filter(
      (token) =>
        !overrides.some((override) => override.address === token.address) && token.address !== unmeasured.address,
    )
    .slice(0, 3)
  const [existing, suspicious, unpriced] = candidates
  const omitted = new Set(candidates.map((token) => token.address))
  f.providers.jupiter = f.providers.jupiter.filter((token) => !omitted.has(token.id))
  f.providers.jupiterLookup = candidates.map((token) => ({ ...jupiter(token), tags: ['verified'], organicScore: 0 }))
  f.providers.jupiterLookup[1].audit = { isSus: true }
  f.providers.coingecko.tokens = f.providers.coingecko.tokens.filter((token) => token.address !== unpriced.address)
  await f.run()
  const addresses = new Set(f.read(defaultFile).tokens.map((token) => token.address))
  assert.ok(addresses.has(existing.address), 'an existing zero-score token must survive mint lookup')
  assert.ok(!addresses.has(suspicious.address))
  assert.ok(!addresses.has(unpriced.address))
})

test('existing members survive score drops but suspicious members are removed despite high volume or overrides', async (t) => {
  const f = fixture(t)
  const retained = f.providers.jupiter.find((token) => token.id === unmeasured.address)
  retained.tags = ['verified']
  retained.organicScore = 0
  const retainedRwa = f.providers.jupiter.find((token) => token.id === rwa.address)
  retainedRwa.tags = ['verified', 'rwa']
  retainedRwa.organicScore = 0
  const suspicious = f.providers.jupiter.find((token) => token.id === wrappedSol)
  suspicious.organicScore = 100
  suspicious.audit = { isSus: true }
  await f.run()
  const addresses = new Set(f.read(defaultFile).tokens.map((token) => token.address))
  assert.ok(addresses.has(unmeasured.address))
  assert.ok(!addresses.has(wrappedSol), 'neither volume nor overrides can restore a flagged token')
  assert.ok(f.read(rwaFile).tokens.some((token) => token.address === rwa.address))
  assert.deepEqual(f.read(defaultFile).version, { major: 3, minor: 0, patch: 0 })

  f.providers.jupiter = f.providers.jupiter.filter((token) => token.id !== wrappedSol)
  f.providers.jupiterLookup = [suspicious]
  await f.run()
  assert.ok(
    !f.read(defaultFile).tokens.some((token) => token.address === wrappedSol),
    'an override must not restore a flagged mint after it leaves the list and verified response',
  )

  const before = f.preserved()
  f.providers.jupiterLookup = []
  f.requests.length = 0
  await assert.rejects(() => f.run(), /Jupiter did not return required mints/)
  assert.deepEqual(f.preserved(), before)
  const requests = f.requests
  assert.ok(requests.every((request) => !request.url.includes('api.dune.com')))
})

test('an unresolved existing mint fails before Dune or file writes', async (t) => {
  const f = fixture(t)
  const before = f.preserved()
  f.providers.jupiter = f.providers.jupiter.filter((token) => token.id !== unmeasured.address)
  await assert.rejects(() => f.run(), /Jupiter did not return required mints/)
  assert.deepEqual(f.preserved(), before)
  const requests = f.requests
  assert.ok(requests.every((request) => !request.url.includes('api.dune.com')))
})

test('empty or truncated CoinGecko feeds preserve each existing list', async (t) => {
  const f = fixture(t)
  const before = f.preserved()
  for (const tokens of [[], [members[0]], members]) {
    f.providers.coingecko.tokens = tokens
    await assert.rejects(() => f.run(), /CoinGecko/)
    assert.deepEqual(f.preserved(), before)
  }
})

test('missing Jupiter metadata preserves existing lists', async (t) => {
  const f = fixture(t)
  const before = f.preserved()
  f.providers.jupiter.forEach((token) => {
    delete token.tokenProgram
  })
  await assert.rejects(() => f.run(), /Jupiter returned invalid metadata for existing token/)
  assert.deepEqual(f.preserved(), before)
})

test('historical CSV ranks current members inside the existing JSON, with rank-only patch bumps and repeatable ranks', async (t) => {
  assert.match(historicalCsv, /^rank,symbol,name,mint,/)
  assert.equal(rows.length, 100)
  assert.equal(eligibleRows.length, 98)
  const f = fixture(t)
  await f.run()
  const list = f.read(defaultFile)
  const ranks = Object.fromEntries(
    list.tokens.filter((t) => t.extensions?.rank).map((t) => [t.address, t.extensions.rank]),
  )
  assert.ok(validateList(list), JSON.stringify(validateList.errors))
  assert.ok(validateList(f.read(rwaFile)), JSON.stringify(validateList.errors))
  assert.deepEqual(ranks, expectedRanks)
  assert.deepEqual(list.version, { major: 2, minor: 3, patch: 5 })
  for (const t of list.tokens) {
    if (t.extensions?.rank != null) assert.ok(Number.isSafeInteger(t.extensions.rank) && t.extensions.rank > 0)
    assert.equal(t.extensions?.isToken2022, members.find((m) => m.address === t.address).extensions?.isToken2022)
  }
  assert.deepEqual(JSON.parse(readFileSync(join(f.root, 'build/lists', defaultFile))), list)
  await f.run()
  assert.deepEqual(f.read(defaultFile).tokens, list.tokens)
  assert.deepEqual(f.read(defaultFile).version, list.version)
  assert.equal(f.read('TokenRanking.1000000001.json').timestamp, f.snapshot.timestamp)
  assert.deepEqual(
    readdirSync(join(f.root, 'src/public')).sort(),
    [
      defaultFile,
      rwaFile,
      'SolanaOverrides.json',
      'TokenWarnings.1000000001.json',
      'TokenRanking.1000000001.json',
    ].sort(),
  )
})

test('membership additions and removals keep minor and major version rules', async (t) => {
  const f = fixture(t)
  f.providers.jupiter.push(jupiter(outsiders[4]))
  f.providers.coingecko.tokens.push(outsiders[4])
  await f.run()
  assert.deepEqual(f.read(defaultFile).version, { major: 2, minor: 4, patch: 0 })
  f.providers.jupiter.find((t) => t.id === unmeasured.address).audit = { isSus: true }
  await f.run()
  assert.deepEqual(f.read(defaultFile).version, { major: 3, minor: 0, patch: 0 })
  f.providers.jupiter.find((token) => token.id === unmeasured.address).audit = { isSus: false }
  await f.run()
  assert.ok(f.read(defaultFile).tokens.some((token) => token.address === unmeasured.address))
})

test('unsupported arguments fail before fetching or writing', async (t) => {
  const f = fixture(t)
  const before = f.preserved()
  await assert.rejects(() => f.run(['--dry-run']), /Use yarn solana/)
  assert.deepEqual(f.preserved(), before)
  assert.equal(f.requests.length, 0)
})

test('membership overlap preserves both lists, while safety checks can remove any number of tokens', async (t) => {
  const f = fixture(t)
  const before = f.preserved()
  f.write('SolanaOverrides.json', [...overrides, rwa])
  await assert.rejects(() => f.run())
  f.write('SolanaOverrides.json', overrides)
  assert.deepEqual(f.preserved(), before)
  f.providers.jupiter.forEach((token) => {
    token.audit = { isSus: true }
    delete token.tokenProgram
  })
  await f.run()
  assert.deepEqual(
    f.read(defaultFile).tokens.map((token) => token.address),
    [nativeSol],
  )
  assert.deepEqual(f.read(rwaFile).tokens, [])
})

test('explicit ranking mode starts one paid query and changes only review inputs; resume uses no POST', async (t) => {
  const f = fixture(t)
  const querySql = 'select mint, symbol, volume_90d, volume_30d from test_volumes'
  const sqlHash = DUNE_QUERY.sqlSha256
  DUNE_QUERY.sqlSha256 = hash(querySql)
  t.after(() => {
    DUNE_QUERY.sqlSha256 = sqlHash
  })
  const dailyFetch = globalThis.fetch
  let duneFailure = false
  let duneRows = rows.map((row) => ({ mint: row.mint, volume_90d: row.volume_90d_usd, volume_30d: row.volume_30d_usd }))
  t.mock.method(globalThis, 'fetch', async (input, options = {}) => {
    const url = new URL(input)
    if (url.host !== 'api.dune.com') return dailyFetch(input, options)
    f.requests.push({ url: String(url), method: options.method ?? 'GET' })
    if (duneFailure) return new Response('', { status: 401 })
    if (url.pathname === '/api/v1/query/' + DUNE_QUERY.id)
      return Response.json({ query_id: DUNE_QUERY.id, version: DUNE_QUERY.version, query_sql: querySql })
    if (options.method === 'POST') return Response.json({ execution_id: executionId })
    const metadata = { column_names: ['mint', 'volume_90d', 'volume_30d'], total_row_count: duneRows.length }
    const day = f.snapshot.windowEnd.slice(0, 10)
    const status = {
      query_id: DUNE_QUERY.id,
      execution_id: executionId,
      state: 'QUERY_STATE_COMPLETED',
      is_execution_finished: true,
      execution_started_at: day + 'T12:00:00Z',
      execution_ended_at: day + 'T12:01:00Z',
      result_metadata: metadata,
    }
    if (url.pathname.endsWith('/status')) return Response.json(status)
    const mints = [...url.searchParams.get('filters').matchAll(/'([^']+)'/g)].map((match) => match[1])
    return Response.json({ ...status, result: { metadata, rows: duneRows.filter((row) => mints.includes(row.mint)) } })
  })
  const before = f.preserved()
  await f.refresh([], { DUNE_API_KEY: 'test-key-never-log' })
  assert.deepEqual(f.preserved(), before)
  const candidate = JSON.parse(readFileSync(join(f.root, 'src/public/TokenRanking.1000000001.json')))
  assert.deepEqual(candidate.ranks, expectedRanks)
  const requests = f.requests
  assert.equal(requests.filter((r) => r.method === 'POST').length, 1)
  assert.ok(requests.some((r) => r.url.includes('/execution/' + executionId + '/results')))
  assert.ok(!f.output.join('\n').includes('test-key-never-log'))
  const receipt = JSON.parse(readFileSync(join(f.root, 'execution-receipt.json')))
  assert.equal(receipt.executionId, executionId)
  assert.deepEqual(receipt.parameters, { days: 90, min_volume_usd: 100000 })
  f.requests.length = 0
  await f.refresh(['--execution-id', executionId])
  assert.ok(f.requests.every((request) => request.method === 'GET'))
  const approved = readFileSync(join(f.root, 'src/public/TokenRanking.1000000001.json'), 'utf8')
  for (const failure of ['http', 'empty']) {
    duneFailure = failure === 'http'
    if (failure === 'empty') duneRows = []
    await assert.rejects(() => f.refresh([], { DUNE_API_KEY: 'test-key-never-log' }))
    assert.deepEqual(f.preserved(), before)
    assert.equal(readFileSync(join(f.root, 'src/public/TokenRanking.1000000001.json'), 'utf8'), approved)
  }
  // A ranking outage does not affect the independent daily path.
  await f.run([], { DUNE_API_KEY: '' })
})

for (const expired of [false, true])
  test(`daily lists and warnings update with ${expired ? 'expired' : 'fresh'} approved ranks`, async (t) => {
    const f = fixture(t)
    if (expired) {
      f.snapshot.timestamp = new Date(Date.now() - 16 * 86400000).toISOString()
      f.snapshot.windowEnd = f.snapshot.timestamp.slice(0, 10) + 'T00:00:00.000Z'
      f.write('TokenRanking.1000000001.json', f.snapshot)
    }
    const retained = members.find((m) => expectedRanks[m.address] && m.address !== wrappedSol)
    f.providers.jupiter.find((m) => m.id === retained.address).name = 'Fresh provider name'
    f.providers.jupiter.push(jupiter(outsiders[4]))
    f.providers.coingecko.tokens.push(outsiders[4])
    f.providers.jupiter.find((m) => m.id === wrappedSol).audit = { isSus: true }
    f.providers.shield = {
      warnings: { [retained.address]: [{ type: 'HAS_MINT_AUTHORITY', severity: 'warning', message: 'Fresh warning' }] },
    }
    await f.run([], { DUNE_API_KEY: '' })
    const tokens = f.read(defaultFile).tokens
    const updated = tokens.find((m) => m.address === retained.address)
    assert.equal(updated.name, 'Fresh provider name')
    assert.equal(updated.extensions?.rank, expired ? undefined : expectedRanks[retained.address])
    assert.equal(tokens.find((m) => m.address === outsiders[4].address).extensions?.rank, undefined)
    assert.ok(!tokens.some((m) => m.address === wrappedSol || m.address === rwa.address))
    assert.deepEqual(f.read('TokenWarnings.1000000001.json').warnings[retained.address], ['MINT'])
    assert.deepEqual(f.read('TokenRanking.1000000001.json'), f.snapshot)
  })

test('resolved warnings clear on the next daily run, including when all warnings disappear', async (t) => {
  const f = fixture(t)
  const flagged = members.filter((token) => token.address !== nativeSol).slice(0, 4)
  f.providers.shield = {
    warnings: Object.fromEntries(
      flagged.map((token) => [
        token.address,
        [{ type: 'HAS_MINT_AUTHORITY', severity: 'warning', message: 'Mint authority' }],
      ]),
    ),
  }
  await f.run()
  delete f.providers.shield.warnings[flagged[0].address]
  await f.run()
  const warnings = f.read('TokenWarnings.1000000001.json')
  assert.equal(warnings.warnings[flagged[0].address], undefined)
  assert.equal(Object.keys(warnings.warnings).length, 3)
  f.providers.shield.warnings = {}
  await f.run()
  assert.deepEqual(f.read('TokenWarnings.1000000001.json').warnings, {})
})

test('warning validation rejects invalid definitions for referenced codes', async (t) => {
  const f = fixture(t)
  f.providers.shield = {
    warnings: {
      [unmeasured.address]: [{ type: 'HAS_MINT_AUTHORITY', severity: 'warning', message: 'Mint authority' }],
    },
  }
  await f.run()
  await f.run(['--validate'])
  const warnings = f.read('TokenWarnings.1000000001.json')
  for (const type of [
    null,
    {},
    { severity: 'unknown', message: 'Warning' },
    { severity: 'warning', message: 42 },
    { severity: 'warning', message: ' ' },
  ]) {
    warnings.types.MINT = type
    f.write('TokenWarnings.1000000001.json', warnings)
    await assert.rejects(() => f.run(['--validate']), /Invalid Solana warning definition/)
  }
})

test('Shield, staging and replacement failures preserve the complete prior bundle', async (t) => {
  const f = fixture(t)
  await f.run()
  const files = [defaultFile, rwaFile, 'TokenWarnings.1000000001.json']
  const directories = ['src/public', 'build/lists']
  const contents = () =>
    directories.flatMap((directory) => files.map((name) => hash(readFileSync(join(f.root, directory, name)))))
  const before = contents()
  f.providers.jupiter.find((token) => token.id === unmeasured.address).name = 'Updated default token'
  f.providers.jupiter.find((token) => token.id === rwa.address).name = 'Updated RWA token'
  f.providers.shield = {
    warnings: {
      [unmeasured.address]: [{ type: 'HAS_MINT_AUTHORITY', severity: 'warning', message: 'Mint authority' }],
    },
  }
  f.providers.shieldFailure = true
  await assert.rejects(() => f.run())
  assert.deepEqual(contents(), before)
  f.providers.shieldFailure = false
  for (const method of ['writeFileSync', 'renameSync'])
    for (const directory of directories)
      for (const name of files) {
        const original = fs[method]
        const mocked = t.mock.method(fs, method, (file, ...args) => {
          const destination = String(method === 'renameSync' ? args[0] : file)
          if (destination.startsWith(directory + '/') && destination.includes(name))
            throw new Error('Simulated file failure')
          return original(file, ...args)
        })
        await assert.rejects(() => f.run(), /Simulated file failure/)
        mocked.mock.restore()
        assert.deepEqual(contents(), before)
        for (const directory of directories)
          assert.ok(readdirSync(join(f.root, directory)).every((name) => !name.endsWith('.tmp')))
      }
})

test('a failed restoration reports both errors and still restores the other files', async (t) => {
  const f = fixture(t)
  await f.run()
  const write = fs.writeFileSync
  const rename = fs.renameSync
  const before = ['src/public', 'build/lists'].flatMap((directory) =>
    [defaultFile, rwaFile, 'TokenWarnings.1000000001.json'].map((name) => {
      const file = join(directory, name)
      return [file, hash(readFileSync(file))]
    }),
  )
  f.providers.jupiter.forEach((token) => {
    token.name = 'Updated token name'
  })
  const writeError = new Error('Simulated replacement failure')
  const restoreError = new Error('Simulated restoration failure')
  // Fail the last replacement after the default and RWA destinations were replaced.
  t.mock.method(fs, 'renameSync', (source, destination) => {
    if (destination === 'src/public/TokenWarnings.1000000001.json') throw writeError
    return rename(source, destination)
  })
  t.mock.method(fs, 'writeFileSync', (file, ...args) => {
    if (file === 'src/public/Rwa.1000000001.json') throw restoreError
    return write(file, ...args)
  })
  await assert.rejects(
    () => f.run(),
    (error) => {
      assert.deepEqual(error.errors, [writeError, restoreError])
      return true
    },
  )
  for (const [file, previous] of before) {
    if (file === 'src/public/Rwa.1000000001.json') assert.notEqual(hash(readFileSync(file)), previous)
    else assert.equal(hash(readFileSync(file)), previous, file)
  }
})
