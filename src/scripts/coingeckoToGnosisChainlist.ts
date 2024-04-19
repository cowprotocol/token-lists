import { generateGnosisChainList } from './generateGnosisChainList'
import sourceList from '../public/CoinGecko.json' assert { type: "json" }

const TOKENS_LIST_FILE_NAME = 'GnosisCoingeckoTokensList.json'

generateGnosisChainList(sourceList, TOKENS_LIST_FILE_NAME).catch(console.error)
