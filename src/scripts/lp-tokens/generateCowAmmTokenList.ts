import { BALANCER_NETWORK_TO_CHAIN_ID, BalancerGraphqlPool, BalancerGraphqlResponse } from './types'
import { TokenList } from '@uniswap/token-lists'
import { getTokenListVersion, writeTokenListToSrc } from '../tokenListUtils'
import { TokenInfo } from '@uniswap/token-lists/src/types'
import { COW_AMM_POOLS_GQL } from './cowAmmGql'

const operationName = 'GetPools'

const pageSize = 50
const variables = {
  orderBy: 'totalLiquidity',
  orderDirection: 'desc',
  textSearch: null,
}

const where = {
  poolTypeIn: ['COW_AMM'],
  chainIn: Object.keys(BALANCER_NETWORK_TO_CHAIN_ID),
  userAddress: null,
  minTvl: 0,
  tagIn: null,
  tagNotIn: ['BLACK_LISTED']
}

async function generateCowAmmTokenList() {
  let page = 0
  let hasMore = true
  const totalPools: BalancerGraphqlPool[] = []

  while (hasMore) {
    console.log('Fetching balancer graphql', {page})
    const response = await fetchCoWAmmPools(page)
    const { pools } = response.data
    hasMore = pools.length === pageSize
    page++
    totalPools.push(...pools)
    console.log('Fetched balancer graphql', {poolsCount: pools.length, totalPoolsCount: totalPools.length})
  }

  const fileName = 'lp-tokens/cow-amm.json'

  const list: TokenList = {
    name: 'LP CoW Swap Token List',
    timestamp: new Date().toISOString(),
    version: await getTokenListVersion(fileName),
    tokens: totalPools.map(mapCoWAmmTokens).flat()
  }

  writeTokenListToSrc(fileName, list)
}

function mapCoWAmmTokens(pool: BalancerGraphqlPool): TokenInfo {
  const symbols = pool.displayTokens.map(token => token.symbol)
  const symbol = symbols.join('/')
  const name = `CoW AMM LP ${symbol}`

  return {
    chainId: BALANCER_NETWORK_TO_CHAIN_ID[pool.chain],
    address: pool.address,
    name,
    decimals: pool.decimals,
    symbol,
    extensions: {
      tokens: pool.displayTokens.map(token => token.address).join(',')
    }
  }
}

async function fetchCoWAmmPools(page: number): Promise<BalancerGraphqlResponse> {
  return fetch('https://api-v3.balancer.fi/graphql', {
    'headers': {
      'content-type': 'application/json',
    },
    'body': JSON.stringify({
      operationName,
      query: COW_AMM_POOLS_GQL,
      variables: {
        ...variables,
        first: pageSize,
        skip: page * pageSize,
        where
      }
    }),
    'method': 'POST'
  }).then(res => res.json())
}

generateCowAmmTokenList()
