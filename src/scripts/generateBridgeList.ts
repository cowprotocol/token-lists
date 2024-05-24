import { SupportedChainId } from '@cowprotocol/cow-sdk'
import { Contract, ContractInterface } from '@ethersproject/contracts'
import type { TokenInfo, TokenList } from '@uniswap/token-lists'
import { ARBITRUM_BRIDGE_ABI } from '../abi/abitrumBridgeAbi'
import { MULTICALL_ABI } from '../abi/multicallAbi'
import { OMNIBRIDGE_CONTRACT_ABI } from '../abi/omnibridgeAbi'
import { getProvider } from '../permitInfo/utils/getProvider'
import { ARBITRUM_BRIDGE_ADDRESS, MULTICALL_ADDRESS, OMNIBRIDGE_ADDRESS, ZERO_ADDRESS } from './const'
import { writeTokenListToSrc } from './tokenListUtils'

type Call = {
  target: string
  callData: string
}

type Extensions = {
  bridgeInfo?: Record<
    SupportedChainId,
    {
      tokenAddress?: string
    }
  >
}

async function generateBridgedList(
  chainId: SupportedChainId,
  tokenListSource: string | TokenList,
  bridgeContractAddress: string,
  bridgeContractAbi: ContractInterface,
  methodName: string,
  outputFilePath: string,
  tokensToReplace: Record<string, string | null> = {},
): Promise<void> {
  const provider = getProvider(chainId, undefined)
  const bridgeContract = new Contract(bridgeContractAddress, bridgeContractAbi, provider)
  const multicall = new Contract(MULTICALL_ADDRESS, MULTICALL_ABI, provider)

  // Original source token list
  const tokensList = (
    typeof tokenListSource === 'string' ? await fetch(tokenListSource).then((res: any) => res.json()) : tokenListSource
  ) as TokenList

  const calls = tokensList.tokens.reduce<{ token: TokenInfo; call: Call }[]>((acc, token) => {
    // Take only Mainnet tokens
    if (token.chainId !== SupportedChainId.MAINNET) return acc
    // Do not check for tokens we want to skip/replace
    if (tokensToReplace[token.address.toLowerCase()] === null) return acc

    // A call to resolve token address in target chain
    const call = {
      target: bridgeContract.address,
      callData: bridgeContract.interface.encodeFunctionData(methodName, [token.address]),
    }

    acc.push({ token, call })

    return acc
  }, [])

  const tokens = await multicall.callStatic
    .tryAggregate(
      false,
      calls.map(({ call }) => call),
    )
    .then((results) => {
      return results.reduce((acc: TokenInfo[], res: any, index: number) => {
        const token = calls[index]?.token

        // Address of the token in the mapped chain
        const address = '0x' + res[1].slice(-40)

        // Get rid of tokens that are not known by the bridge contract
        if (!token || address === ZERO_ADDRESS) return acc

        const toReplace = tokensToReplace[token.address.toLowerCase()]
        if (toReplace !== undefined) {
          if (toReplace === null) {
            // Do not add to the list
            return acc
          }

          // Replace the fetched address with the one provided
          acc.push({
            ...token,
            chainId,
            address: toReplace,
            extensions: undefined,
          })

          return acc
        }
        // Copy everything from the Mainnet token and override address and chainId
        // Let's hope no one deploys the same token in a different networks with different data

        const extensions = token.extensions as Extensions
        const tokenAddress = extensions?.bridgeInfo?.[chainId]?.tokenAddress

        if (tokenAddress && tokenAddress.toLowerCase() !== address.toLowerCase()) {
          console.log(
            `TokenList extension contains address different than returned by bridge. Extension: ${tokenAddress} Bridge: ${address}`,
          )

          acc.push({
            ...token,
            chainId,
            address: tokenAddress,
            extensions: undefined,
          })

          return acc
        }

        // Use bridge address
        acc.push({
          ...token,
          chainId,
          address,
          extensions: undefined,
        })

        return acc
      }, [])
    })

  writeTokenListToSrc(outputFilePath, { ...tokensList, tokens })

  console.log(`${outputFilePath} is updated, tokens count: ${tokens.length}`)
}

export async function generateGnosisChainList(source: string | TokenList, resultFile: string) {
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

export async function generateArbitrumOneChainList(source: string | TokenList, resultFile: string) {
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
    },
  )
}
