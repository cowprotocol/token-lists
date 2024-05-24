import { SupportedChainId } from '@cowprotocol/cow-sdk'
import { argv, exit } from 'node:process'
import coingeckoList from '../public/CoinGecko.json' assert { type: 'json' }
import { UNISWAP_TOKENS_LIST } from './const'
import { generateArbitrumOneChainList, generateGnosisChainList } from './generateBridgeList'

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
