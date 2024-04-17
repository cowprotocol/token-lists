import type { TokenInfo, TokenList } from '@uniswap/token-lists'
import { SupportedChainId } from '@cowprotocol/cow-sdk'
import { Contract } from '@ethersproject/contracts'
import { getProvider } from '../permitInfo/utils/getProvider'
import { writeTokenListToSrc } from './tokenListUtils'

import {
  MULTICALL_ADDRESS,
  OMNIBRIDGE_ADDRESS,
  ZERO_ADDRESS
} from './const'
import { OMNIBRIDGE_CONTRACT_ABI } from '../abi/omnibridgeAbi'
import { MULTICALL_ABI } from '../abi/multicallAbi'

type Call = {
  target: string
  callData: string
}

export async function generateGnosisChainList(source: string | TokenList, resultFile: string) {
  console.log('*** Map Uniswap tokens from Mainnet to Gnosis chain using Omnibridge ***')

  const provider = getProvider(SupportedChainId.GNOSIS_CHAIN, undefined)
  const bridgeContract = new Contract(OMNIBRIDGE_ADDRESS, OMNIBRIDGE_CONTRACT_ABI, provider)
  const multicall = new Contract(MULTICALL_ADDRESS, MULTICALL_ABI, provider)

  // Original Uniswap token list
  const tokensList = (typeof source === 'string' ? (await fetch(source).then((res: any) => res.json())) : source) as TokenList

  const calls = tokensList.tokens.reduce<{ token: TokenInfo, call: Call }[]>((acc, token) => {
    // Take only Mainnet tokens
    if (token.chainId !== SupportedChainId.MAINNET) return acc

    // A call to resolve token address in Gnosis chain
    const call = {
      target: bridgeContract.address,
      callData: bridgeContract.interface.encodeFunctionData('bridgedTokenAddress', [token.address]),
    }

    acc.push({token, call})

    return acc
  }, [])

  const tokens = await multicall.callStatic.tryAggregate(false, calls.map(({call}) => call)).then(results => {
    return results
      .reduce((acc: TokenInfo[], res: any, index: number) => {
        const token = calls[index]?.token

        // Address of the token in Gnosis chain
        const address = '0x' + res[1].slice(-40)

        // Get rid of tokens that are not known by Omnibridge
        if (!token || address === ZERO_ADDRESS) return acc

        // Copy everything from the Mainnet token and override address and chainId
        // Let's hope no one deploys the same token in a different networks with different data

        acc.push({
          ...token,
          chainId: SupportedChainId.GNOSIS_CHAIN,
          address,
          extensions: undefined
        })

        return acc
      }, [])
  })

  // Take the original Uniswap token list, override tokens by their copies in Gnosis chain and write into file
  writeTokenListToSrc(resultFile, {
    ...tokensList,
    tokens
  })

  console.log(`${resultFile} is updated, tokens count: ${tokens.length}`)
}
