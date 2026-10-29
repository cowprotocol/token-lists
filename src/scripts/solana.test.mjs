import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import csv from 'csv-parser'
import Ajv from 'ajv'
import addFormats from 'ajv-formats'

const repo = new URL('../../', import.meta.url)
// The upstream TokenList schema assumes hex addresses; retain its other constraints for Solana.
const schema = JSON.parse(readFileSync(new URL('node_modules/@uniswap/token-lists/dist/tokenlist.schema.json', repo)))
schema.definitions.TokenInfo.properties.address.pattern = '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
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

/** Copy the actual entry point into a disposable repo and intercept every HTTP request at the process boundary. */
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'fe989-solana-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'src/scripts/utils'), { recursive: true })
  mkdirSync(join(root, 'src/public'), { recursive: true })
  for (const name of ['solana', 'solanaRankings', 'tokenListUtils']) {
    copyFileSync(new URL('src/scripts/' + name + '.ts', repo), join(root, 'src/scripts', name + '.ts'))
  }
  copyFileSync(new URL('src/scripts/utils/fetchJson.ts', repo), join(root, 'src/scripts/utils/fetchJson.ts'))
  for (const name of ['package.json', 'tsconfig.json']) copyFileSync(new URL(name, repo), join(root, name))
  symlinkSync(fileURLToPath(new URL('node_modules', repo)), join(root, 'node_modules'), 'dir')
  const input = { ...defaultList, version: { major: 2, minor: 3, patch: 4 }, tokens: members }
  writeFileSync(join(root, 'src/public', defaultFile), JSON.stringify(input))
  writeFileSync(join(root, 'src/public', rwaFile), JSON.stringify({ ...rwaList, tokens: [rwa] }))
  writeFileSync(join(root, 'src/public/SolanaOverrides.json'), JSON.stringify(overrides))
  const upstream = members.filter((t) => t.address !== nativeSol).map(jupiter)
  upstream.find((t) => t.id === wrappedSol).name = 'Upstream override replaced'
  upstream.find((t) => t.id === unmeasured.address).tags = []
  upstream.find((t) => t.id === unmeasured.address).organicScore = 25
  const rejected = outsiders.map(jupiter)
  rejected[0].audit = { isSus: true }
  rejected[1].tags = []
  rejected[1].organicScore = 24
  rejected[2].name = ''
  rejected[3].tokenProgram = 'unknown'
  // The fifth outsider has no CoinGecko price.
  const sourceDay = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
  const providers = {
    startedAt: sourceDay + 'T12:00:00Z',
    endedAt: sourceDay + 'T12:01:00Z',
    jupiter: [...upstream, { ...jupiter(rwa), tags: ['strict', 'rwa'] }, ...rejected],
    coingecko: { tokens: [...members, rwa, ...outsiders.slice(0, 4)] },
    duneRows: rows.map((row) => ({ mint: row.mint, volume_90d: row.volume_90d_usd, volume_30d: row.volume_30d_usd })),
  }
  const preload = join(root, 'preload.mjs')
  writeFileSync(
    preload,
    `
import fs from 'node:fs'
const providers = JSON.parse(fs.readFileSync('providers.json'))
globalThis.fetch = async (input, options = {}) => {
  const url = new URL(input)
  fs.appendFileSync('requests.jsonl', JSON.stringify({ url: String(url), method: options.method ?? 'GET' }) + '\\n')
  if (url.host === 'lite-api.jup.ag') return Response.json(url.pathname.endsWith('/search') ? providers.jupiterLookup ?? [] : providers.jupiter)
  if (url.host === 'tokens.coingecko.com') return Response.json(providers.coingecko)
  if (url.host !== 'api.dune.com') throw new Error('Unexpected HTTP: ' + url)
  if (providers.duneFailure) return new Response('', { status: 401 })
  if (options.method === 'POST') return Response.json({ execution_id: '${executionId}' })
  const details = { column_names: providers.duneColumns ?? ['mint', 'volume_90d', 'volume_30d'], total_row_count: providers.duneRows.length }
  const status = { query_id: 8910905, execution_id: '${executionId}', state: 'QUERY_STATE_COMPLETED', is_execution_finished: true, execution_started_at: providers.startedAt, execution_ended_at: providers.endedAt, result_metadata: details }
  if (url.pathname.endsWith('/status')) return Response.json(status)
  return Response.json({ ...status, result: { metadata: details, rows: providers.duneRows } })
}
if (process.env.SOLANA_TEST_WRITE_FAILURE) {
  const write = fs.writeFileSync
  fs.writeFileSync = (file, ...args) => {
    if (String(file).includes('Rwa.1000000001.json') && String(file).endsWith('.tmp')) throw new Error('Simulated staging failure')
    return write(file, ...args)
  }
}
`,
  )
  const run = (args = [], env = {}) => {
    writeFileSync(join(root, 'providers.json'), JSON.stringify(providers))
    return spawnSync(
      process.execPath,
      [
        '--no-warnings',
        '--experimental-specifier-resolution=node',
        '--import',
        preload,
        '--loader',
        'ts-node/esm',
        'src/scripts/solana.ts',
        ...args,
      ],
      {
        cwd: root,
        encoding: 'utf8',
        timeout: 30_000,
        env: { ...process.env, DUNE_API_KEY: 'test-key-never-log', ALLOW_LIST_SHRINK: '', ...env },
      },
    )
  }
  /** Read outputs and input files from this fixture only. */
  const read = (file) => JSON.parse(readFileSync(join(root, 'src/public', file)))
  const preserved = () =>
    [defaultFile, rwaFile, 'SolanaOverrides.json'].map((file) => hash(readFileSync(join(root, 'src/public', file))))
  return { root, providers, input, run, read, preserved }
}

