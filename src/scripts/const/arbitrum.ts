export const ARBITRUM_BRIDGE_ADDRESS = '0x09e9222e96e7b4ae2a407b98d48e330053351eee'

/**
 * Most of the tokens that are bridged to Arbitrum using the bridge, they don't have liquidity, so the trade experience is not good.
 * This list is meant to limit the tokens shown to the ones that have liquidity.
 * 
 * Future versions of the script should decide using objective on-chain data if a token is liquid or not.
 */
export const TOKENS_WITH_LIQUIDITY = [
  'ARB', 'cbETH', 'GRT', 'LINK', 'USDC', 'USDT', 'WBTC', 'WETH',
]

/**
 * Tokens that are not supported by the bridge or have low liquidity, but we want to replace them with a different token.
 */
export const TOKENS_TO_REPLACE: Record<string, string | null> = {
  // USDC
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
  // WETH
  '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': '0x82af49447d8a07e3bd95bd0d56f35241523fbab1',
  // agEUR
  '0x1a7e4e63778b4f12a199c062f3efdd288afcbce8': '0xFA5Ed56A203466CbBC2430a43c66b9D8723528E7',
  // ARB
  '0xb50721bcf8d664c30412cfbc6cf7a15145234ad1': '0x912CE59144191C1204E64559FE8253a0e49E6548',
  // AXL
  '0x467719ad09025fcc6cf6f8311755809d45a5e5f3': '0x23ee2343B892b1BB63503a4FAbc840E0e2C6810f',
  // CELO
  '0x3294395e62f4eb6af3f1fcf89f5602d90fb3ef69': '0x4E51aC49bC5e2d87e0EF713E9e5AB2D71EF4F336',
  // DAI
  '0x6b175474e89094c44da98b954eedeac495271d0f': '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1',
  // GRT
  '0xc944e90c64b2c07662a292be6244bdf05cda44a7': '0x9623063377AD1B27544C965cCd7342f7EA7e88C7',
  // GYEN
  '0xc08512927d12348f6620a698105e1baac6ecd911': '0x589d35656641d6aB57A545F08cf473eCD9B6D5F7',
  // LPT
  '0x58b6a8a3302369daec383334672404ee733ab239': '0x289ba1701C2F088cf0faf8B3705246331cB8A839',
  // POND
  '0x57b946008913b82e4df85f501cbaed910e58d26c': '0xdA0a57B710768ae17941a9Fa33f8B720c8bD9ddD',
  // USDT
  '0xdac17f958d2ee523a2206206994597c13d831ec7': '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
}