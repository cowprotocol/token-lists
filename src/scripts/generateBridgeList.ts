import { SupportedChainId } from '@cowprotocol/cow-sdk'
import { Contract, ContractInterface } from '@ethersproject/contracts'
import type { TokenInfo, TokenList } from '@uniswap/token-lists'
import { ARBITRUM_BRIDGE_ABI } from '../abi/abitrumBridgeAbi'
import { ERC20_ABI } from '../abi/erc20'
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

  const fetchBridgedAddressesCalls = tokensList.tokens.reduce<{ token: TokenInfo; call: Call }[]>((acc, token) => {
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

  const bridgedAddresses: { token: TokenInfo; address: string }[] = await multicall.callStatic
    .tryAggregate(
      false,
      fetchBridgedAddressesCalls.map(({ call }) => call),
    )
    .then((results) =>
      results.reduce((acc: { token: TokenInfo; address: string }[], res: any, index: number) => {
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
      }, []),
    )

  const tokens: TokenInfo[] = await multicall.callStatic
    .tryAggregate(
      false,
      bridgedAddresses.map(({ address: target }) => {
        const erc20Contract = new Contract(target, ERC20_ABI, provider)

        // `totalSupply` is a required ERC20 method
        return { target, callData: erc20Contract.interface.encodeFunctionData('totalSupply') }
      }),
    )
    .then((results) =>
      results.reduce((acc: TokenInfo[], res: any, index: number) => {
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
      }, []),
    )

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
