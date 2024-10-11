import { SupportedChainId } from '@cowprotocol/cow-sdk'

export const PLATFORM_NETWORK_TO_CHAIN_ID = {
  ethereum: SupportedChainId.MAINNET,
  arbitrum: SupportedChainId.ARBITRUM_ONE,
  gnosis: SupportedChainId.GNOSIS_CHAIN,
}

export const BALANCER_NETWORK_TO_CHAIN_ID = {
  MAINNET: SupportedChainId.MAINNET,
  ARBITRUM: SupportedChainId.ARBITRUM_ONE,
  GNOSIS: SupportedChainId.GNOSIS_CHAIN,
}

type ArrayElement<A> = A extends readonly (infer T)[] ? T : never

export type PlatformNetwork = keyof typeof PLATFORM_NETWORK_TO_CHAIN_ID
export type BalancerNetwork = keyof typeof BALANCER_NETWORK_TO_CHAIN_ID

export interface PlatformToken {
  address: string
  decimals: number
  symbol: string
  name: string
  addresses: Record<ArrayElement<PlatformNetwork>, string>
  tokens: string[]
}

export interface BalancerGraphqlResponse {
  data: {
    count: number
    pools: BalancerGraphqlPool[]
  }
}

export interface BalancerGraphqlPool {
  address: string
  chain: BalancerNetwork
  createTime: number
  decimals: number
  name: string
  owner: string
  protocolVersion: number
  symbol: string
  displayTokens: Array<{
    address: string
    id: string
    name: string
    symbol: string
  }>
}
