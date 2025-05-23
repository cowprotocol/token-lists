import path from 'path'
import { argv, chdir } from 'node:process'

import { SupportedChainId } from '@cowprotocol/cow-sdk'
import { fetchPermitInfo } from './fetchPermitInfo'
import { getLogger, removeOldLogs } from 'scripts/auxLists/utils'

async function fetchAllPermitInfo() {
  const [, scriptPath] = argv

  chdir(path.dirname(scriptPath))

  removeOldLogs('fetch-permit')

  const logger = getLogger('fetch-permit')

  for (const chainId in SupportedChainId) {
    if (!isNaN(Number(chainId))) {
      try {
        await fetchPermitInfo({
          chainId: +chainId as SupportedChainId,
          tokenListPath: undefined,
          rpcUrl: undefined,
          recheckUnsupported: false,
          forceRecheck: false,
        })
      } catch (error) {
        logger.error(`Error fetching permit info for chain ${chainId}:`, error)
      }
    }
  }
}

fetchAllPermitInfo()
