import { isSupportedPermitInfo, PermitInfo } from '@cowprotocol/permit-utils'

export function sortPermitInfo(allPermitInfo: Record<string, PermitInfo>): Record<string, PermitInfo> {
  // Create a new obj with the keys sorted
  return Object.keys(allPermitInfo)
    .sort((a, b) => {
      const pa = allPermitInfo[a]
      const pb = allPermitInfo[b]

      // If either both or none are supported, sort by key
      if (
        (isSupportedPermitInfo(pa) && isSupportedPermitInfo(pb)) ||
        (!isSupportedPermitInfo(pa) && !isSupportedPermitInfo(pb))
      ) {
        return a > b ? 1 : -1
      }
      // Otherwise, supported tokens go on top
      return isSupportedPermitInfo(pb) ? 1 : -1
    })
    .reduce<{[address: string]: PermitInfo}>((acc, address) => {
      // Create a new object with the keys in the sorted order
      acc[address] = allPermitInfo[address]

      return acc
    }, {})
}
