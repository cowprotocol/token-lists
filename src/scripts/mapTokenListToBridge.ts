import { SupportedChainId } from '@cowprotocol/cow-sdk'
import type { TokenList } from '@uniswap/token-lists'
import { argv, exit } from 'node:process'
import { ARBITRUM_BRIDGE_ABI } from '../abi/abitrumBridgeAbi'
import { OMNIBRIDGE_CONTRACT_ABI } from '../abi/omnibridgeAbi'
import coingeckoList from '../public/CoinGecko.json' assert { type: 'json' }
import { ARBITRUM_BRIDGE_ADDRESS, OMNIBRIDGE_ADDRESS, UNISWAP_TOKENS_LIST } from './const'
import { generateBridgedList } from './generateBridgeList'

const [, , chainId, listSource = 'coingecko'] = argv

if (!chainId) {
  console.error('ChainId is missing. Invoke the script with the chainId as the first parameter.')
  exit(1)
}

const source = listSource === 'coingecko' ? coingeckoList : UNISWAP_TOKENS_LIST

const outputFileNameSuffix = `${listSource === 'coingecko' ? 'Coingecko' : 'Uniswap'}TokensList.json`

switch (+chainId) {
  case SupportedChainId.GNOSIS_CHAIN:
    generateGnosisChainList(source, `Gnosis${outputFileNameSuffix}`).catch(console.error)
    break
  case SupportedChainId.ARBITRUM_ONE:
    generateArbitrumOneChainList(source, `ArbitrumOne${outputFileNameSuffix}`).catch(console.error)
    break
  default:
    console.error(`ChainId ${chainId} doesn't support bridge mapping`)
    exit(1)
}

async function generateGnosisChainList(source: string | TokenList, resultFile: string) {
  console.log('*** Map tokens from Mainnet to Gnosis chain using Omnibridge ***')

  generateBridgedList(
    SupportedChainId.GNOSIS_CHAIN,
    source,
    OMNIBRIDGE_ADDRESS,
    OMNIBRIDGE_CONTRACT_ABI,
    'bridgedTokenAddress',
    resultFile,
  )
}

async function generateArbitrumOneChainList(source: string | TokenList, resultFile: string) {
  console.log('*** Map tokens from Mainnet to Arbitrum One using Arbitrum bridge ***')

  generateBridgedList(
    SupportedChainId.ARBITRUM_ONE,
    source,
    ARBITRUM_BRIDGE_ADDRESS,
    ARBITRUM_BRIDGE_ABI,
    'calculateL2TokenAddress',
    resultFile,
    {
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
    },
  )
}
