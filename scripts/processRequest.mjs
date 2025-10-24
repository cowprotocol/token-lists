export const NETWORK_CONFIG = {
  MAINNET: { chainId: 1, blockExplorer: 'etherscan.io' },
  ARBITRUM_ONE: { chainId: 42161, blockExplorer: 'arbiscan.io' },
  BASE: { chainId: 8453, blockExplorer: 'basescan.org' },
  AVALANCHE: { chainId: 43114, blockExplorer: 'snowscan.xyz' },
  POLYGON: { chainId: 137, blockExplorer: 'polygonscan.com' },
  BNB: { chainId: 56, blockExplorer: 'bscscan.com' },
  LENS: { chainId: 232, blockExplorer: 'explorer.lens.xyz' },
  GNOSIS: { chainId: 100, blockExplorer: 'gnosisscan.io' },
  LINEA: { chainId: 59144, blockExplorer: 'lineascan.build' },
  PLASMA: { chainId: 9745, blockExplorer: 'plasmascan.to' },
}

export const VALIDATION_RULES = {
  addImage: ['network', 'url', 'address'],
  addToken: ['network', 'symbol', 'name', 'url', 'decimals', 'address', 'reason'],
  removeToken: ['network', 'reason', 'address'],
}

export const extractFieldValues = (body, fieldNames) => {
  return fieldNames.reduce((acc, f) => {
    // Create a regex for each field, with capturing group with the same name
    const r = new RegExp(String.raw`${f}\s+(.*?)(\s+###|$)`, 'si')

    // Build an object with the capturing group and value for each field
    return { ...acc, [f.toLowerCase()]: body.match(r)?.[1].trim() }
  }, {})
}

export const applyNetworkConfig = (values) => {
  console.log(values)
  const config = NETWORK_CONFIG[values.network]

  if (!config) {
    throw new Error('No valid network found.')
  }

  Object.assign(values, config)
}

export const generateImageUrls = (values) => {
  const { chainId, address } = values
  if (chainId && address) {
    values.prImageUrl = `https://raw.githubusercontent.com/cowprotocol/token-lists/{0}/${chainId}_${address}/src/public/images/${chainId}/${address}/logo.png`
    values.logoURI = `https://raw.githubusercontent.com/cowprotocol/token-lists/main/src/public/images/${chainId}/${address}/logo.png`
  }
}

export const getOperation = (labels) => {
  const operation = labels.find((label) => Object.keys(VALIDATION_RULES).includes(label))
  if (!operation) {
    throw new Error('No valid operation label found')
  }
  return operation
}

export const validateFields = (operation, values) => {
  const requiredFields = VALIDATION_RULES[operation]
  const missingFields = requiredFields.filter((field) => !values[field])
  if (missingFields.length > 0) {
    throw new Error(`Missing required fields for ${operation}: ${missingFields.join(', ')}`)
  }

  if (values.symbol?.includes(' ')) {
    throw new Error('Symbol cannot contain spaces')
  }
}

export const processRequest = (context, core) => {
  const { issue } = context.payload
  const body = issue.body
  const labels = issue.labels.map((label) => label.name)
  const fieldNames = process.env.FIELD_NAMES.split(',')

  const values = extractFieldValues(body, fieldNames)
  values.address &&= values.address.toLowerCase()

  applyNetworkConfig(values)
  generateImageUrls(values)

  const operation = getOperation(labels)
  validateFields(operation, values)

  core.setOutput('operation', operation)
  core.setOutput('issueInfo', JSON.stringify(values))
  core.setOutput('needsImageOptimization', ['addImage', 'addToken'].includes(operation))
}
