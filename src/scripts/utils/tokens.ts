import { Contract } from '@ethersproject/contracts'
import { JsonRpcProvider } from '@ethersproject/providers'
import { } from '@ethersproject/strings'
import { ERC20_ABI } from "../../abi/erc20";
import type { TokenInfo } from '@uniswap/token-lists'
import { readCsv } from './csv'

interface ReturnCall {
  success: boolean
  returnData: string
}

export interface Erc20Info {
  symbol?: string
  decimals?: number
  name?: string
}
interface Call {
  target: string
  callData: string
}


export async function getTokenInfos(tokenAddresses: string[], multicall: Contract, provider: JsonRpcProvider): Promise<Map<string, Erc20Info>> {
  const tokenInfos = new Map<string, Erc20Info>();

  if (tokenAddresses.length === 0) {
    return tokenInfos
  }

  const erc20Contract = new Contract(tokenAddresses[0], ERC20_ABI, provider)

  const { symbolCalls, nameCalls, decimalsCalls } = tokenAddresses.reduce<{ symbolCalls: Call[], nameCalls: Call[], decimalsCalls: Call[] }>((acc, address) => { // .slice(0, 2)

    acc.symbolCalls.push({
      target: address,
      callData: erc20Contract.interface.encodeFunctionData('symbol')
    })
    acc.nameCalls.push({
      target: address,
      callData: erc20Contract.interface.encodeFunctionData('name')
    })
    acc.decimalsCalls.push({
      target: address,
      callData: erc20Contract.interface.encodeFunctionData('decimals')
    })

    return acc
  }, {
    symbolCalls: [],
    nameCalls: [],
    decimalsCalls: []
  });


  // Make 3 multicalls, one for symbols, one for names and one for decimals
  const [symbolsResult, namesResult, decimalsResults] = await Promise.all([
    multicall.callStatic.tryAggregate(false, symbolCalls),
    multicall.callStatic.tryAggregate(false, nameCalls),
    multicall.callStatic.tryAggregate(false, decimalsCalls)
  ]) as [ReturnCall[], ReturnCall[], ReturnCall[]]

  for (let i = 0; i < symbolsResult.length; i++) {
    const address = tokenAddresses[i]

    const { success: successSymbol, returnData: symbolData } = symbolsResult[i];
    const { success: successName, returnData: nameData } = namesResult[i];
    const { success: successDecimals, returnData: decimalsData } = decimalsResults[i];

    const symbol = successSymbol ? erc20Contract.interface.decodeFunctionResult('symbol', symbolData)[0] : undefined
    const name = successName ? erc20Contract.interface.decodeFunctionResult('name', nameData)[0] : undefined
    const decimals = successDecimals ? erc20Contract.interface.decodeFunctionResult('decimals', decimalsData)[0] : undefined


    if (!symbol && !name && !decimals) {
      console.error('Error getting on-chain token info for ', address)
      continue
    }

    const erc20Info: Erc20Info = {
      symbol,
      name,
      decimals,
    }

    tokenInfos.set(tokenAddresses[i].toLowerCase(), erc20Info)
  }
  // throw new Error('Not implemented');

  return tokenInfos
}

/**
 * Merge the information of two tokens, giving precedence to the second token.
 * This function will consider a empty string as a undefined value.
 * 
 * @param token Token with whose data has less precedence
 * @param tokenOverride Token with whose data has more precedence
 * 
 * @returns the merged token information
 */
export function mergeTokens(token: TokenInfo, tokenOverride: TokenInfo): TokenInfo;

export function mergeTokens(token: TokenInfo, tokenOverride: PartialTokenInfo): TokenInfo;

export function mergeTokens(token: TokenInfo, tokenOverride: TokenInfo | PartialTokenInfo): TokenInfo {
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

export function mergeErc20Info(onchainInfo: Erc20Info, tokenOverride: PartialTokenInfo): PartialTokenInfo {
  const { symbol, name, decimals } = onchainInfo

  return {
    ...tokenOverride,
    name: tokenOverride.name || name,
    symbol: tokenOverride.symbol || symbol,
    decimals: tokenOverride.decimals || decimals,

    extensions: tokenOverride.extensions
  }
}

/**
 * Partial token information. It will have at least the address of the token.
 */
export interface PartialTokenInfo extends Partial<Omit<TokenInfo, 'address'>> {
  address: string
}

interface PartialTokenInfoCsv extends Omit<PartialTokenInfo, 'chainId' | 'decimals' | 'extensions'> {
  chainId?: string
  decimals?: string
  extensions?: string
}

/**
 * Reads some partial token information from a csv file.
 * 
 * At least it will have the address of the token, the rest will be optional.
 * 
 * @param csvPath path to the csv file
 * @returns partial information of tokens
 */
export async function readTokensCsv(csvPath: string): Promise<PartialTokenInfo[]> {
  const csvData = await readCsv<PartialTokenInfoCsv>(csvPath)

  return csvData.map((token) => {

    return {
      ...token,
      address: token.address,
      chainId: token.chainId ? parseInt(token.chainId) : undefined,
      decimals: token.decimals ? parseInt(token.decimals) : undefined,
      extensions: token.extensions ? JSON.parse(token.extensions) : undefined,
      logoURI: token.logoURI || undefined,
    }
  })
}

/**
 * Assets if some partial token information is complete (so it can be considered a TokenInfo)
 * @param token to check if its a TokenInfo
 * @returns 
 */
export function isTokenInfo(token: PartialTokenInfo): token is TokenInfo {
  return token.chainId !== undefined &&
    token.address !== undefined &&
    token.symbol !== undefined &&
    token.name !== undefined &&
    token.decimals !== undefined
}