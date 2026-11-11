import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { register } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

register('ts-node/esm', import.meta.url)
process.env.COINGECKO_API_KEY = 'test'
const { fetchAndProcessRwaTokens } = await import('./rwa.ts')

const xstock = '0x707C6BC22B6CF83B930B0A68C3BB20A94836DE71'
const rstock = '0x7a4db38b68a964efed8b8eda770fda84f3320195'
const gold = '0x68749665ff8d2d112fa859aa293f07a622782f38'
const noDecimals = '0x1111111111111111111111111111111111111111'
const solMint = 'XsTEo8W2L8JprN57bmJgatDT84z57ReJYizr5f32BfP'

const RWAS = {
  '3m': {
    id: '3m',
    asset_type: 'stock',
    tokens: [
      {
        id: '3m-xstock',
        symbol: 'mmmx',
        name: '3M xStock',
        platforms: { ethereum: xstock, solana: solMint, 'the-open-network': 'EQA_ha51Ucf', ink: '' },
        issuer_details: { id: 'xstocks-ecosystem', name: 'xStocks' },
      },
      {
        id: '3m-rstock',
        symbol: 'rmmm',
        name: '3M Tokenized Stock (Reality)',
        platforms: { 'arbitrum-one': rstock },
        issuer_details: null,
      },
    ],
  },
  gold: {
    id: 'gold',
    asset_type: 'commodity',
    tokens: [
      {
        id: 'tether-gold',
        symbol: 'xaut',
        name: 'Tether Gold',
        platforms: { ethereum: gold },
        issuer_details: { id: 'tether-ecosystem', name: 'Tether' },
      },
      { id: 'broken', symbol: 'brk', name: 'Broken', platforms: { ethereum: noDecimals } },
      // Same contract listed under another RWA must not be duplicated
      { id: '3m-xstock', symbol: 'mmmx', name: '3M xStock', platforms: { ethereum: xstock } },
    ],
  },
}

const usdy = '0x96f6ef951840721adbf46ac996b59e0235cb985c'

/** CoinGecko categories: USDY is only in a category, 3M xStock also in the RWA API, LINK is not an asset token */
const CATEGORIES = {
  'tokenized-treasuries': [
    { id: 'ondo-us-dollar-yield', market_cap: 1_500, image: 'https://img/usdy.png' },
  ],
  'xstocks-ecosystem': [{ id: '3m-xstock', market_cap: 1_000 }],
}
const COINS_LIST = [
  { id: 'ondo-us-dollar-yield', symbol: 'usdy', name: 'Ondo US Dollar Yield', platforms: { ethereum: usdy } },
  { id: '3m-xstock', symbol: 'mmmx', name: '3M xStock', platforms: { ethereum: xstock } },
  { id: 'chainlink', symbol: 'link', name: 'Chainlink', platforms: { ethereum: '0x514910771af9ca656af840dff83e8264ecf986ca' } },
]

const TOKEN_LISTS = {
  ethereum: [
    { chainId: 1, address: usdy, name: 'Ondo US Dollar Yield', symbol: 'USDY', decimals: 18 },
    {
      chainId: 1,
      address: xstock.toLowerCase(),
      name: '3M xStock',
      symbol: 'MMMx',
      decimals: 18,
      logoURI: 'https://assets.coingecko.com/coins/images/1/thumb/MMMx.png',
    },
  ],
  solana: [{ chainId: null, address: solMint, name: '3M xStock', symbol: 'MMMx', decimals: 8 }],
  'arbitrum-one': [{ chainId: 42161, address: rstock, name: '3M Reality', symbol: 'rMMM', decimals: 18 }],
}

