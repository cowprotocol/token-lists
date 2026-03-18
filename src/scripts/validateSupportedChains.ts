import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { exit, cwd } from 'node:process'
import { isEvmChain } from '@cowprotocol/cow-sdk'

const COWSWAP_JSON_PATH = join(cwd(), 'src', 'public', 'CowSwap.json')

interface TokenEntry {
  address: string
  symbol?: string
  name?: string
  chainId: number
}

interface TokenList {
  tokens: TokenEntry[]
}

function main(): void {
  const list: TokenList = JSON.parse(readFileSync(COWSWAP_JSON_PATH, 'utf-8'))
  const invalid = list.tokens.filter((token) => !isEvmChain(token.chainId))

  if (invalid.length === 0) {
    console.log('\n✅ All tokens in CowSwap.json use supported chain IDs.\n')
    exit(0)
  }

  console.error(
    `\n❌ CowSwap.json contains ${invalid.length} token(s) with unsupported chainId:\n${invalid.map((t) => `- ${t.chainId}: ${t.symbol ?? '?'} (${t.address})`).join('\n')}\n`,
  )

  exit(1)
}

main()
