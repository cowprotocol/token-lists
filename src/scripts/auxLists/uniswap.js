import { getCoingeckoTokenIdsMap } from './coingecko.js'
import { COINGECKO_CHAINS, fetchWithApiKey, processTokenList } from './utils.js'

const UNISWAP_LIST = 'https://gateway.ipfs.io/ipns/tokens.uniswap.org'
let COINGECKO_IDS_MAP = {}

async function getUniswapTokens() {
  const response = await fetch(UNISWAP_LIST)
  const list = await response.json()
  return list.tokens
}

async function mapUniMainnetToChainTokens(chain, uniTokens, coingeckoTokensForChain) {
  const mainnetTokens = []
  const chainTokens = {}

  // Split uni tokens into mainnet and chain
  uniTokens.forEach((token) => {
    if (token.chainId === +chain) {
      chainTokens[token.address.toLowerCase()] = token
    } else if (token.chainId === 1) {
      mainnetTokens.push(token)
    }
  })

  const coingeckoTokensMap = coingeckoTokensForChain.reduce((acc, token) => {
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

export async function fetchAndProcessUniswapTokens(chainId) {
  try {
    COINGECKO_IDS_MAP = Object.keys(COINGECKO_IDS_MAP).length || (await getCoingeckoTokenIdsMap())
    const uniTokens = await getUniswapTokens()
    const coingeckoTokens = await fetchWithApiKey(`https://tokens.coingecko.com/${COINGECKO_CHAINS[chainId]}/all.json`)

    const tokens = await mapUniMainnetToChainTokens(chainId, uniTokens, coingeckoTokens.tokens)

    await processTokenList({
      chainId,
      tokens,
      prefix: 'Uniswap',
      logMessage: `Uniswap tokens`,
    })
  } catch (error) {
    console.error(`Error fetching data for chain ${chainId}:`, error)
  }
}
