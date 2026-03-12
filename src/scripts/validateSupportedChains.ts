import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { exit, cwd } from 'node:process'
import { ALL_CHAINS_IDS } from '@cowprotocol/cow-sdk'

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
  const supportedChainIds = new Set(ALL_CHAINS_IDS)
  const list: TokenList = JSON.parse(readFileSync(COWSWAP_JSON_PATH, 'utf-8'))
  const invalid = list.tokens.filter((token) => !supportedChainIds.has(token.chainId))

  if (invalid.length === 0) {
    console.log('All tokens in CowSwap.json use supported chain IDs.')
    exit(0)
  }

  console.error(
    `CowSwap.json contains ${invalid.length} token(s) with unsupported chainId:\n${invalid.map((t) => `- ${t.chainId}: ${t.symbol ?? '?'} (${t.address})`).join('\n')}`,
  )

  exit(1)
}

main()
