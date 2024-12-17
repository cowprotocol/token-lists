import { fetchAndProcessCoingeckoTokens } from './coingecko'
import { fetchAndProcessUniswapTokens } from './uniswap'
import { getCoingeckoTokenIdsMap } from './utils'

async function main(): Promise<void> {
  const COINGECKO_IDS_MAP = await getCoingeckoTokenIdsMap()

  fetchAndProcessCoingeckoTokens(COINGECKO_IDS_MAP)
  fetchAndProcessUniswapTokens(COINGECKO_IDS_MAP)
}

main()
