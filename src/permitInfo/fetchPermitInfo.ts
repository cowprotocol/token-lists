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
 * @arg recheckUnsupported - optional, fourth positional argument
 */

import pThrottle from 'p-throttle'
import pRetry from 'p-retry'
import {
  getTokenPermitInfo,
  GetTokenPermitIntoResult,
  isSupportedPermitInfo,
  PermitInfo,
} from '@cowprotocol/permit-utils'
import * as path from 'node:path'
import { readFileSync, writeFileSync } from 'node:fs'
import { JsonRpcProvider } from '@ethersproject/providers'
import { argv, chdir, exit } from 'node:process'
import { BASE_PATH, SPENDER_ADDRESS } from './const.ts'
import { sortPermitInfo } from './utils/sortPermitInfo.ts'
import { getProvider } from './utils/getProvider.ts'
import { Token } from './types.ts'
import { getTokensFromTokenList } from './utils/getTokensFromTokenList.ts'
import { getUnsupportedTokensFromPermitInfo } from './utils/getUnsupportedTokensFromPermitInfo.ts'

// TODO: maybe make the args nicer?
// Get args from cli: chainId, optional token lists path, optional rpcUrl, optional recheckUnsupported flag
const [, scriptPath, chainId, tokenListPath, rpcUrl, recheckUnsupported, forceRecheck] = argv

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
  recheckUnsupported: boolean = false,
  forceRecheck: boolean = false,
): Promise<void> {
  // Load existing permitInfo.json file for given chainId
  const permitInfoPath = path.join(BASE_PATH, `PermitInfo.${chainId}.json`)

  let allPermitInfo: Record<string, PermitInfo> = {}

  // Load existing permitInfo.json file for given chainId if it exists
  try {
    allPermitInfo = JSON.parse(readFileSync(permitInfoPath, 'utf8')) as Record<string, PermitInfo>
  } catch (_) {
    // File doesn't exist. It'll be created later on.
    if (recheckUnsupported || forceRecheck) {
      console.error('recheck option set without existing permitInfo. There is nothing to recheck')
      exit(1)
    }
  }

  // Build provider instance
  const provider = getProvider(chainId, rpcUrl)

  // Load tokens info from a token list
  const tokens = recheckUnsupported
    ? getUnsupportedTokensFromPermitInfo(chainId, allPermitInfo)
    : getTokensFromTokenList(chainId, tokenListPath)

  // Create a list of promises to check all tokens
  const fetchAllPermits = tokens.map((token) => {
    const existingInfo = allPermitInfo[token.address.toLowerCase()]

    return pRetry(
      async () => _fetchPermitInfo(chainId, provider, token, existingInfo, recheckUnsupported, forceRecheck),
      {
        retries: 3,
      },
    )
  })

  // Await for all of them to complete
  const fetchedPermits = await Promise.allSettled(fetchAllPermits)

  // Iterate over each result
  fetchedPermits.forEach((result) => {
    if (result.status === 'fulfilled' && result.value) {
      const [address, permitInfo] = result.value

      // Store result
      allPermitInfo[address] = permitInfo
    } else if (result.status === 'rejected') {
      console.log(`[fetchedPermits] Failed to fetch info:`, result.reason)
    }
  })

  try {
    writeFileSync(permitInfoPath, JSON.stringify(sortPermitInfo(allPermitInfo), undefined, 2))
  } catch (e) {
    console.error(`Failed to write file ${permitInfoPath}`, e)
  }
}

// Fn can only be called 2x/second
const throttle = pThrottle({
  limit: 2,
  interval: 1000,
})

const throttledGetTokenPermitInfo = throttle(getTokenPermitInfo)

async function _fetchPermitInfo(
  chainId: number,
  provider: JsonRpcProvider,
  token: Token,
  existing: PermitInfo | undefined,
  recheckUnsupported: boolean,
  forceRecheck: boolean,
): Promise<undefined | [string, PermitInfo]> {
  const tokenId = token.symbol || token.name || token.address

  if (token.chainId !== chainId) {
    console.info(`Token ${tokenId}: belongs to a different network (${token.chainId}), skipping`)
  } else if (!forceRecheck && (isSupportedPermitInfo(existing) || (existing && !recheckUnsupported))) {
    console.info(`Token ${tokenId}: already known, skipping`, existing)
  } else {
    const response: GetTokenPermitIntoResult = await throttledGetTokenPermitInfo({
      chainId,
      provider,
      spender: SPENDER_ADDRESS,
      tokenAddress: token.address,
      tokenName: token.name,
    })

    if ('error' in response) {
      if (/ETIMEDOUT|RPC connection error/.test(response.error)) {
        // Throw, so it can be retried on connection errors
        throw new Error(response.error)
      }
      // Non connection related error, stop it here
      console.info(`Non-retryable failure for token ${tokenId}:`, response)
    } else {
      console.info(`Token ${tokenId}:`, response)
      return [token.address.toLowerCase(), response]
    }
  }
}

// Execute the script
fetchPermitInfo(+chainId, tokenListPath, rpcUrl, !!recheckUnsupported, !!forceRecheck).then(() =>
  console.info(`Done 🏁`),
)
