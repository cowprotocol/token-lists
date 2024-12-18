import { SupportedChainId } from '@cowprotocol/cow-sdk'
import { processTokenList } from './processTokenList'
import { COINGECKO_CHAINS, type CoingeckoIdsMap, getTokenList, Overrides, OverridesPerChain, TokenInfo } from './utils'

const UNISWAP_LIST = 'https://gateway.ipfs.io/ipns/tokens.uniswap.org'
const UNISWAP_LOGO = 'ipfs://QmNa8mQkrNKp1WEEeGjFezDmDeodkWRevGFN8JCV7b4Xir'

interface TokenMap {
  [address: string]: TokenInfo
}

/**
 * Fetches the Uniswap token list from IPFS
 */
async function getUniswapTokens(): Promise<TokenInfo[]> {
  try {
    const response = await fetch(UNISWAP_LIST)
    if (!response.ok) {
      throw new Error(`Failed to fetch Uniswap list: ${response.statusText}`)
    }
    const list = await response.json()
    return list.tokens
  } catch (error) {
    console.error('Error fetching Uniswap tokens:', error)
    return []
  }
}

/**
 * Creates a map of token addresses to TokenInfo objects
 */
function createTokenMap(tokens: TokenInfo[]): TokenMap {
  return tokens.reduce<TokenMap>((acc, token) => {
    acc[token.address.toLowerCase()] = token
    return acc
  }, {})
}

/**
 * Maps Ethereum mainnet tokens to their equivalent on other chains
 */
async function mapUniMainnetToChainTokens(
  chain: SupportedChainId,
  uniTokens: TokenInfo[],
  coingeckoTokensForChain: TokenInfo[],
  coingeckoIdsMap: CoingeckoIdsMap,
): Promise<TokenInfo[]> {
  // Split tokens by chain
  const mainnetTokens = uniTokens.filter((token) => token.chainId === SupportedChainId.MAINNET)
  const chainTokens = createTokenMap(uniTokens.filter((token) => token.chainId === chain))

  const coingeckoTokensMap = createTokenMap(coingeckoTokensForChain)
  const coingeckoMainnetName = COINGECKO_CHAINS[SupportedChainId.MAINNET]
  const coingeckoChainName = COINGECKO_CHAINS[chain]

  if (!coingeckoMainnetName || !coingeckoChainName) {
    console.warn(`Missing Coingecko chain mapping for chain ${chain}`)
    return Object.values(chainTokens)
  }

  // Map mainnet tokens to their equivalents on the target chain
  for (const token of mainnetTokens) {
    const coingeckoId = coingeckoIdsMap[coingeckoMainnetName][token.address.toLowerCase()]
    if (coingeckoId) {
      const chainAddress = coingeckoIdsMap[coingeckoChainName][coingeckoId]
      if (!chainTokens[chainAddress]) {
        const cgToken = coingeckoTokensMap[chainAddress]
        if (cgToken) {
          chainTokens[chainAddress] = cgToken
        }
      }
    }
  }

  return Object.values(chainTokens)
}

/**
 * Processes Uniswap tokens for a specific chain
 */
async function fetchAndProcessUniswapTokensForChain(
  chainId: SupportedChainId,
  coingeckoIdsMap: CoingeckoIdsMap,
  uniswapTokens: TokenInfo[],
  overrides: Overrides,
): Promise<void> {
  try {
    const coingeckoTokens = await getTokenList(chainId)
    const tokens = await mapUniMainnetToChainTokens(chainId, uniswapTokens, coingeckoTokens, coingeckoIdsMap)

    await processTokenList({
      chainId,
      tokens,
      prefix: 'Uniswap',
      logo: UNISWAP_LOGO,
      overrides,
      replaceExisting: false,
      logMessage: `Uniswap tokens`,
    })
  } catch (error) {
    console.error(`Error processing Uniswap tokens for chain ${chainId}:`, error)
  }
}

/**
 * Main function to fetch and process Uniswap tokens for all supported chains
 */
export async function fetchAndProcessUniswapTokens(
  coingeckoIdsMap: CoingeckoIdsMap,
  overrides: OverridesPerChain,
): Promise<void> {
  const uniTokens = await getUniswapTokens()

  const supportedChains = Object.keys(COINGECKO_CHAINS)
    .map(Number)
    .filter((chain) => chain !== SupportedChainId.MAINNET && COINGECKO_CHAINS[chain as SupportedChainId])

  await Promise.all(
    supportedChains.map((chain) =>
      fetchAndProcessUniswapTokensForChain(chain, coingeckoIdsMap, uniTokens, overrides[chain as SupportedChainId]),
    ),
  )
}
