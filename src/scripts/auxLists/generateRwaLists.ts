import { fetchAndProcessRwaTokens } from './rwa'
import { removeOldLogs } from './utils'

removeOldLogs('rwa-tokens')

fetchAndProcessRwaTokens().catch((error) => {
  console.error('Error processing RWA tokens:', error)
  process.exit(1)
})
