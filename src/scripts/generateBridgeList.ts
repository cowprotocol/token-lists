import { SupportedChainId } from '@cowprotocol/cow-sdk'
import { Contract, ContractInterface } from '@ethersproject/contracts'
import { JsonRpcProvider } from '@ethersproject/providers'
import type { TokenInfo, TokenList } from '@uniswap/token-lists'
import { ERC20_ABI } from '../abi/erc20'
import { MULTICALL_ABI } from '../abi/multicallAbi'
import { getProvider } from '../permitInfo/utils/getProvider'
import { MULTICALL_ADDRESS, ZERO_ADDRESS } from './const'
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


export interface GenerateBridgedListParams {
  chainId: SupportedChainId,
  tokenListSource: string | TokenList,
  bridgeContractAddress: string,
  bridgeContractAbi: ContractInterface,
  methodName: string,
  outputFilePath: string,
  tokenFilter?: (token: TokenInfo) => boolean,
  tokensToReplace: Record<string, string | null>,
}

/**
 * Generates a new token list, mapping the mainnet addresses from the provided list to the target chain
 * Writes the resulting list to a file
 *
 * @param chainId
 * @param tokenListSource
 * @param bridgeContractAddress
 * @param bridgeContractAbi
 * @param methodName
 * @param outputFilePath
 * @param tokensToReplace
 */
export async function generateBridgedList(params: GenerateBridgedListParams): Promise<void> {
  const { chainId, tokenListSource, bridgeContractAbi, bridgeContractAddress, methodName, outputFilePath, tokensToReplace = {}, tokenFilter } = params

  console.log('Chain: ' + chainId)
  console.log('Token List Source: ' + tokenListSource)
  console.log('Bridge Contract: ' + bridgeContractAddress)
  console.log('Method name: ' + methodName)

  const provider = getProvider(chainId, undefined)
  const bridgeContract = new Contract(bridgeContractAddress, bridgeContractAbi, provider)
  const multicall = new Contract(MULTICALL_ADDRESS, MULTICALL_ABI, provider)

  // Original source token list
  const tokensList = (
    typeof tokenListSource === 'string' ? await fetch(tokenListSource).then((res: any) => res.json()) : tokenListSource
  ) as TokenList

  const fetchBridgedAddressesCalls = getFetchBridgedAddressesCalls(
    tokensList,
    tokensToReplace,
    bridgeContract,
    methodName,
  )

  const bridgedAddresses = await multicall.callStatic
    .tryAggregate(
      false,
      fetchBridgedAddressesCalls.map(({ call }) => call),
    )
    .then((results) => parseBridgedAddressesResults(results, fetchBridgedAddressesCalls, tokensToReplace, chainId))

  const allTokens = await multicall.callStatic
    .tryAggregate(false, getTotalSupplyCalls(bridgedAddresses, provider))
    .then((results) => parseTotalSupplyResponses(results, bridgedAddresses, chainId))

  const tokens = tokenFilter ? allTokens.filter(tokenFilter) : allTokens
  console.log(`Total tokens: ${tokens.length}, filtered tokens: ${tokens.length}`)

  writeTokenListToSrc(outputFilePath, { ...tokensList, tokens })

  const filteredTokensCount = tokenFilter ? ` (Filtered out ${allTokens.length - tokens.length} tokens)` : ''

  console.log(`${outputFilePath} is updated, tokens count: ${tokens.length}${filteredTokensCount}`)
  console.log('Tokens included: ' + tokens.map((t) => t.symbol).join(', '))
  console.log('🎉 Done! Generated file ' + outputFilePath)
}

/**
 * Builds a list of calls for mapping the mainnet to the target chain address
 *
 * @param tokensList
 * @param tokensToReplace
 * @param bridgeContract
 * @param methodName
 */
function getFetchBridgedAddressesCalls(
  tokensList: TokenList,
  tokensToReplace: Record<string, string | null>,
  bridgeContract: Contract,
  methodName: string,
) {
  return tokensList.tokens.reduce<{ token: TokenInfo; call: Call }[]>((acc, token) => {
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
}

/**
 * Parses the result of bridged addresses multicall
 *
 * - Filters out known bad addresses
 * - Applies overwrites from config
 * - Applies mapping from token list
 *
 * @param results
 * @param fetchBridgedAddressesCalls
 * @param tokensToReplace
 * @param chainId
 *
 * @returns List of token obj and mapped addresses
 */
function parseBridgedAddressesResults(
  results: any,
  fetchBridgedAddressesCalls: {
    token: TokenInfo
    call: Call
  }[],
  tokensToReplace: Record<string, string | null>,
  chainId: SupportedChainId,
): { token: TokenInfo; address: string }[] {
  return results.reduce((acc: { token: TokenInfo; address: string }[], res: any, index: number) => {
    // Address of the token in the mapped chain
    const address = '0x' + res[1].slice(-40)
    const token = fetchBridgedAddressesCalls[index].token

    // Get rid of tokens that are not known by the bridge contract
    if (address === ZERO_ADDRESS) {
      console.log(`[Removal][${token.symbol}] Bridge mapped to zero address`, token.address)
      return acc
    }

    const toReplace = tokensToReplace[token.address.toLowerCase()]

    if (toReplace) {
      // Overwrite from config
      acc.push({ token, address: toReplace })
      console.log(`[Replacement][${token.symbol}] ${token.address} -> ${toReplace}`)
      return acc
    }

    const extensions = token.extensions as Extensions
    const tokenAddress = extensions?.bridgeInfo?.[chainId]?.tokenAddress

    if (tokenAddress && tokenAddress.toLowerCase() !== address.toLowerCase()) {
      console.log(
        `[Replacement][${token.symbol}] TokenList address differs from bridge. Mainnet: ${token.address} -> **Extension: ${tokenAddress}** | Bridge: ${address}`,
      )

      acc.push({ token, address: tokenAddress })

      return acc
    }

    acc.push({ token, address })
    return acc
  }, [])
}

/**
 * Builds a list of calls for fetching totalSupply for given addresses
 * @param bridgedAddresses
 * @param provider
 */
function getTotalSupplyCalls(
  bridgedAddresses: {
    token: TokenInfo
    address: string
  }[],
  provider: JsonRpcProvider,
): Call[] {
  return bridgedAddresses.map(({ address: target }) => {
    const erc20Contract = new Contract(target, ERC20_ABI, provider)

    // `totalSupply` is a required ERC20 method
    return { target, callData: erc20Contract.interface.encodeFunctionData('totalSupply') }
  })
}

/**
 * Parses totalSupply multicall responses
 *
 * - Filters out tokens that do not comply with ERC20 standard
 * - Filters out tokens that have less than 10 total supply on target chain
 *
 * @param results
 * @param bridgedAddresses
 * @param chainId
 *
 * @returns List of token objects
 */
function parseTotalSupplyResponses(
  results: any,
  bridgedAddresses: {
    token: TokenInfo
    address: string
  }[],
  chainId: SupportedChainId,
): TokenInfo[] {
  return results.reduce((acc: TokenInfo[], res: any, index: number) => {
    // Checks whether there's at least 10 units of given token at destination address
    // This also filters out addresses that are not deployed, since the response in this case is `0x`
    const isValidTokenAddress = +res[1] > 10

    const { token, address } = bridgedAddresses[index]

    if (!isValidTokenAddress) {
      console.log(`[Removal][${token.symbol}] Not a valid ERC20 at target chain`, res[1])
      return acc
    }

    acc.push({
      ...token,
      chainId,
      address,
      extensions: undefined,
    })

    return acc
  }, [])
}
