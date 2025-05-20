import { Logger } from 'winston'
import { SupportedChainId } from '@cowprotocol/cow-sdk'
import { TokenList } from '@uniswap/token-lists'
import * as fs from 'fs'
import path from 'path'
import { DISPLAY_CHAIN_NAMES, Overrides, TokenInfo } from './utils'

const FORMATTER = new Intl.NumberFormat('en-us', { style: 'currency', currency: 'USD' })

function getEmptyList(): Partial<TokenList> {
  return {
    keywords: ['defi'],
    version: { major: 0, minor: 0, patch: 0 },
    tokens: [],
  }
}

function getListName(chain: SupportedChainId, prefix: string): string {
  return `${prefix} on ${DISPLAY_CHAIN_NAMES[chain]}`
}

function getOutputPath(prefix: string, chainId: SupportedChainId): string {
  return `src/public/${prefix}.${chainId}.json`
}

function getLocalTokenList(listPath: string, defaultEmptyList: Partial<TokenList>): Partial<TokenList> {
  try {
    return JSON.parse(fs.readFileSync(listPath, 'utf8'))
  } catch (error) {
    console.warn(`Error reading token list from ${listPath}:`, error)
    return defaultEmptyList
  }
}

function getTokenListVersion(list: Partial<TokenList>, tokens: TokenInfo[]): TokenList['version'] {
  const version = list.version || { major: 0, minor: 0, patch: 0 }
  const currentAddresses = new Set(list.tokens?.map((token) => token.address.toLowerCase()) || [])
  const newAddresses = new Set(tokens.map((token) => token.address.toLowerCase()))

  // Check for removed tokens
  if (newAddresses.size < currentAddresses.size || !isSubsetOf(currentAddresses, newAddresses)) {
    return { major: version.major + 1, minor: 0, patch: 0 }
  }

  // Check for added tokens
  if (newAddresses.size > currentAddresses.size) {
    return { ...version, minor: version.minor + 1, patch: 0 }
  }

  // Check for changes in token details
  if (currentAddresses.size === newAddresses.size) {
    for (const listToken of list.tokens || []) {
      const token = tokens.find((token) => token.address.toLowerCase() === listToken.address.toLowerCase())
      if (
        token &&
        (listToken.name !== token.name ||
          listToken.symbol !== token.symbol ||
          listToken.decimals !== token.decimals ||
          listToken.logoURI !== token.logoURI)
      ) {
        return { ...version, patch: version.patch + 1 }
      }
    }
  }

  return version
}

interface SaveUpdatedTokensParams {
  chainId: SupportedChainId
  prefix: string
  logo: string
  tokens: TokenInfo[]
  listName: string
  replaceExisting: boolean
}

function mergeOrReplaceTokens(currentList: TokenInfo[], newList: TokenInfo[], replaceExisting: boolean): TokenInfo[] {
  if (!replaceExisting) {
    // merge tokens from currentList.tokens with tokens
    return Object.values(
      [...currentList, ...newList].reduce<Record<string, TokenInfo>>((acc, t) => {
        if (!acc[t.address.toLowerCase()]) {
          acc[t.address.toLowerCase()] = t
        }
        return acc
      }, {}),
    )
  }
  return newList
}

function saveUpdatedTokens({
  chainId,
  prefix,
  logo,
  tokens: newTokens,
  listName,
  replaceExisting,
}: SaveUpdatedTokensParams): void {
  const tokenListPath = path.join(getOutputPath(prefix, chainId))
  const currentList = getLocalTokenList(tokenListPath, getEmptyList())

  const tokens = mergeOrReplaceTokens(currentList.tokens || [], newTokens, replaceExisting)

  try {
    const version = getTokenListVersion(currentList, tokens)

    if (JSON.stringify(currentList.version) !== JSON.stringify(version)) {
      const updatedList: TokenList = {
        ...currentList,
        tokens,
        name: listName,
        logoURI: logo,
        version,
        timestamp: new Date().toISOString(),
      }
      fs.writeFileSync(tokenListPath, JSON.stringify(updatedList, null, 2))
      console.log(`Token list saved to ${tokenListPath}`)
    } else {
      console.log(`No changes detected for '${DISPLAY_CHAIN_NAMES[chainId]}'. Token list not updated.`)
    }
  } catch (error) {
    console.error(`Error saving token list to ${tokenListPath}:`, error)
  }
}

interface ProcessTokenListParams {
  chainId: SupportedChainId
  tokens: TokenInfo[]
  prefix: string
  logo: string
  overrides?: Overrides
  replaceExisting?: boolean
  logMessage: string
  logger: Logger
}

export async function processTokenList({
  chainId,
  tokens,
  prefix,
  logo,
  overrides = {},
  replaceExisting = true,
  logMessage,
  logger,
}: ProcessTokenListParams): Promise<void> {
  logger.info(`🥇 ${logMessage} on chain ${chainId}`)

  tokens.forEach((token, index) => {
    const volumeStr = token.volume ? `: ${FORMATTER.format(token.volume)}` : ''
    logger.info(`\t-${(index + 1).toString().padStart(3, '0')}) ${token.name} (${token.symbol})${volumeStr}`)
  })

  const updatedTokens = tokens.map(({ volume: _, ...token }) => {
    const override = overrides[token.address.toLowerCase()]
    return {
      ...token,
      ...override,
      logoURI: token.logoURI ? token.logoURI.replace(/thumb/, 'large') : undefined,
    }
  })

  const listName = getListName(chainId, prefix)
  saveUpdatedTokens({ chainId, prefix, logo, tokens: updatedTokens, listName, replaceExisting })
}

function isSubsetOf(setA: Set<string>, setB: Set<string>): boolean {
  for (let item of setA) {
    if (!setB.has(item)) {
      return false
    }
  }
  return true
}
