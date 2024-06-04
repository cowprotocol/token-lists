import { Contract } from '@ethersproject/contracts'
import { JsonRpcProvider } from '@ethersproject/providers'
import { ERC20_ABI } from "../../abi/erc20";
import type { TokenInfo } from '@uniswap/token-lists'


function handleErrorReturnEmptyString(error: any) {
  console.error(error)
  return ''
}

export interface Erc20Info {
  symbol: string
  decimals: number
  name: string
}

export async function getTokenInfos(tokenAddresses: string[], _multicall: Contract, provider: JsonRpcProvider): Promise<Map<string, Erc20Info>> {
  const tokenInfos = new Map<string, Erc20Info>();
  let i = 0
  for (const address of tokenAddresses) {
    console.log('Get token info for ', address, i++)
    const erc20Contract = new Contract(address, ERC20_ABI, provider)
    const symbol = await erc20Contract.symbol().catch(handleErrorReturnEmptyString)
    const decimals = await erc20Contract.decimals().catch((e: any) => {
      console.error('Error getting decimals for ', address, e)
      return 18
    })
    const name = await erc20Contract.name().catch(handleErrorReturnEmptyString)

    tokenInfos.set(address.toLowerCase(), {
      symbol,
      decimals,
      name,
    })
  }

  return tokenInfos
}

// TODO: Implement using multi-call (took a shortcut for the launch as they were not so many tokens, will fix in a follow up PR)
// export async function getTokenInfos(tokenAddresses: string[], multicall: Contract, provider: JsonRpcProvider) { // : TokenInfo[]
//   const calls = tokenAddresses.map((address) => {
//     const erc20Contract = new Contract(address, ERC20_ABI, provider)
//     return {
//       target: address,
//       callData: erc20Contract.interface.encodeFunctionData('symbol')
//     }
//   });

//   await multicall
//     .callStatic
//     .tryAggregate(false, calls)
//     .then((results) => {
//       console.log('MULTI-CALL result', calls, results)
//     })

//   throw new Error('Not implemented');
// }

/**
 * Merge the information of two tokens, giving precedence to the second token.
 * This function will consider a empty string as a undefined value.
 * 
 * @param token Token with whose data has less precedence
 * @param tokenOverride Token with whose data has more precedence
 * 
 * @returns the merged token information
 */
export function mergeTokens(token: TokenInfo, tokenOverride: TokenInfo): TokenInfo {
  const { address, symbol, name, decimals, extensions, logoURI, ...rest } = token
  const { address: addressOverride, symbol: symbolOverride, name: nameOverride, decimals: decimalsOverride, extensions: extensionsOverride, logoURI: logoURIOverride, ...restOverride } = tokenOverride

  return {
    ...rest,
    ...restOverride,
    name: nameOverride || name,
    symbol: symbolOverride || symbol,
    logoURI: logoURIOverride || logoURI,
    decimals: decimalsOverride || decimals,
    address: addressOverride || address,

    extensions: {
      ...extensions,
      ...extensionsOverride,
    }
  }
}

export function mergeErc20Info(onchainInfo: Erc20Info, tokenOverride: TokenInfo): TokenInfo {
  const { symbol, name, decimals } = onchainInfo


  return {
    ...tokenOverride,
    name: tokenOverride.name || name,
    symbol: tokenOverride.symbol || symbol,
    decimals: tokenOverride.decimals || decimals,

    extensions: tokenOverride.extensions
  }
}