import { mapSupportedNetworks, SupportedChainId } from '@cowprotocol/cow-sdk'
import { fetchAndProcessCoingeckoTokens } from './coingecko'
import { fetchAndProcessUniswapTokens } from './uniswap'
import { getCoingeckoTokenIdsMap, OverridesPerChain } from './utils'

const OVERRIDES: OverridesPerChain = mapSupportedNetworks({})
OVERRIDES[SupportedChainId.BASE]['0x18dd5b087bca9920562aff7a0199b96b9230438b'] = { decimals: 8 } // incorrect decimals set on CoinGecko's list

async function main(): Promise<void> {
  const COINGECKO_IDS_MAP = await getCoingeckoTokenIdsMap()

  fetchAndProcessCoingeckoTokens(COINGECKO_IDS_MAP, OVERRIDES)
  fetchAndProcessUniswapTokens(COINGECKO_IDS_MAP, OVERRIDES)
}

main()
