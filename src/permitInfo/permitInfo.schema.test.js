import { describe, it } from 'node:test'
import assert from 'node:assert'
import Ajv from 'ajv'

import schema from './permitInfo.schema.json' with { type: 'json' }

describe('The permitInfo schema', () => {
  it('should be valid', () => {
    const ajv = new Ajv()

    assert.strictEqual(ajv.validateSchema(schema), true)
  })
})

describe('Valid PermitInfo data', () => {
  it('should be valid with `unsupported` type', () => {
    const data = {
      '0x0000000000000000000000000000000000000000': {
        type: 'unsupported',
        name: 'tokenName'
      },
    }

    const ajv = new Ajv()
    const result = ajv.validate(schema, data)

    assert.strictEqual(ajv.errors, null)
    assert.strictEqual(result, true)
  })

  it('should be valid with `eip-2612` and no version', () => {
    const data = {
      '0x0000000000000000000000000000000000000000': {
        type: 'eip-2612',
        name: 'tokenName'
      },
    }

    const ajv = new Ajv()
    const result = ajv.validate(schema, data)

    assert.strictEqual(ajv.errors, null)
    assert.strictEqual(result, true)
  })

  it('should be valid with `eip-2612` and version', () => {
    const data = {
      '0x0000000000000000000000000000000000000000': {
        type: 'eip-2612',
        version: '1',
        name: 'tokenName'
      },
    }

    const ajv = new Ajv()
    const result = ajv.validate(schema, data)

    assert.strictEqual(ajv.errors, null)
    assert.strictEqual(result, true)
  })

  it('should be valid with `dai-like` and no version', () => {
    const data = {
      '0x0000000000000000000000000000000000000000': {
        type: 'dai-like',
        name: 'tokenName'
      },
    }

    const ajv = new Ajv()
    const result = ajv.validate(schema, data)

    assert.strictEqual(ajv.errors, null)
    assert.strictEqual(result, true)
  })

  it('should be valid with `dai-like` and version', () => {
    const data = {
      '0x0000000000000000000000000000000000000000': {
        type: 'dai-like',
        version: '2',
        name: 'tokenName'
      },
    }

    const ajv = new Ajv()
    const result = ajv.validate(schema, data)

    assert.strictEqual(ajv.errors, null)
    assert.strictEqual(result, true)
  })
})

describe('Invalid PermitInfo data', () => {
  it('should be invalid with number version', () => {
    const data = {
      '0x0000000000000000000000000000000000000000': {
        type: 'eip-2612',
        version: 1,
        name: 'tokenName'
      },
    }

    const ajv = new Ajv()
    const result = ajv.validate(schema, data)

    assert.strictEqual(result, false)
    assert.notEqual(ajv.errors, null)
  })

  it('should be invalid with non integer version', () => {
    const data = {
      '0x0000000000000000000000000000000000000000': {
        type: 'eip-2612',
        version: '1.1',
        name: 'tokenName'
      },
    }

    const ajv = new Ajv()
    const result = ajv.validate(schema, data)

    assert.strictEqual(result, false)
    assert.notEqual(ajv.errors, null)
  })

  it('should be invalid without `name`', () => {
    const data = {
      '0x0000000000000000000000000000000000000000': {
        type: 'eip-2612',
      },
    }

    const ajv = new Ajv()
    const result = ajv.validate(schema, data)

    assert.strictEqual(result, false)
    assert.notEqual(ajv.errors, null)
  })

  it('should be invalid with non address key', () => {
    const data = {
      'not an address': false,
    }

    const ajv = new Ajv()
    const result = ajv.validate(schema, data)

    assert.strictEqual(result, false)
    assert.notEqual(ajv.errors, null)
  })

  it('should be invalid with `true` value', () => {
    const data = {
      '0x0000000000000000000000000000000000000000': true,
    }

    const ajv = new Ajv()
    const result = ajv.validate(schema, data)

    assert.strictEqual(result, false)
    assert.notEqual(ajv.errors, null)
  })

  it('should be invalid with non existent type', () => {
    const data = {
      '0x0000000000000000000000000000000000000000': {
        type: 'non-existent',
        name: 'tokenName'
      },
    }

    const ajv = new Ajv()
    const result = ajv.validate(schema, data)

    assert.strictEqual(result, false)
    assert.notEqual(ajv.errors, null)
  })


  it('should be invalid with `false` value', () => {
    const data = {
      '0x0000000000000000000000000000000000000000': false,
    }

    const ajv = new Ajv()
    const result = ajv.validate(schema, data)

    assert.strictEqual(result, false)
    assert.notEqual(ajv.errors, null)
  })
})
