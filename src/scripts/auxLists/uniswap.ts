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
  chain: number,
  uniTokens: TokenInfo[],
  coingeckoTokensForChain: TokenInfo[],
): Promise<TokenInfo[]> {
  const mainnetTokens: TokenInfo[] = []
  const chainTokens: Record<string, TokenInfo> = {}

  // Split uni tokens into mainnet and chain
  uniTokens.forEach((token) => {
    if (token.chainId === +chain) {
      chainTokens[token.address.toLowerCase()] = token
    } else if (token.chainId === 1) {
      mainnetTokens.push(token)
    }
  })

  const coingeckoTokensMap = coingeckoTokensForChain.reduce<Record<string, TokenInfo>>((acc, token) => {
    acc[token.address.toLowerCase()] = token
    return acc
  }, {})

  mainnetTokens.forEach((token) => {
    const coingeckoId = COINGECKO_IDS_MAP[COINGECKO_CHAINS['1']][token.address.toLowerCase()]
    if (coingeckoId) {
      const chainAddress = COINGECKO_IDS_MAP[COINGECKO_CHAINS[chain]][coingeckoId]
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

export async function fetchAndProcessUniswapTokens(chainId: number): Promise<void> {
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
