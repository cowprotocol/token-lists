import { getTokenListVersion, isTruthy, writeTokenListToSrc } from '../tokenListUtils'
import { TokenList } from '@uniswap/token-lists/src/types'
import { PLATFORM_NETWORK_TO_CHAIN_ID, PlatformNetwork, PlatformToken } from './types'

const AUTH_TOKEN = '<AUTH_TOKEN>'

// 2 * 250 = 500 tokens
const pagesLimit = 2

const params = {
  minLiquidity: '1000',
  sortBy: 'liquidity',
  sortDirection: 'desc',
  limit: '250',
}

const platforms = ['balancerv2', 'pancakeswap', 'sushiswap', 'uniswapv2', 'curve']

function fetchPlatformTokens(platform: string): Promise<PlatformToken[]> {
  return Promise.all(Array.from({length: pagesLimit}).map((_, page) => {
    const request = new URLSearchParams({...params})

    Object.keys(PLATFORM_NETWORK_TO_CHAIN_ID).forEach(network => {
      request.append('network', network)
    })

    request.append('platforms', platform)
    request.append('page', (page).toString())

    return fetch('https://api.portals.fi/v2/tokens?' + request, {
      'headers': {
        'Authorization': 'Bearer ' + AUTH_TOKEN,
        'accept': 'application/json',
      },
    }).then(res => res.json()).then(res => res.tokens)
  })).then((res) => res.flat())
}

async function generateLpTokenLists(platform: string) {
  const results = await fetchPlatformTokens(platform)
  const fileName = `lp-tokens/${platform}.json`

  const list: TokenList = {
    name: `LP ${platform} Token List`,
    logoURI: 'https://files.cow.fi/token-lists/images/list-logo.png',
    timestamp: new Date().toISOString(),
    version: await getTokenListVersion(fileName),
    tokens: results.map(mapPlatformTokens).flat(),
  }

  writeTokenListToSrc(fileName, list)

  return list.tokens.length
}

function mapPlatformTokens(token: PlatformToken): TokenList['tokens'] {
  return Object.keys(token.addresses).map((network) => {
    const chainId = PLATFORM_NETWORK_TO_CHAIN_ID[network as PlatformNetwork]

    if (!chainId) return null

    return {
      chainId,
      address: token.address,
      name: token.name,
      decimals: token.decimals,
      symbol: token.symbol,
      extensions: {
        tokens: token.tokens.join(',')
      }
    }
  }).filter(isTruthy)
}

(async () => {
  await Promise.all(platforms.map(async platform => {
    console.log('Start generating', platform)

    try {
      const tokensLength = await generateLpTokenLists(platform)
      return console.log('Finish generating', {platform, tokensLength})
    } catch (e) {
      return console.error('Error generating', platform, e)
    }
  }))
})()