test('existing provider eligibility, overrides, native SOL and RWA separation survive generation', (t) => {
  const f = fixture(t)
  const result = f.run()
  assert.equal(result.status, 0, result.stderr)
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

test('mint lookup retains legacy strict tokens without bypassing safety or pricing rules', (t) => {
  const f = fixture(t)
  const candidates = members
    .filter(
      (token) =>
        !overrides.some((override) => override.address === token.address) && token.address !== unmeasured.address,
    )
    .slice(0, 3)
  const [legacy, suspicious, unpriced] = candidates
  const omitted = new Set(candidates.map((token) => token.address))
  f.providers.jupiter = f.providers.jupiter.filter((token) => !omitted.has(token.id))
  f.providers.jupiterLookup = candidates.map((token) => ({ ...jupiter(token), organicScore: 0 }))
  f.providers.jupiterLookup[1].audit = { isSus: true }
  f.providers.coingecko.tokens = f.providers.coingecko.tokens.filter((token) => token.address !== unpriced.address)
  const result = f.run()
  assert.equal(result.status, 0, result.stderr)
  const addresses = new Set(f.read(defaultFile).tokens.map((token) => token.address))
  assert.ok(addresses.has(legacy.address), 'a strict token omitted by the verified endpoint must survive mint lookup')
  assert.ok(!addresses.has(suspicious.address))
  assert.ok(!addresses.has(unpriced.address))
})

test('historical CSV ranks current members inside the existing JSON, with rank-only patch bumps and repeatable ranks', (t) => {
  assert.match(historicalCsv, /^rank,symbol,name,mint,/)
  assert.equal(rows.length, 100)
  assert.equal(eligibleRows.length, 98)
  const f = fixture(t)
  const first = f.run()
  assert.equal(first.status, 0, first.stderr)
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
  assert.equal(f.run().status, 0)
  assert.deepEqual(f.read(defaultFile).tokens, list.tokens)
  assert.deepEqual(f.read(defaultFile).version, list.version)
  assert.match(first.stdout, /rowsSha256/)
  assert.deepEqual(
    readdirSync(join(f.root, 'src/public')).sort(),
    [defaultFile, rwaFile, 'SolanaOverrides.json'].sort(),
  )
})

test('low coverage, zero, either metric and removal of old ranks succeed without a baseline or coverage guard', (t) => {
  const f = fixture(t)
  assert.equal(f.run().status, 0)
  for (const metric of ['volume_90d', 'volume_30d']) {
    f.providers.duneColumns = ['mint', metric]
    f.providers.duneRows = [{ mint: wrappedSol, [metric]: 0 }]
    const result = f.run()
    assert.equal(result.status, 0, result.stderr)
    const list = f.read(defaultFile)
    assert.equal(list.tokens.find((t) => t.address === wrappedSol).extensions.rank, 1)
    assert.equal(list.tokens.filter((t) => t.extensions?.rank).length, 1)
  }
  f.providers.duneRows = []
  const previous = f.read(defaultFile).version
  assert.equal(f.run().status, 0)
  assert.ok(f.read(defaultFile).tokens.every((t) => t.extensions?.rank === undefined))
  assert.deepEqual(f.read(defaultFile).version, { ...previous, patch: previous.patch + 1 })
})

test('membership additions and removals keep minor and major version rules', (t) => {
  const f = fixture(t)
  f.providers.jupiter.push(jupiter(outsiders[4]))
  f.providers.coingecko.tokens.push(outsiders[4])
  assert.equal(f.run().status, 0)
  assert.deepEqual(f.read(defaultFile).version, { major: 2, minor: 4, patch: 0 })
  f.providers.jupiter = f.providers.jupiter.filter((t) => t.id !== unmeasured.address)
  assert.equal(f.run().status, 0)
  assert.deepEqual(f.read(defaultFile).version, { major: 3, minor: 0, patch: 0 })
})

test('missing credentials and unsupported arguments fail before fetching or writing', (t) => {
  const f = fixture(t)
  const before = f.preserved()
  const missing = f.run([], { DUNE_API_KEY: '' })
  assert.notEqual(missing.status, 0)
  assert.match(missing.stderr, /DUNE_API_KEY/)
  const unsupported = f.run(['--dry-run'])
  assert.notEqual(unsupported.status, 0)
  assert.match(unsupported.stderr, /does not accept arguments/)
  assert.deepEqual(f.preserved(), before)
  assert.ok(!readdirSync(f.root).includes('requests.jsonl'))
})

test('source validation, membership overlap and shrink failures preserve both lists', (t) => {
  const f = fixture(t)
  const before = f.preserved()
  const validRows = structuredClone(f.providers.duneRows)
  f.providers.duneRows[0].volume_90d = 'invalid'
  const bad = f.run()
  assert.notEqual(bad.status, 0)
  assert.match(bad.stderr, /volume/)
  f.providers.duneRows = validRows
  writeFileSync(join(f.root, 'src/public/SolanaOverrides.json'), JSON.stringify([...overrides, rwa]))
  assert.notEqual(f.run().status, 0)
  writeFileSync(join(f.root, 'src/public/SolanaOverrides.json'), JSON.stringify(overrides))
  f.providers.jupiter = []
  const shrink = f.run()
  assert.notEqual(shrink.status, 0)
  assert.match(shrink.stderr, /token count dropped/)
  assert.deepEqual(f.preserved(), before)
})

test('staging failure cleans temporary files before any destination is replaced', (t) => {
  const f = fixture(t)
  const before = f.preserved()
  const result = f.run(undefined, { SOLANA_TEST_WRITE_FAILURE: '1' })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Simulated staging failure/)
  assert.deepEqual(f.preserved(), before)
  assert.ok(readdirSync(join(f.root, 'src/public')).every((name) => !name.endsWith('.tmp')))
  assert.ok(readdirSync(join(f.root, 'build/lists')).every((name) => !name.endsWith('.tmp')))
})

test('normal live mode executes one Dune query and pins its results; API failure never writes', (t) => {
  const f = fixture(t)
  f.providers.duneRows = [{ mint: wrappedSol, volume_90d: 10, volume_30d: 5 }]
  const result = f.run([], { DUNE_API_KEY: 'test-key-never-log' })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(f.read(defaultFile).tokens.filter((t) => t.extensions?.rank).length, 1)
  const requests = readFileSync(join(f.root, 'requests.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
  assert.equal(requests.filter((r) => r.method === 'POST').length, 1)
  assert.ok(requests.some((r) => r.url.includes('/execution/' + executionId + '/results')))
  assert.ok(!result.stdout.includes('test-key-never-log'))
  const before = f.preserved()
  f.providers.duneFailure = true
  const failed = f.run([], { DUNE_API_KEY: 'test-key-never-log' })
  assert.notEqual(failed.status, 0)
  assert.deepEqual(f.preserved(), before)
})
