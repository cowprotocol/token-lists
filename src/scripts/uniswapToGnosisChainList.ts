import { generateGnosisChainList } from './generateGnosisChainList'
import { UNISWAP_TOKENS_LIST } from './const'

const TOKENS_LIST_FILE_NAME = 'GnosisUniswapTokensList.json'

generateGnosisChainList(UNISWAP_TOKENS_LIST, TOKENS_LIST_FILE_NAME).catch(console.error)
