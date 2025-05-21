import path from 'path'
import { argv, chdir } from 'node:process'

import { SupportedChainId } from '@cowprotocol/cow-sdk'
import { fetchPermitInfo } from './fetchPermitInfo'

async function fetchAllPermitInfo() {
  const [, scriptPath] = argv

  chdir(path.dirname(scriptPath))

  for (const chainId in SupportedChainId) {
    if (!isNaN(Number(chainId))) {
      await fetchPermitInfo({
        chainId: chainId as unknown as SupportedChainId,
        tokenListPath: undefined,
        rpcUrl: undefined,
        recheckUnsupported: false,
        forceRecheck: false,
      })
    }
  }
}

fetchAllPermitInfo()
