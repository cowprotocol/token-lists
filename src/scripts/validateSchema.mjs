import { readFileSync } from 'node:fs'
import Ajv from 'ajv'
import addFormats from 'ajv-formats'

const repo = new URL('../../', import.meta.url)
const LIST_FILE = 'src/public/CowSwap.json'

// The upstream TokenList schema caps names at 40 characters, which is too short for
// tokenized stocks and ETFs (e.g. "Franklin US Equity Bitcoin DRIP Index ETF (Ondo Tokenized)").
// Keep its other constraints and raise only the name limit to 64, enough for issuer-published names.
const schema = JSON.parse(readFileSync(new URL('node_modules/@uniswap/token-lists/dist/tokenlist.schema.json', repo)))
schema.definitions.TokenInfo.properties.name.maxLength = 64

const ajv = new Ajv({ allErrors: true, strict: false })
addFormats(ajv)
const validate = ajv.compile(schema)

const list = JSON.parse(readFileSync(new URL(LIST_FILE, repo), 'utf8'))
if (!validate(list)) {
  console.error(`${LIST_FILE} invalid`)
  console.error(ajv.errorsText(validate.errors, { separator: '\n', dataVar: 'data' }))
  process.exit(1)
}
console.log(`${LIST_FILE} valid`)
