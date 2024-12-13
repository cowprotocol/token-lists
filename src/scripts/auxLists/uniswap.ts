import { SupportedChainId } from '@cowprotocol/cow-sdk'
import { getCoingeckoTokenIdsMap } from './coingecko'
import { COINGECKO_CHAINS, fetchWithApiKey, processTokenList, TokenInfo } from './utils'

const UNISWAP_LIST = 'https://gateway.ipfs.io/ipns/tokens.uniswap.org'
let COINGECKO_IDS_MAP: Record<string, Record<string, string>> = {}

async function getUniswapTokens(): Promise<TokenInfo[]> {
  const response = await fetch(UNISWAP_LIST)
  const list = await response.json()
  return list.tokens
}

async function mapUniMainnetToChainTokens(
  chain: SupportedChainId,
  uniTokens: TokenInfo[],
  coingeckoTokensForChain: TokenInfo[],
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

    const coingeckoId = COINGECKO_IDS_MAP[coingeckoMainnetName][token.address.toLowerCase()]
    if (coingeckoId) {
      const chainAddress = COINGECKO_IDS_MAP[coingeckoChainName][coingeckoId]
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

export async function fetchAndProcessUniswapTokens(chainId: SupportedChainId): Promise<void> {
  try {
    COINGECKO_IDS_MAP = Object.keys(COINGECKO_IDS_MAP).length ? COINGECKO_IDS_MAP : await getCoingeckoTokenIdsMap()
    const uniTokens = await getUniswapTokens()
    const coingeckoTokens = await fetchWithApiKey(`https://tokens.coingecko.com/${COINGECKO_CHAINS[chainId]}/all.json`)

    const tokens = await mapUniMainnetToChainTokens(chainId, uniTokens, coingeckoTokens.tokens)

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
