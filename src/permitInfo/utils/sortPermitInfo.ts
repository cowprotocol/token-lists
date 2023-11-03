import { PermitInfo } from '@cowprotocol/permit-utils'

export function sortPermitInfo(allPermitInfo: Record<string, PermitInfo>): Record<string, PermitInfo> {
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
