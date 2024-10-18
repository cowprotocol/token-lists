import { BALANCER_NETWORK_TO_CHAIN_ID, BalancerGraphqlPool, BalancerGraphqlResponse } from './types'
import { TokenList } from '@uniswap/token-lists'
import { getTokenListVersion, writeTokenListToSrc } from '../tokenListUtils'
import { TokenInfo } from '@uniswap/token-lists/src/types'

const operationName = 'GetPools'
const query = 'query GetPools($first: Int, $skip: Int, $orderBy: GqlPoolOrderBy, $orderDirection: GqlPoolOrderDirection, $where: GqlPoolFilter, $textSearch: String) {\n  pools: poolGetPools(\n    first: $first\n    skip: $skip\n    orderBy: $orderBy\n    orderDirection: $orderDirection\n    where: $where\n    textSearch: $textSearch\n  ) {\n    address\n    chain\n    createTime\n    decimals\n    protocolVersion\n    tags\n    displayTokens {\n      id\n      address\n      name\n      weight\n      symbol\n      nestedTokens {\n        id\n        address\n        name\n        weight\n        symbol\n        __typename\n      }\n      __typename\n    }\n    dynamicData {\n      totalLiquidity\n      lifetimeVolume\n      lifetimeSwapFees\n      volume24h\n      fees24h\n      holdersCount\n      swapFee\n      swapsCount\n      totalShares\n      aprItems {\n        id\n        title\n        apr\n        type\n        rewardTokenSymbol\n        rewardTokenAddress\n        __typename\n      }\n      __typename\n    }\n    staking {\n      id\n      type\n      chain\n      address\n      gauge {\n        id\n        gaugeAddress\n        version\n        status\n        workingSupply\n        otherGauges {\n          gaugeAddress\n          version\n          status\n          id\n          rewards {\n            id\n            tokenAddress\n            rewardPerSecond\n            __typename\n          }\n          __typename\n        }\n        rewards {\n          id\n          rewardPerSecond\n          tokenAddress\n          __typename\n        }\n        __typename\n      }\n      aura {\n        id\n        apr\n        auraPoolAddress\n        auraPoolId\n        isShutdown\n        __typename\n      }\n      __typename\n    }\n    factory\n    id\n    name\n    owner\n    symbol\n    type\n    userBalance {\n      totalBalance\n      totalBalanceUsd\n      walletBalance\n      walletBalanceUsd\n      stakedBalances {\n        balance\n        balanceUsd\n        stakingType\n        stakingId\n        __typename\n      }\n      __typename\n    }\n    __typename\n  }\n  count: poolGetPoolsCount(\n    first: $first\n    skip: $skip\n    orderBy: $orderBy\n    orderDirection: $orderDirection\n    where: $where\n    textSearch: $textSearch\n  )\n}'

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
      query,
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
