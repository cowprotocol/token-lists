import { generateRwaSupplement } from './rwaSupplement'

generateRwaSupplement().catch((error) => {
  console.error('Error generating the RWA supplement:', error)
  process.exit(1)
})
