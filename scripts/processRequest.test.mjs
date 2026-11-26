import { describe, it, mock, afterEach } from 'node:test'
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

const attachmentUrl = 'https://github.com/user-attachments/assets/21404053-ee30-4e07-94c4-9b4f957bf476'
const imageUrl = 'https://example.com/image.png'
const createAddImageBody = (upload, url) => `### Network

MAINNET

### Address

0x123

### Logo upload

${upload}

### Image URL

${url}`

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
  process.env.FIELD_NAMES = 'Network,Symbol,Name,URL,Logo upload,Decimals,Address,Reason'

  const originalFetch = global.fetch
  afterEach(() => {
    global.fetch = originalFetch
    mock.restoreAll()
  })

  it('processes an Add Token attachment and enriches token metrics', async () => {
    // addToken triggers token-metrics enrichment (GeckoTerminal + CMC scrape) ->
    // mock fetch so the unit test stays offline.
    global.fetch = mock.fn(async () => ({
      ok: false,
      status: 404,
      text: async () => '',
      json: async () => ({}),
    }))
    // Enrichment hits the catch/warn path on a 404 -> stub console.warn so no warning leaks.
    mock.method(console, 'warn', () => {})

    const body = `
      ### Network
      POLYGON

      ### Token Symbol
      USDC

      ### Logo upload
      [USD Coin (logo).png](${attachmentUrl})

      ### Image URL
      _No response_

      ### Decimals
      99

      ### Reason
      Something

      ### Token Name
      USD Coin

      ### Address
      0x123`
    const context = createContext(body)
    const core = createMockCore()

    await processRequest(context, core)

    const info = getIssueInfo(core)
    assert.equal(info.network, 'POLYGON')
    assert.equal(info.chainId, 137)
    assert.equal(info.url, attachmentUrl)
    assert.equal(info.symbol, 'USDC')
    assert.equal(info.name, 'USD Coin')
    // Enrichment ran but the token is "unlisted" (404) -> n/a, PR still proceeds.
    assert.equal(info.marketCap, 'n/a')
    assert.equal(info.tokenHolders, 'n/a')
    assert.equal(info.cmcUrl, 'https://dex.coinmarketcap.com/token/polygon/0x123/')
    assert.equal(info.geckoTerminalUrl, 'https://www.geckoterminal.com/polygon_pos/tokens/0x123')
  })

  it('uses an Add Image attachment in preference to the fallback URL', async () => {
    const body = createAddImageBody(`![Logo.png](${attachmentUrl})`, imageUrl)
    const core = createMockCore()

    await processRequest(createContext(body, ['addImage']), core)

    assert.equal(getIssueInfo(core).url, attachmentUrl)
    assert.ok(
      core.setOutput.mock.calls.some((call) => call.arguments[0] === 'needsImageOptimization' && call.arguments[1]),
    )
  })

  it('keeps an external Image URL when the upload was left blank', async () => {
    for (const upload of ['', '_No response_']) {
      const body = createAddImageBody(upload, imageUrl)
      const core = createMockCore()

      await processRequest(createContext(body, ['addImage']), core)

      assert.equal(getIssueInfo(core).url, imageUrl)
    }
  })

  it('keeps a GitHub URL submitted through the old form', async () => {
    const body = `### Network\n\nMAINNET\n\n### Address\n\n0x123\n\n### Image URL\n\n${attachmentUrl}`
    const core = createMockCore()

    await processRequest(createContext(body, ['addImage']), core)

    assert.equal(getIssueInfo(core).url, attachmentUrl)
  })

  it('requires either an attachment or an Image URL', async () => {
    const body = createAddImageBody('', '_No response_')

    await assert.rejects(processRequest(createContext(body, ['addImage']), createMockCore()), /Logo upload or Image URL/)
  })

  it('rejects malformed or multiple attachments', async () => {
    const link = `[Logo.png](${attachmentUrl})`
    for (const upload of [`[Logo.png](${imageUrl})`, `${link}\n${link}`, `${link} ${link}`]) {
      const body = createAddImageBody(upload, imageUrl)

      await assert.rejects(
        processRequest(createContext(body, ['addImage']), createMockCore()),
        /Logo upload must contain one file/,
      )
    }
  })

  it('skips token-metrics enrichment for non-addToken operations', async () => {
    const fetchMock = mock.fn(async () => ({
      ok: false,
      status: 404,
      text: async () => '',
      json: async () => ({}),
    }))
    global.fetch = fetchMock

    const body = `
      ### network
      MAINNET

      ### reason
      No longer needed

      ### address
      0x123`
    const context = createContext(body, ['removeToken'])
    const core = createMockCore()

    await processRequest(context, core)

    assert.equal(fetchMock.mock.callCount(), 0)
    const info = getIssueInfo(core)
    assert.equal(info.marketCap, undefined)
  })

  it('handles errors', async () => {
    const errorCases = [
      { labels: ['invalid'], pattern: /No valid operation/ },
      { labels: ['addToken'], pattern: /Missing required/ },
    ]

    for (const { labels, pattern } of errorCases) {
      const context = createContext('### network\nMAINNET', labels)
      const core = createMockCore()
      await assert.rejects(processRequest(context, core), pattern)
    }
  })
})
