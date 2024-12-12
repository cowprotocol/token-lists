import { fetchAndProcessCoingeckoTokens } from './coingecko.js'
import { fetchAndProcessUniswapTokens } from './uniswap.js'
import { COINGECKO_CHAINS } from './utils.js'

async function main() {
  Object.keys(COINGECKO_CHAINS).forEach((chain) => fetchAndProcessCoingeckoTokens(chain))
  Object.keys(COINGECKO_CHAINS)
    .filter((chain) => chain != 1) // No need to create a list for mainnet
    .forEach((chain) => fetchAndProcessUniswapTokens(chain))
}

main()
