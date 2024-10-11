import { SupportedChainId } from '@cowprotocol/cow-sdk'

export const PLATFORM_NETWORK_TO_CHAIN_ID = {
  ethereum: SupportedChainId.MAINNET,
  arbitrum: SupportedChainId.ARBITRUM_ONE,
  gnosis: SupportedChainId.GNOSIS_CHAIN,
}

type ArrayElement<A> = A extends readonly (infer T)[] ? T : never

export type PlatformNetwork = keyof typeof PLATFORM_NETWORK_TO_CHAIN_ID

export interface PlatformToken {
  address: string
  decimals: number
  symbol: string
  name: string
  addresses: Record<ArrayElement<PlatformNetwork>, string>
  tokens: string[]
}
