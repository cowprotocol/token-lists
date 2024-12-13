import { SupportedChainId } from '@cowprotocol/cow-sdk'
import { COINGECKO_CHAINS, type COINGECKO_IDS_MAP, getTokenList, processTokenList, TokenInfo } from './utils'

const UNISWAP_LIST = 'https://gateway.ipfs.io/ipns/tokens.uniswap.org'

async function getUniswapTokens(): Promise<TokenInfo[]> {
  console.log(`fuck`)
  const response = await fetch(UNISWAP_LIST)
  const list = await response.json()
  return list.tokens
}

async function mapUniMainnetToChainTokens(
  chain: SupportedChainId,
  uniTokens: TokenInfo[],
  coingeckoTokensForChain: TokenInfo[],
  coingeckoIdsMap: COINGECKO_IDS_MAP,
): Promise<TokenInfo[]> {
  const mainnetTokens: TokenInfo[] = []
  const chainTokens: Record<string, TokenInfo> = {}

  // Split uni tokens into mainnet and chain
  uniTokens.forEach((token) => {
    if (token.chainId === chain) {
      chainTokens[token.address.toLowerCase()] = token
    } else if (token.chainId === SupportedChainId.MAINNET) {
      mainnetTokens.push(token)
    }
  })

  const coingeckoTokensMap = coingeckoTokensForChain.reduce<Record<string, TokenInfo>>((acc, token) => {
    acc[token.address.toLowerCase()] = token
    return acc
  }, {})
  const coingeckoMainnetName = COINGECKO_CHAINS[SupportedChainId.MAINNET]
  const coingeckoChainName = COINGECKO_CHAINS[chain]

  mainnetTokens.forEach((token) => {
    if (!coingeckoMainnetName || !coingeckoChainName) {
      return
    }

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
  })

  return Object.values(chainTokens)
}

async function fetchAndProcessUniswapTokensForChain(
  chainId: SupportedChainId,
  coingeckoIdsMap: COINGECKO_IDS_MAP,
  uniswapTokens: TokenInfo[],
): Promise<void> {
  try {
    const coingeckoTokens = await getTokenList(chainId)

    const tokens = await mapUniMainnetToChainTokens(chainId, uniswapTokens, coingeckoTokens, coingeckoIdsMap)

    await processTokenList({
      chainId,
      tokens,
      prefix: 'Uniswap',
      logo: 'ipfs://QmNa8mQkrNKp1WEEeGjFezDmDeodkWRevGFN8JCV7b4Xir',
      logMessage: `Uniswap tokens`,
      shouldAddCountToListName: false,
    })
  } catch (error) {
    console.error(`Error fetching data for chain ${chainId}:`, error)
  }
}

export async function fetchAndProcessUniswapTokens(coingeckoIdsMap: COINGECKO_IDS_MAP) {
  const uniTokens = await getUniswapTokens()

  Object.keys(COINGECKO_CHAINS)
    .filter((chain) => Number(chain) !== SupportedChainId.MAINNET && COINGECKO_CHAINS[+chain as SupportedChainId]) // No need to create a list for mainnet
    .forEach((chain) => fetchAndProcessUniswapTokensForChain(Number(chain), coingeckoIdsMap, uniTokens))
}
