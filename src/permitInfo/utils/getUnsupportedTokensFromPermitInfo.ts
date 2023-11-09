import { isSupportedPermitInfo, PermitInfo } from '@cowprotocol/permit-utils'
import { Token } from '../types.js'

export function getUnsupportedTokensFromPermitInfo(
  chainId: number,
  allPermitInfo: Record<string, PermitInfo>,
): Token[] {
  const tokens = []

  for (const [k, v] of Object.entries(allPermitInfo)) {
    if (!isSupportedPermitInfo(v)) {
      tokens.push({ address: k, name: v?.name, chainId })
    }
  }

  return tokens
}
