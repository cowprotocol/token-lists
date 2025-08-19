import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'

import {
  extractFieldValues,
  applyNetworkConfig,
  generateImageUrls,
  getOperation,
  validateFields,
  processRequest,
} from './processRequest.mjs'

const createContext = (body, labels = ['addToken']) => ({
  payload: { issue: { body, labels: labels.map((name) => ({ name })) } },
})

const createMockCore = () => ({ setOutput: mock.fn() })

const getIssueInfo = (core) => {
  const call = core.setOutput.mock.calls.find((call) => call.arguments[0] === 'issueInfo')
  return call ? JSON.parse(call.arguments[1]) : null
}

describe('extractFieldValues', () => {
  it('extracts field values', () => {
    const body = `
      ### Network
      MAINNET
      ### Symbol
      BTC
      ### Address
      0x123`
    const result = extractFieldValues(body, ['network', 'symbol', 'address'])

    assert.equal(result.network, 'MAINNET')
    assert.equal(result.symbol, 'BTC')
    assert.equal(result.address, '0x123')
  })

  it('handles missing fields', () => {
    const result = extractFieldValues('### network\nMAINNET', ['network', 'symbol'])
    assert.equal(result.network, 'MAINNET')
    assert.equal(result.symbol, undefined)
  })
})

describe('applyNetworkConfig', () => {
  it('applies network config', () => {
    const values = { network: 'POLYGON' }
    applyNetworkConfig(values)
    assert.equal(values.chainId, 137)
  })
})

describe('generateImageUrls', () => {
  it('generates URLs with chainId and address', () => {
    const values = { chainId: 1, address: '0xabc123' }
    generateImageUrls(values)
    assert.ok(values.prImageUrl)
    assert.ok(values.logoURI)
  })

  it('handles missing fields', () => {
    const testCases = [{ address: '0xabc123' }, { chainId: 1 }, {}]

    for (const values of testCases) {
      generateImageUrls(values)
      assert.equal(values.prImageUrl, undefined)
      assert.equal(values.logoURI, undefined)
    }
  })
})

describe('getOperation', () => {
  it('returns valid operation', () => {
    assert.equal(getOperation(['bug', 'addToken']), 'addToken')
  })

  it('throws for invalid labels', () => {
    const invalidCases = [['bug'], []]

    for (const labels of invalidCases) {
      assert.throws(() => getOperation(labels), /No valid operation/)
    }
  })
})

describe('validateFields', () => {
  const valid = {
    network: 'MAINNET',
    symbol: 'BTC',
    name: 'Bitcoin',
    url: 'https://bitcoin.org',
    decimals: '18',
    address: '0x123',
    reason: 'Popular',
  }

  it('validates addToken fields', () => {
    assert.doesNotThrow(() => validateFields('addToken', valid))
  })

  it('throws for invalid fields', () => {
    assert.throws(() => validateFields('addToken', { ...valid, symbol: 'BIT COIN' }), /Symbol cannot contain spaces/)
  })
})

describe('processRequest', () => {
  process.env.FIELD_NAMES = 'network,symbol,name,address,url,decimals,reason'
  it('processes request', () => {
    const body = `
      ### network
      POLYGON

      ### symbol
      USDC

      ### url
      https://some.url
      ### decimals
      99

      ### reason
      Something

      ### name
      USD Coin

      ### address
      0x123`
    const context = createContext(body)
    const core = createMockCore()

    processRequest(context, core)

    const info = getIssueInfo(core)
    assert.equal(info.network, 'POLYGON')
    assert.equal(info.chainId, 137)
  })

  it('handles errors', () => {
    const errorCases = [
      { labels: ['invalid'], pattern: /No valid operation/ },
      { labels: ['addToken'], pattern: /Missing required/ },
    ]

    for (const { labels, pattern } of errorCases) {
      const context = createContext('### network\nMAINNET', labels)
      const core = createMockCore()
      assert.throws(() => processRequest(context, core), pattern)
    }
  })
})
