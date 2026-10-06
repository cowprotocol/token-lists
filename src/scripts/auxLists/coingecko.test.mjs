import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs'
import { register } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

register('ts-node/esm', import.meta.url)
process.env.COINGECKO_API_KEY = 'test'
const { fetchAndProcessCoingeckoTokens } = await import('./coingecko.ts')
const { COINGECKO_CHAINS } = await import('./utils.ts')

const native = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
const weth = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'
const wbnb = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c'

test('generates native supplies separately from wrapped tokens and volume rankings', async (t) => {
  const cwd = process.cwd()
  const dir = mkdtempSync(join(tmpdir(), 'native-supply-'))
  mkdirSync(join(dir, 'src/public'), { recursive: true })
  process.chdir(dir)
  t.after(() => process.chdir(cwd))
  t.mock.method(console, 'log', () => {})
  t.mock.method(console, 'warn', () => {})
  t.mock.method(console, 'error', () => {})

  const idsMap = {}
  const overrides = {}
  const lists = {}
  for (const [chainId, platform] of Object.entries(COINGECKO_CHAINS)) {
    if (!platform) continue
    overrides[chainId] = {}
    idsMap[platform] = {}
    lists[platform] = Array.from({ length: chainId === '1' ? 501 : chainId === '100' ? 0 : 1 }, (_, i) => {
      const address = i === 0 ? (chainId === '56' ? wbnb : weth) : `0x${i.toString(16).padStart(40, '0')}`
      const id = `${platform}-${i}`
      idsMap[platform][address] = id
      idsMap[platform][id] = address
      return { chainId: Number(chainId), address, name: id, symbol: id, decimals: 18 }
    })
  }

  let nativeMarkets
  let nativeRequests
  t.mock.method(globalThis, 'fetch', async (url) => {
    const parsed = new URL(url)
    let data
    if (parsed.hostname === 'tokens.coingecko.com') {
      data = { tokens: lists[parsed.pathname.split('/')[1]] }
    } else if (parsed.searchParams.get('ids').split(',').includes('ethereum')) {
      nativeRequests.push(parsed.searchParams.get('ids').split(','))
      if (nativeMarkets instanceof Error) throw nativeMarkets
      data = nativeMarkets
    } else {
      data = parsed.searchParams
        .get('ids')
        .split(',')
        .filter(Boolean)
        .map((id) => ({
          id,
          circulating_supply: 2,
          total_supply: 3,
          total_volume: 100,
        }))
    }
    return { ok: true, status: 200, json: async () => data }
  })

  const supply = (chain) => JSON.parse(readFileSync(`src/public/TokenSupply.${chain}.json`)).tokens
  for (const scenario of ['success', 'missing', 'failure']) {
    nativeRequests = []
    nativeMarkets =
      scenario === 'failure'
        ? new Error('test')
        : scenario === 'missing'
        ? []
        : [
            {
              id: 'ethereum',
              circulating_supply: 120_000_000,
              total_supply: 121_000_000,
              total_volume: 0,
            },
            {
              id: 'binancecoin',
              circulating_supply: 150_000_000,
              total_supply: null,
              total_volume: 0,
            },
            { id: 'xdai', circulating_supply: 10, total_supply: 20, total_volume: 0 },
          ]
    await fetchAndProcessCoingeckoTokens(idsMap, overrides)
    assert.equal(nativeRequests.length, 1)
    assert.equal(nativeRequests[0].filter((id) => id === 'ethereum').length, 1)
    assert.ok(nativeRequests[0].includes('binancecoin'))
    assert.deepEqual(supply(1)[weth], { circulatingSupply: 2, totalSupply: 3 })
    assert.deepEqual(supply(56)[wbnb], { circulatingSupply: 2, totalSupply: 3 })
    assert.equal(Object.keys(supply(1)).length, 501)
    for (const chain of [8453, 42161, 59144, 57073]) assert.deepEqual(supply(chain)[native], supply(1)[native])
    assert.equal(supply(1)[native].circulatingSupply, scenario === 'success' ? 120_000_000 : null)
    assert.equal(supply(56)[native].circulatingSupply, scenario === 'success' ? 150_000_000 : null)
    assert.equal(supply(56)[native].totalSupply, null)
    if (scenario === 'success') assert.deepEqual(supply(100)[native], { circulatingSupply: 10, totalSupply: 20 })
    if (scenario === 'failure' || scenario === 'missing') {
      assert.deepEqual(supply(1)[native], { circulatingSupply: null, totalSupply: null })
    }
  }
})
