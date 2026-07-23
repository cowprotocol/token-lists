import { describe, it, mock, afterEach } from 'node:test'
import assert from 'node:assert/strict'

import { enrichWithTokenMetrics, usd, count } from './tokenMetrics.mjs'

// GeckoTerminal token response, mirroring data.attributes.{total_reserve_in_usd, volume_usd.h24}.
const geckoJson = ({ marketCap, volume24h }) => ({
  ok: true,
  status: 200,
  json: async () => ({
    data: { attributes: { market_cap_usd: marketCap, volume_usd: { h24: volume24h } } },
  }),
  text: async () => '',
})

// CoinMarketCap DEX page carrying holdersCount in __NEXT_DATA__.
const cmcHtml = ({ holders }) => {
  const data = { props: { pageProps: { holdersCount: holders } } }
  return {
    ok: true,
    status: 200,
    text: async () =>
      `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(
        data,
      )}</script></html>`,
    json: async () => ({}),
  }
}

// Route a mocked fetch by host: GeckoTerminal API vs CoinMarketCap DEX page.
const routedFetch = ({ gecko, cmc }) =>
  mock.fn(async (url) => {
    if (String(url).includes('api.geckoterminal.com')) return gecko()
    if (String(url).includes('dex.coinmarketcap.com')) return cmc()
    throw new Error(`unexpected url ${url}`)
  })

describe('usd', () => {
  it('formats and handles nullish / non-numeric', () => {
    assert.equal(usd(1234567), '$1,234,567')
    assert.equal(usd('552659262.52'), '$552,659,263')
    assert.equal(usd(null), 'n/a')
    assert.equal(usd(NaN), 'n/a')
  })
})

describe('count', () => {
  it('formats and handles nullish', () => {
    assert.equal(count(12345), '12,345')
    assert.equal(count(null), 'n/a')
  })
})

describe('enrichWithTokenMetrics', () => {
  const originalFetch = global.fetch
  afterEach(() => {
    global.fetch = originalFetch
    mock.restoreAll()
  })

  it('populates all three metrics from both sources on success', async () => {
    global.fetch = routedFetch({
      gecko: () => geckoJson({ marketCap: '1234567.89', volume24h: '98765.4' }),
      cmc: () => cmcHtml({ holders: 12345 }),
    })
    const values = { network: 'MAINNET', address: '0xabc' }
    const results = await enrichWithTokenMetrics(values)
    assert.equal(results.marketCap, '$1,234,568')
    assert.equal(results.tokenVolume24h, '$98,765')
    assert.equal(results.tokenHolders, '12,345')
    assert.equal(results.geckoTerminalUrl, 'https://www.geckoterminal.com/eth/tokens/0xabc')
    assert.equal(results.cmcUrl, 'https://dex.coinmarketcap.com/token/ethereum/0xabc/')
  })

  it('is independent: GeckoTerminal failure still yields holders', async () => {
    mock.method(console, 'warn', () => {})
    global.fetch = routedFetch({
      gecko: () => {
        throw new Error('gecko down')
      },
      cmc: () => cmcHtml({ holders: 999 }),
    })
    const values = { network: 'MAINNET', address: '0xabc' }
    const results = await enrichWithTokenMetrics(values)
    assert.equal(results.marketCap, 'n/a')
    assert.equal(results.tokenVolume24h, 'n/a')
    assert.equal(results.tokenHolders, '999')
  })

  it('is independent: CMC scrape failure still yields marketCap/volume', async () => {
    mock.method(console, 'warn', () => {})
    global.fetch = routedFetch({
      gecko: () => geckoJson({ marketCap: '5000', volume24h: '250' }),
      cmc: () => ({ ok: false, status: 404, text: async () => '', json: async () => ({}) }),
    })
    const values = { network: 'BASE', address: '0xdef' }
    const results = await enrichWithTokenMetrics(values)
    assert.equal(results.marketCap, '$5,000')
    assert.equal(results.tokenVolume24h, '$250')
    assert.equal(results.tokenHolders, 'n/a')
  })

  it('does not throw and defaults to n/a when both sources fail', async () => {
    mock.method(console, 'warn', () => {})
    global.fetch = routedFetch({
      gecko: () => {
        throw new Error('down')
      },
      cmc: () => {
        throw new Error('down')
      },
    })
    const values = { network: 'MAINNET', address: '0xabc' }
    const results = await enrichWithTokenMetrics(values)
    assert.equal(results.marketCap, 'n/a')
    assert.equal(results.tokenHolders, 'n/a')
  })

  it('skips fetching for unmapped chains', async () => {
    const fetchMock = routedFetch({ gecko: () => geckoJson({}), cmc: () => cmcHtml({}) })
    global.fetch = fetchMock
    const values = { network: 'PLASMA', address: '0xabc' }
    const results = await enrichWithTokenMetrics(values)
    assert.equal(results.marketCap, 'n/a')
    assert.equal(results.tokenHolders, 'n/a')
    assert.equal(fetchMock.mock.callCount(), 0)
    assert.equal(results.geckoTerminalUrl, 'https://www.geckoterminal.com')
    assert.equal(results.cmcUrl, 'https://dex.coinmarketcap.com')
  })
})
