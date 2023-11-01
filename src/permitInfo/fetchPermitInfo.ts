import {getTokenPermitInfo, PermitInfo} from '@cowprotocol/permit-utils'
import * as path from 'node:path'
import {ethers} from 'ethers'
import {readFileSync, writeFileSync} from 'node:fs'
import {JsonRpcProvider} from '@ethersproject/providers'
import {argv, chdir, env, exit} from 'node:process'

// TODO: maybe make the args nicer?
// Get args from cli: chainId, optional token lists path, optional rpcUrl
const [, scriptPath, chainId, tokenListPath, rpcUrl] = argv

if (!chainId) {
  console.error('ChainId is missing. Invoke the script with the chainId as the first parameter.')
  exit(1)
}

// Change to script dir so relative paths work properly
chdir(path.dirname(scriptPath))

const BASE_PATH = path.join('../public/')

async function fetchPermitInfo(
  chainId: number,
  tokenListPath: string | undefined,
  rpcUrl: string | undefined,
): Promise<void> {
  // Load existing permitInfo.json file for given chainId
  const permitInfoPath = path.join(BASE_PATH, `PermitInfo.${chainId}.json`)

  let allPermitInfo: Record<string, PermitInfo> = {}

  // Load existing permitInfo.json file for given chainId if it exists
  try {
    allPermitInfo = JSON.parse(readFileSync(permitInfoPath, 'utf8')) as Record<string, PermitInfo>
  } catch (e) {
    console.info(`File ${permitInfoPath} not found. It'll be created.`, e)
  }

  // Build provider instance
  const provider = getProvider(chainId, rpcUrl)

  // Load tokens info from a token list
  const tokens = getTokens(chainId, tokenListPath)

  // Create a list of promises to check all tokens
  const promises = tokens.map((token) => {
    const existingInfo = allPermitInfo[token.address.toLowerCase()]

    return _fetchPermitInfo(chainId, provider, token, existingInfo)
  })

  // Await for all of them to complete
  const results = await Promise.allSettled(promises)

  // Iterate over each result
  results.forEach((result) => {
    // Ignore failed or the ones where the value is falsy
    if (result.status === 'fulfilled' && result.value) {
      const [address, permitInfo] = result.value

      // Store result
      allPermitInfo[address] = permitInfo
    }
  })

  try {
    writeFileSync(permitInfoPath, JSON.stringify(sortPermitInfo(allPermitInfo), undefined, 2))
  } catch (e) {
    console.error(`Failed to write file ${permitInfoPath}`, e)
  }
}

function getProvider(chainId: number, rpcUrl: string | undefined): JsonRpcProvider {
  const rpcEndpoint = rpcUrl ? rpcUrl : DEFAULT_RPC_URLS[chainId]

  if (!rpcEndpoint) {
    throw new Error(`No RPC found for network ${chainId}`)
  }

  if (!rpcUrl && (chainId === 1 || chainId === 5) && !env.INFURA_API_KEY) {
    throw new Error(`INFURA_API_KEY is required`)
  }

  return new ethers.providers.JsonRpcProvider(rpcEndpoint)
}

const DEFAULT_RPC_URLS: Record<number, string> = {
  1: 'https://mainnet.infura.io/v3/' + env.INFURA_API_KEY,
  5: 'https://goerli.infura.io/v3/' + env.INFURA_API_KEY,
  100: 'https://rpc.gnosischain.com',
}

type Token = {
  address: string
  name: string
  chainId: number
  symbol: string
}

function getTokens(chainId: number, tokenListPath: string | undefined): Array<Token> {
  const filePath = tokenListPath
    ? tokenListPath
    : path.join(BASE_PATH, chainId === 5 ? 'CowSwapGoerli.json' : 'CowSwap.json')

  return JSON.parse(readFileSync(filePath, 'utf-8')).tokens
}

async function _fetchPermitInfo(
  chainId: number,
  provider: JsonRpcProvider,
  token: Token,
  existing: PermitInfo | undefined,
): Promise<undefined | [string, PermitInfo]> {
  if (existing !== undefined) {
    console.info(`Token ${token.symbol}: already known, skipping`, existing)
  } else if (token.chainId !== chainId) {
    console.info(`Token ${token.symbol}: belongs to a different network (${token.chainId}), skipping`)
  } else {
    try {
      const response = await getTokenPermitInfo({
        chainId,
        provider,
        spender: '0xC92E8bdf79f0507f65a392b0ab4667716BFE0110',
        tokenAddress: token.address,
        tokenName: token.name,
      })
      console.info(`Token ${token.symbol}:`, response)

      // Ignore error responses
      if (!(typeof response === 'object' && 'error' in response)) {
        return [token.address.toLowerCase(), response]
      }
    } catch (e) {
      // Ignore failures
      console.info(`Failed ${token.symbol}:`, e)
    }
  }
}

function sortPermitInfo(allPermitInfo: Record<string, PermitInfo>): Record<string, PermitInfo> {
  // Create a new obj with the keys sorted
  return Object.keys(allPermitInfo)
    .sort((a, b) => {
      const pa = allPermitInfo[a]
      const pb = allPermitInfo[b]

      // If either both or none have permit info, sort by key
      if ((pa && pb) || (!pa && !pb)) {
        return a > b ? 1 : -1
      }
      // Otherwise, tokens with permit info go in top
      return pb ? 1 : -1
    })
    .reduce((acc, address) => {
      // Create a new object with the keys in the sorted order
      acc[address] = allPermitInfo[address]

      return acc
    }, {})
}

// Execute the script
fetchPermitInfo(+chainId, tokenListPath, rpcUrl).then(() => console.info(`Done 🏁`))
