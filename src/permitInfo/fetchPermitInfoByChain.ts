import path from 'path'
import { argv, chdir, exit } from 'node:process'

import { SupportedChainId } from '@cowprotocol/cow-sdk'
import { fetchPermitInfo } from './fetchPermitInfo'

function fetchPermitInfoByChain() {
  const [, scriptPath, chainId, tokenListPath, rpcUrl, recheckUnsupported, forceRecheck, token] = argv

  if (!chainId) {
    console.error('ChainId is missing. Invoke the script with the chainId as the first parameter.')
    exit(1)
  }

  // Change to script dir so relative paths work properly
  chdir(path.dirname(scriptPath))

  // Execute the script
  fetchPermitInfo({
    chainId: +chainId as SupportedChainId,
    tokenListPath,
    rpcUrl,
    recheckUnsupported: recheckUnsupported === 'true',
    forceRecheck: forceRecheck === 'true',
    token: token,
  }).then(() => console.info(`Done 🏁`))
}

fetchPermitInfoByChain()
