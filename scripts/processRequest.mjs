import { enrichWithTokenMetrics } from './tokenMetrics.mjs'

export const NETWORK_CONFIG = {
  MAINNET: { chainId: 1, blockExplorer: 'etherscan.io' },
  ARBITRUM_ONE: { chainId: 42161, blockExplorer: 'arbiscan.io' },
  BASE: { chainId: 8453, blockExplorer: 'basescan.org' },
  AVALANCHE: { chainId: 43114, blockExplorer: 'snowscan.xyz' },
  POLYGON: { chainId: 137, blockExplorer: 'polygonscan.com' },
  BNB: { chainId: 56, blockExplorer: 'bscscan.com' },
  GNOSIS_CHAIN: { chainId: 100, blockExplorer: 'gnosisscan.io' },
  PLASMA: { chainId: 9745, blockExplorer: 'plasmascan.to' },
  INK: { chainId: 57073, blockExplorer: 'explorer.inkonchain.com' },
  ROBINHOOD: { chainId: 4663, blockExplorer: 'robin.etherscan.io' },
}

export const VALIDATION_RULES = {
  addImage: ['network', 'url', 'address'],
  addToken: ['network', 'symbol', 'name', 'url', 'decimals', 'address', 'reason'],
  removeToken: ['network', 'reason', 'address'],
}

const ISSUE_FORM_LABELS = {
  symbol: 'token symbol',
  name: 'token name',
  url: 'image url',
}

const GITHUB_ATTACHMENT =
  /^!?\[(?:\\.|[^\]\\\r\n])+\]\((https:\/\/github\.com\/user-attachments\/assets\/[\da-fA-F]{8}-(?:[\da-fA-F]{4}-){3}[\da-fA-F]{12})\)$/

export const extractFieldValues = (body, fieldNames) => {
  const sections = body.split(/^[ \t]*###[ \t]+([^\r\n]+)\r?$/m)
  const valuesByHeading = new Map()
  for (let index = 1; index < sections.length; index += 2) {
    const heading = sections[index].trim().toLowerCase()
    if (!valuesByHeading.has(heading)) {
      valuesByHeading.set(heading, sections[index + 1].trim())
    }
  }

  return Object.fromEntries(
    fieldNames.map((fieldName) => {
      const field = fieldName.toLowerCase()
      const value = valuesByHeading.get(ISSUE_FORM_LABELS[field]) ?? valuesByHeading.get(field)
      return [field, value]
    }),
  )
}

const resolveImageUrl = (url, upload) => {
  if (!upload || upload === '_No response_') {
    return url === '_No response_' ? undefined : url
  }

  const attachmentUrl = upload.match(GITHUB_ATTACHMENT)?.[1]
  if (!attachmentUrl) {
    throw new Error('Logo upload must contain one file attached in the Logo upload field.')
  }

  return attachmentUrl
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
    values.logoURI = `https://files.cow.fi/token-lists/images/${chainId}/${address}/logo.png`
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
  const missingFields = requiredFields
    .filter((field) => !values[field])
    .map((field) => (field === 'url' ? 'Logo upload or Image URL' : field))
  if (missingFields.length > 0) {
    throw new Error(`Missing required fields for ${operation}: ${missingFields.join(', ')}`)
  }

  if (values.symbol?.includes(' ')) {
    throw new Error('Symbol cannot contain spaces')
  }
}

export const processRequest = async (context, core) => {
  const { issue } = context.payload
  const body = issue.body
  const labels = issue.labels.map((label) => label.name)
  const fieldNames = process.env.FIELD_NAMES.split(',')

  const { 'logo upload': logoUpload, ...values } = extractFieldValues(body, fieldNames)
  values.address &&= values.address.toLowerCase()

  applyNetworkConfig(values)
  generateImageUrls(values)

  const operation = getOperation(labels)
  const needsImageOptimization = ['addImage', 'addToken'].includes(operation)
  if (needsImageOptimization) {
    values.url = resolveImageUrl(values.url, logoUpload)
  }
  validateFields(operation, values)

  // Enrich addToken PRs with token metrics (liquidity/volume + holders).
  // Never throws / never blocks.
  const result = operation === 'addToken' ? await enrichWithTokenMetrics(values) : values

  core.setOutput('operation', operation)
  core.setOutput('issueInfo', JSON.stringify(result))
  core.setOutput('needsImageOptimization', needsImageOptimization)
}
