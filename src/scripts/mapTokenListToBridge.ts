import { SupportedChainId } from '@cowprotocol/cow-sdk'
import type { TokenList } from '@uniswap/token-lists'
import { argv, exit } from 'node:process'
import { ARBITRUM_BRIDGE_ABI } from '../abi/abitrumBridgeAbi'
import { OMNIBRIDGE_CONTRACT_ABI } from '../abi/omnibridgeAbi'
import coingeckoList from '../public/CoinGecko.json' assert { type: 'json' }
import { OMNIBRIDGE_ADDRESS, UNISWAP_TOKENS_LIST } from './const'
import { generateBridgedList } from './generateBridgeList'
import { ARBITRUM_BRIDGE_ADDRESS, TOKENS_TO_REPLACE, TOKENS_WITH_LIQUIDITY } from './const/arbitrum'

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

  generateBridgedList({
    chainId: SupportedChainId.GNOSIS_CHAIN,
    tokenListSource: source,
    bridgeContractAddress: OMNIBRIDGE_ADDRESS,
    bridgeContractAbi: OMNIBRIDGE_CONTRACT_ABI,
    methodName: 'calculateL2TokenAddress',
    outputFilePath: resultFile,
    tokensToReplace: TOKENS_TO_REPLACE,
  })
}

async function generateArbitrumOneChainList(source: string | TokenList, resultFile: string) {
  console.log('*** Map tokens from Mainnet to Arbitrum One using Arbitrum bridge ***')

  generateBridgedList({
    chainId: SupportedChainId.ARBITRUM_ONE,
    tokenListSource: source,
    bridgeContractAddress: ARBITRUM_BRIDGE_ADDRESS,
    bridgeContractAbi: ARBITRUM_BRIDGE_ABI,
    methodName: 'calculateL2TokenAddress',
    outputFilePath: resultFile,

    // Use token addresses from the canonical token (not the bridge one)
    tokensToReplace: TOKENS_TO_REPLACE,

    // Filter out tokens that don't have liquidity
    tokenFilter: (token) => TOKENS_WITH_LIQUIDITY.includes(token.symbol),
  })
}
