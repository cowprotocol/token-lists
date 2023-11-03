/**
 * Fetch permit info for given network
 *
 * ChainId is the required first cli argument
 *
 * TokenListPath is the optional second cli argument
 * By default, checks against the respective default token list
 * - `src/public/CowSwap.json` for mainnet and gnosis chain
 * - `src/public/CowSwapGoerli.json` for goerli
 *
 * RpcUrl is the optional third cli argument
 * By default, it'll use Infura for mainnet and goerli.
 * In that case, `INFURA_API_KEY` env var must be set.
 *
 * Minimal example:
 * $ ts-node fetchPermitInfo 100
 *
 * Minimal example using default INFURA rpc:
 * $ INFURA_API_KEY=0000000...111 ts-node fetchPermitInfo 1
 *
 * With optional params
 * $ ts-node fetchPermitInfo 1 otherTokenList.json https://my.rpc.endpoint
 *
 * @arg chainId - required, first positional argument
 * @arg tokenListPath - optional, second positional argument
 * @arg rpcUrl - optional, third positional argument
 */

import { getTokenPermitInfo, PermitInfo } from '@cowprotocol/permit-utils'
import * as path from 'node:path'
import { readFileSync, writeFileSync } from 'node:fs'
import { JsonRpcProvider } from '@ethersproject/providers'
import { argv, chdir, exit } from 'node:process'
import { BASE_PATH, SPENDER_ADDRESS } from './const.ts'
import { sortPermitInfo } from './utils/sortPermitInfo.ts'
import { getProvider } from './utils/getProvider.ts'
import { Token } from './types.ts'
import { getTokens } from './utils/getTokens.ts'

// TODO: maybe make the args nicer?
// Get args from cli: chainId, optional token lists path, optional rpcUrl
const [, scriptPath, chainId, tokenListPath, rpcUrl] = argv

if (!chainId) {
  console.error('ChainId is missing. Invoke the script with the chainId as the first parameter.')
  exit(1)
}

// Change to script dir so relative paths work properly
chdir(path.dirname(scriptPath))

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
  } catch (_) {
    // File doesn't exist. It'll be created later on.
  }

  // Build provider instance
  const provider = getProvider(chainId, rpcUrl)

  // Load tokens info from a token list
  const tokens = getTokens(chainId, tokenListPath)

  // Create a list of promises to check all tokens
  const fetchAllPermits = tokens.map((token) => {
    const existingInfo = allPermitInfo[token.address.toLowerCase()]

    return _fetchPermitInfo(chainId, provider, token, existingInfo)
  })

  // Await for all of them to complete
  const fetchedPermits = await Promise.allSettled(fetchAllPermits)

  // Iterate over each result
  fetchedPermits.forEach((result) => {
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
        spender: SPENDER_ADDRESS,
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

// Execute the script
fetchPermitInfo(+chainId, tokenListPath, rpcUrl).then(() => console.info(`Done 🏁`))
