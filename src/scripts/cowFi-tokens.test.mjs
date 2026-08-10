import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { filterCandidates, requestWithRetries, sortByMarketCapDesc, trimToUsd } from './cowFi-tokens.js'

describe('filterCandidates', () => {
  const cowFiAddressesByChain = {
    1: new Set(['0xmainnet']),
    100: new Set(['0xgnosis']),
  }

  it('keeps entries whose mainnet or gnosis address is in the cow.fi list', () => {
    const result = filterCandidates(
      [
        { id: 'token-a', platforms: { ethereum: '0xMAINNET' } },
        { id: 'token-b', platforms: { xdai: '0xGNOSIS' } },
        { id: 'token-c', platforms: { ethereum: '0xsomethingelse' } },
      ],
      cowFiAddressesByChain,
    )

    assert.deepEqual(result, [
      { id: 'token-a', address: '0xmainnet' },
      { id: 'token-b', address: '0xgnosis' },
    ])
  })

  it('drops denylisted tokens even if the address matches', () => {
    const result = filterCandidates(
      [{ id: 'agave-token', platforms: { ethereum: '0xmainnet' } }],
      cowFiAddressesByChain,
    )

    assert.deepEqual(result, [])
  })

  it('ignores entries with no matching platform', () => {
    const result = filterCandidates([{ id: 'token-d', platforms: { polygon: '0xmainnet' } }], cowFiAddressesByChain)

    assert.deepEqual(result, [])
  })
})

describe('sortByMarketCapDesc', () => {
  it('sorts candidates by market cap, highest first', () => {
    const candidates = [{ id: 'small' }, { id: 'big' }, { id: 'mid' }]
    const marketCapById = new Map([
      ['small', 1],
      ['big', 100],
      ['mid', 50],
    ])

    const result = sortByMarketCapDesc(candidates, marketCapById)

    assert.deepEqual(
      result.map((c) => c.id),
      ['big', 'mid', 'small'],
    )
  })

  it('treats unknown ids as zero market cap', () => {
    const candidates = [{ id: 'unknown' }, { id: 'known' }]
    const marketCapById = new Map([['known', 10]])

    const result = sortByMarketCapDesc(candidates, marketCapById)

    assert.deepEqual(
      result.map((c) => c.id),
      ['known', 'unknown'],
    )
  })
})

describe('trimToUsd', () => {
  it('keeps only the usd value for object fields', () => {
    const result = trimToUsd({
      current_price: { usd: 1.5, eur: 1.3 },
      market_cap: { usd: 1000, eur: 900 },
    })

    assert.deepEqual(result, {
      current_price: { usd: 1.5 },
      market_cap: { usd: 1000 },
    })
  })

  it('passes through non-object fields unchanged', () => {
    const result = trimToUsd({ ath_date: { usd: '2021-01-01' }, market_cap_rank: 5 })

    assert.deepEqual(result, { ath_date: { usd: '2021-01-01' }, market_cap_rank: 5 })
  })
})

describe('requestWithRetries', () => {
  it('retries a rate-limited response after its Retry-After delay', async () => {
    let calls = 0
    const delays = []

    const result = await requestWithRetries(
      async () => {
        calls++
        return calls === 1
          ? { ok: false, status: 429, headers: new Headers({ 'Retry-After': '2' }) }
          : { ok: true, json: async () => ({ id: 'token' }) }
      },
      async (delay) => delays.push(delay),
    )

    assert.deepEqual(result, { id: 'token' })
    assert.equal(calls, 2)
    assert.deepEqual(delays, [2000])
  })

  it('uses exponential backoff when Retry-After is missing', async () => {
    let calls = 0
    const delays = []

    await requestWithRetries(
      async () => {
        calls++
        return calls === 1
          ? { ok: false, status: 429, headers: new Headers() }
          : { ok: true, json: async () => ({ id: 'token' }) }
      },
      async (delay) => delays.push(delay),
    )

    assert.equal(calls, 2)
    assert.deepEqual(delays, [1000])
  })

  it('does not retry a permanent response', async () => {
    let calls = 0

    await assert.rejects(
      requestWithRetries(async () => {
        calls++
        return { ok: false, status: 400, headers: new Headers() }
      }),
      /400/,
    )

    assert.equal(calls, 1)
  })
})