test('generates per-chain RWA token lists from CoinGecko', async (t) => {
  const cwd = process.cwd()
  const dir = mkdtempSync(join(tmpdir(), 'rwa-'))
  mkdirSync(join(dir, 'src/public'), { recursive: true })
  process.chdir(dir)
  t.after(() => process.chdir(cwd))
  t.mock.method(console, 'log', () => {})
  t.mock.method(console, 'warn', () => {})

  const requests = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const { hostname, pathname, searchParams } = new URL(url)
    requests.push({ pathname, headers: init?.headers ?? {} })
    let data

    if (hostname === 'tokens.coingecko.com') {
      const list = TOKEN_LISTS[pathname.split('/')[1]]
      if (!list) return { ok: false, status: 404 }
      data = { tokens: list }
    } else if (pathname === '/api/v3/rwas/list') {
      data = Object.values(RWAS).map(({ id, asset_type }) => ({ id, asset_type }))
    } else if (pathname.startsWith('/api/v3/rwas/')) {
      assert.equal(searchParams.get('tokens'), 'true')
      data = RWAS[pathname.split('/').pop()]
    } else if (pathname === '/api/v3/coins/list') {
      assert.equal(searchParams.get('include_platform'), 'true')
      data = COINS_LIST
    } else if (pathname === '/api/v3/coins/markets' && searchParams.has('category')) {
      data = searchParams.get('page') === '1' ? CATEGORIES[searchParams.get('category')] ?? [] : []
    } else if (pathname === '/api/v3/coins/markets') {
      assert.ok(!searchParams.get('ids').split(',').includes('3m-xstock'), 'market data of category coins is reused')
      const caps = { 'tether-gold': 2_000, '3m-xstock': 1_000, '3m-rstock': 10 }
      data = searchParams
        .get('ids')
        .split(',')
        .filter((id) => caps[id])
        .map((id) => ({ id, market_cap: caps[id], image: id === 'tether-gold' ? 'missing_large.png' : undefined }))
    } else if (pathname === '/api/v3/coins/tether-gold') {
      data = {
        image: { large: 'https://assets.coingecko.com/coins/images/2/large/xaut.png' },
        detail_platforms: { ethereum: { decimal_place: 6 } },
      }
    } else if (pathname === '/api/v3/coins/broken') {
      data = { detail_platforms: { ethereum: { decimal_place: null } } }
    } else {
      throw new Error(`Unexpected request ${url}`)
    }

    return { ok: true, status: 200, json: async () => data }
  })

  await fetchAndProcessRwaTokens()

  const read = (chainId) => JSON.parse(readFileSync(`src/public/CoinGeckoRwa.${chainId}.json`, 'utf8'))

  const mainnet = read(1)
  assert.equal(mainnet.name, 'RWA on Ethereum')
  assert.deepEqual(mainnet.keywords, ['rwa', 'coingecko'])
  assert.deepEqual(mainnet.version, { major: 0, minor: 1, patch: 0 })
  assert.deepEqual(mainnet.tokens, [
    {
      chainId: 1,
      address: gold,
      name: 'Tether Gold',
      symbol: 'XAUT',
      decimals: 6,
      logoURI: 'https://assets.coingecko.com/coins/images/2/large/xaut.png',
      extensions: { assetType: 'commodity', issuer: 'Tether' },
    },
    {
      chainId: 1,
      address: usdy,
      name: 'Ondo US Dollar Yield',
      symbol: 'USDY',
      decimals: 18,
      logoURI: 'https://img/usdy.png',
      extensions: { assetType: 'bond' },
    },
    {
      chainId: 1,
      address: xstock.toLowerCase(),
      name: '3M xStock',
      symbol: 'MMMx',
      decimals: 18,
      logoURI: 'https://assets.coingecko.com/coins/images/1/large/MMMx.png',
      extensions: { assetType: 'stock', issuer: 'xStocks' },
    },
  ])

  const solana = read(1000000001)
  assert.equal(solana.tokens.length, 1)
  assert.equal(solana.tokens[0].address, solMint)
  assert.equal(solana.tokens[0].decimals, 8)

  assert.deepEqual(read(42161).tokens[0].extensions, { assetType: 'stock' })
  assert.equal(existsSync('src/public/CoinGeckoRwa.100.json'), false)

  const api = requests.filter(({ pathname }) => pathname.startsWith('/api/v3/'))
  assert.ok(api.every(({ headers }) => headers['x-cg-pro-api-key'] === 'test'))
  assert.equal(requests.filter(({ pathname }) => pathname === '/api/v3/coins/tether-gold').length, 1)
})

test('does not write lists when an RWA cannot be fetched', async (t) => {
  const cwd = process.cwd()
  const dir = mkdtempSync(join(tmpdir(), 'rwa-'))
  mkdirSync(join(dir, 'src/public'), { recursive: true })
  process.chdir(dir)
  t.after(() => process.chdir(cwd))
  t.mock.method(console, 'log', () => {})

  t.mock.method(globalThis, 'fetch', async (url) => {
    const { pathname } = new URL(url)
    if (pathname === '/api/v3/rwas/list') {
      return { ok: true, status: 200, json: async () => [{ id: '3m', asset_type: 'stock' }] }
    }
    return { ok: false, status: 404 }
  })

  await assert.rejects(fetchAndProcessRwaTokens(), /404/)
  assert.equal(existsSync('src/public/CoinGeckoRwa.1.json'), false)
})

test('bumps the list version when only token extensions change', async (t) => {
  const { processTokenList } = await import('./processTokenList.ts')
  const cwd = process.cwd()
  const dir = mkdtempSync(join(tmpdir(), 'rwa-'))
  mkdirSync(join(dir, 'src/public'), { recursive: true })
  process.chdir(dir)
  t.after(() => process.chdir(cwd))
  t.mock.method(console, 'log', () => {})
  t.mock.method(console, 'warn', () => {})

  const logger = { info: () => {} }
  const token = { chainId: 1, address: xstock, name: '3M xStock', symbol: 'MMMx', decimals: 18 }
  const save = (extensions) =>
    processTokenList({ chainId: 1, tokens: [{ ...token, extensions }], prefix: 'Test', logo: '', logMessage: '', logger })
  const read = () => JSON.parse(readFileSync('src/public/Test.1.json', 'utf8'))

  await save({ assetType: 'other' })
  assert.deepEqual(read().version, { major: 0, minor: 1, patch: 0 })

  await save({ assetType: 'stock', issuer: 'xStocks' })
  assert.deepEqual(read().version, { major: 0, minor: 1, patch: 1 })
  assert.deepEqual(read().tokens[0].extensions, { assetType: 'stock', issuer: 'xStocks' })

  await save({ assetType: 'stock', issuer: 'xStocks' })
  assert.deepEqual(read().version, { major: 0, minor: 1, patch: 1 })
})
