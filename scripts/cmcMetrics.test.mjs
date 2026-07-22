import { describe, it, mock, afterEach } from 'node:test'
import assert from 'node:assert/strict'

import { enrichWithCmcMetrics, usd, count } from './cmcMetrics.mjs'

// Build a minimal CMC DEX page mirroring the __NEXT_DATA__ shape fetchCmcData parses.
const makeHtml = ({ holders, liqUsd, vol24h }) => {
  const data = {
    props: {
      pageProps: {
        holdersCount: holders,
        dehydratedState: {
          queries: [
            {
              queryKey: ['dex-token-info'],
              state: { data: { liqUsd, sts: [{ tp: '24h', vu: vol24h }] } },
            },
          ],
        },
      },
    },
  }
  return `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(
    data,
  )}</script></html>`
}

describe('usd', () => {
  it('formats and handles nullish', () => {
    assert.equal(usd(1234567), '$1,234,567')
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

describe('enrichWithCmcMetrics', () => {
  const originalFetch = global.fetch
  afterEach(() => {
    global.fetch = originalFetch
  })

  it('populates formatted metrics on success', async () => {
    global.fetch = mock.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => makeHtml({ holders: 12345, liqUsd: 1234567, vol24h: 98765 }),
    }))
    const values = { network: 'MAINNET', address: '0xabc' }
    await enrichWithCmcMetrics(values)
    assert.equal(values.cmcLiquidity, '$1,234,567')
    assert.equal(values.cmcVolume24h, '$98,765')
    assert.equal(values.cmcHolders, '12,345')
    assert.equal(values.cmcUrl, 'https://dex.coinmarketcap.com/token/ethereum/0xabc/')
  })

  it('defaults to n/a and does not throw when fetch rejects', async () => {
    global.fetch = mock.fn(async () => {
      throw new Error('network down')
    })
    const values = { network: 'MAINNET', address: '0xabc' }
    await assert.doesNotReject(enrichWithCmcMetrics(values))
    assert.equal(values.cmcLiquidity, 'n/a')
    assert.equal(values.cmcVolume24h, 'n/a')
    assert.equal(values.cmcHolders, 'n/a')
    // Token URL is still set so the reviewer has a link.
    assert.equal(values.cmcUrl, 'https://dex.coinmarketcap.com/token/ethereum/0xabc/')
  })

  it('defaults to n/a for unmapped chains without fetching', async () => {
    const fetchMock = mock.fn(async () => ({ ok: true, status: 200, text: async () => '' }))
    global.fetch = fetchMock
    const values = { network: 'PLASMA', address: '0xabc' }
    await enrichWithCmcMetrics(values)
    assert.equal(values.cmcLiquidity, 'n/a')
    assert.equal(values.cmcHolders, 'n/a')
    assert.equal(fetchMock.mock.callCount(), 0)
    assert.equal(values.cmcUrl, 'https://dex.coinmarketcap.com')
  })

  it('defaults to n/a on non-ok HTTP response', async () => {
    global.fetch = mock.fn(async () => ({ ok: false, status: 404, text: async () => '' }))
    const values = { network: 'BASE', address: '0xdef' }
    await enrichWithCmcMetrics(values)
    assert.equal(values.cmcHolders, 'n/a')
    assert.equal(values.cmcUrl, 'https://dex.coinmarketcap.com/token/base/0xdef/')
  })
})
