import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import type { TokenList } from '@uniswap/token-lists'

import {
  buildWarnings,
  chunk,
  collectMints,
  findUnansweredMints,
  isUnchanged,
  normalizeSeverity,
  serializeWarningsFile,
  type ShieldResponse,
  type TokenWarningsFile,
} from './warnings.ts'

function list(...addresses: string[]): TokenList {
  return {
    name: 'test',
    timestamp: '2026-01-01T00:00:00.000Z',
    version: { major: 1, minor: 0, patch: 0 },
    tokens: addresses.map((address) => ({
      chainId: 1000000001,
      address,
      name: address,
      symbol: address,
      decimals: 9,
    })),
  }
}

function response(warnings: ShieldResponse['warnings']): ShieldResponse {
  return { warnings }
}

const MINT_AUTHORITY = {
  type: 'HAS_MINT_AUTHORITY',
  message: "The authority's owner has the ability to mint more tokens",
  severity: 'info',
}

const FREEZE_AUTHORITY = {
  type: 'HAS_FREEZE_AUTHORITY',
  message: "The authority's owner has the ability to freeze your token account",
  severity: 'warning',
}

const TRANSFER_FEE = {
  type: '2.69%_TRANSFER_FEES',
  message: 'This token has a transfer fee of 2.69%',
  severity: 'critical',
}

describe('chunk', () => {
  it('splits into batches of the given size', () => {
    assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]])
  })

  it('returns no batches for an empty input', () => {
    assert.deepEqual(chunk([], 50), [])
  })

  it('keeps a shorter input as a single batch', () => {
    assert.deepEqual(chunk([1, 2], 50), [[1, 2]])
  })
})

describe('collectMints', () => {
  it('merges the lists, de-duplicates, and sorts', () => {
    assert.deepEqual(collectMints([list('Zb', 'Ac'), list('Ac', 'Mz')]), ['Ac', 'Mz', 'Zb'])
  })

  it('drops the native SOL placeholder, which is not a mint', () => {
    assert.deepEqual(collectMints([list('11111111111111111111111111111111', 'Ac')]), ['Ac'])
  })

  it('sorts base58 case-sensitively', () => {
    // 'Z' (0x5A) sorts before 'a' (0x61) by codepoint, unlike a locale-aware sort
    assert.deepEqual(collectMints([list('aa', 'Zz')]), ['Zz', 'aa'])
  })
})

describe('normalizeSeverity', () => {
  it('passes known severities through', () => {
    assert.equal(normalizeSeverity('critical'), 'critical')
    assert.equal(normalizeSeverity('info'), 'info')
  })

  it('promotes an unknown severity to warning', () => {
    assert.equal(normalizeSeverity('catastrophic'), 'warning')
  })
})

describe('buildWarnings', () => {
  it('publishes short codes, not Shield type strings', () => {
    const { types, warnings } = buildWarnings([response({ mintA: [MINT_AUTHORITY, FREEZE_AUTHORITY] })])

    assert.deepEqual(warnings['mintA'], ['FREEZE', 'MINT'])
    assert.deepEqual(Object.keys(types), ['FREEZE', 'MINT'])
  })

  it('hoists severity and message onto the type, not each mint', () => {
    const { types } = buildWarnings([response({ mintA: [MINT_AUTHORITY], mintB: [MINT_AUTHORITY] })])

    assert.deepEqual(types['MINT'], { severity: 'info', message: MINT_AUTHORITY.message })
  })

  it('drops transfer-fee warnings entirely', () => {
    const { types, warnings } = buildWarnings([response({ mintA: [TRANSFER_FEE, MINT_AUTHORITY] })])

    assert.deepEqual(warnings['mintA'], ['MINT'])
    assert.deepEqual(Object.keys(types), ['MINT'])
  })

  it('omits a mint whose only warnings were dropped', () => {
    const { warnings } = buildWarnings([response({ mintA: [TRANSFER_FEE], mintB: [MINT_AUTHORITY] })])

    assert.deepEqual(Object.keys(warnings), ['mintB'])
  })

  it('omits mints with no warnings', () => {
    const { warnings } = buildWarnings([response({ mintA: [], mintB: [MINT_AUTHORITY] })])

    assert.deepEqual(Object.keys(warnings), ['mintB'])
  })

  it('merges responses from several batches', () => {
    const { warnings } = buildWarnings([response({ mintB: [MINT_AUTHORITY] }), response({ mintA: [FREEZE_AUTHORITY] })])

    assert.deepEqual(Object.keys(warnings), ['mintA', 'mintB'])
  })

  it('sorts mints and each mint’s codes so reruns produce no diff', () => {
    const first = buildWarnings([response({ mintB: [MINT_AUTHORITY, FREEZE_AUTHORITY] })])
    const second = buildWarnings([response({ mintB: [FREEZE_AUTHORITY, MINT_AUTHORITY] })])

    assert.equal(JSON.stringify(first), JSON.stringify(second))
  })
})

describe('isUnchanged', () => {
  const content = buildWarnings([response({ mintA: [MINT_AUTHORITY] })])

  const current: TokenWarningsFile = {
    timestamp: '2026-01-01T00:00:00.000Z',
    chainId: 1000000001,
    ...content,
  }

  it('is false when there is no current file', () => {
    assert.equal(isUnchanged(content, null), false)
  })

  it('is true when types and warnings both match', () => {
    assert.equal(isUnchanged(buildWarnings([response({ mintA: [MINT_AUTHORITY] })]), current), true)
  })

  it('is false when a warning is added', () => {
    assert.equal(isUnchanged(buildWarnings([response({ mintA: [MINT_AUTHORITY, FREEZE_AUTHORITY] })]), current), false)
  })

  it('is false when only a message is reworded', () => {
    const reworded = buildWarnings([response({ mintA: [{ ...MINT_AUTHORITY, message: 'Reworded upstream' }] })])

    assert.equal(isUnchanged(reworded, current), false)
  })
})

describe('serializeWarningsFile', () => {
  const file: TokenWarningsFile = {
    timestamp: '2026-01-01T00:00:00.000Z',
    chainId: 1000000001,
    ...buildWarnings([response({ mintA: [MINT_AUTHORITY, FREEZE_AUTHORITY], mintB: [MINT_AUTHORITY] })]),
  }

  it('round-trips through JSON.parse', () => {
    assert.deepEqual(JSON.parse(serializeWarningsFile(file)), file)
  })

  it('keeps each mint on one line, so a changed mint is a one-line diff', () => {
    const lines = serializeWarningsFile(file).split('\n')

    assert.ok(lines.some((line) => line.includes('"mintA": ["FREEZE","MINT"]')))
    assert.ok(lines.some((line) => line.includes('"mintB": ["MINT"]')))
  })

  it('ends with a trailing newline', () => {
    assert.ok(serializeWarningsFile(file).endsWith('}\n'))
  })
})

describe('findUnansweredMints', () => {
  it('returns nothing when every mint was answered for', () => {
    assert.deepEqual(findUnansweredMints(['mintA', 'mintB'], response({ mintA: [MINT_AUTHORITY], mintB: [] })), [])
  })

  it('treats an empty array as answered, because that is how Shield says "clean"', () => {
    assert.deepEqual(findUnansweredMints(['mintA'], response({ mintA: [] })), [])
  })

  it('reports the mints Shield silently dropped, which would otherwise publish as clean', () => {
    const truncated = response({ mintA: [MINT_AUTHORITY] })

    assert.deepEqual(findUnansweredMints(['mintA', 'mintB', 'mintC'], truncated), ['mintB', 'mintC'])
  })
})
