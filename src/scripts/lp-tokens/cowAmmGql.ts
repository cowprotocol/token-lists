export const COW_AMM_POOLS_GQL = `query GetPools($first: Int, $skip: Int, $orderBy: GqlPoolOrderBy, $orderDirection: GqlPoolOrderDirection, $where: GqlPoolFilter, $textSearch: String) {
  pools: poolGetPools(
    first: $first
    skip: $skip
    orderBy: $orderBy
    orderDirection: $orderDirection
    where: $where
    textSearch: $textSearch
  ) {
    address
    chain
    createTime
    decimals
    protocolVersion
    tags
    displayTokens {
      id
      address
      name
      weight
      symbol
      nestedTokens {
        id
        address
        name
        weight
        symbol
        __typename
      }
      __typename
    }
    dynamicData {
      totalLiquidity
      lifetimeVolume
      lifetimeSwapFees
      volume24h
      fees24h
      holdersCount
      swapFee
      swapsCount
      totalShares
      aprItems {
        id
        title
        apr
        type
        rewardTokenSymbol
        rewardTokenAddress
        __typename
      }
      __typename
    }
    staking {
      id
      type
      chain
      address
      gauge {
        id
        gaugeAddress
        version
        status
        workingSupply
        otherGauges {
          gaugeAddress
          version
          status
          id
          rewards {
            id
            tokenAddress
            rewardPerSecond
            __typename
          }
          __typename
        }
        rewards {
          id
          rewardPerSecond
          tokenAddress
          __typename
        }
        __typename
      }
      aura {
        id
        apr
        auraPoolAddress
        auraPoolId
        isShutdown
        __typename
      }
      __typename
    }
    factory
    id
    name
    owner
    symbol
    type
    userBalance {
      totalBalance
      totalBalanceUsd
      walletBalance
      walletBalanceUsd
      stakedBalances {
        balance
        balanceUsd
        stakingType
        stakingId
        __typename
      }
      __typename
    }
    __typename
  }
  count: poolGetPoolsCount(
    first: $first
    skip: $skip
    orderBy: $orderBy
    orderDirection: $orderDirection
    where: $where
    textSearch: $textSearch
  )
}`
