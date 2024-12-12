import { fetchAndProcessCoingeckoTokens } from './coingecko'
import { fetchAndProcessUniswapTokens } from './uniswap'
import { COINGECKO_CHAINS } from './utils'

async function main(): Promise<void> {
  Object.keys(COINGECKO_CHAINS).forEach((chain) => fetchAndProcessCoingeckoTokens(Number(chain)))
  Object.keys(COINGECKO_CHAINS)
    .filter((chain) => chain !== '1') // No need to create a list for mainnet
    .forEach((chain) => fetchAndProcessUniswapTokens(Number(chain)))
}

main()
