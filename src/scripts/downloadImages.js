import cowSwapList from '../public/CowSwap.json' assert { type: 'json' }
import { createWriteStream, existsSync, mkdirSync } from 'fs'
import { Readable } from 'stream'
import path, { dirname } from 'path'
import { fileURLToPath } from 'url'

async function ensureDirectoryExists(filePath) {
  const dir = path.dirname(filePath)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

async function downloadImage(logoURI, filePath) {
  // Skip if file already exists
  if (existsSync(filePath)) {
    return { skipped: true }
  }

  const response = await fetch(logoURI)
  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`)
  }

  await ensureDirectoryExists(filePath)
  const fileStream = createWriteStream(filePath)

  return new Promise((resolve, reject) => {
    // Convert Web ReadableStream to Node.js stream
    const nodeReadable = Readable.fromWeb(response.body)
    nodeReadable.pipe(fileStream)

    fileStream.on('finish', () => {
      resolve({ downloaded: true })
    })
    fileStream.on('error', (error) => {
      reject(error)
    })
  })
}

async function main() {
  const scriptDir = dirname(fileURLToPath(import.meta.url))
  const projectRoot = path.join(scriptDir, '..')

  let downloaded = 0
  let skipped = 0
  let failed = []

  for (const token of cowSwapList.tokens) {
    const { symbol, name, address, chainId, logoURI } = token
    const filePath = path.join(projectRoot, 'public', 'images', chainId.toString(), `${address}.png`)

    console.log(`Downloading image for ${symbol} (${name})
      URI: ${logoURI}
      File: ${filePath}\n`)

    try {
      const result = await downloadImage(logoURI, filePath)

      if (result.skipped) {
        console.log(`Skipped ${symbol} - file already exists`)
        skipped++
      } else if (result.downloaded) {
        console.log(`Successfully downloaded ${symbol} image`)
        downloaded++
      }
    } catch (error) {
      console.error(`Error downloading image for ${symbol} (${name}): ${error.message}`)
      failed.push({ symbol, name, error: error.message })
    }
  }

  console.log(`\nSummary:`)
  console.log(`- Downloaded: ${downloaded}`)
  console.log(`- Skipped (already exist): ${skipped}`)
  console.log(`- Failed: ${failed.length}`)
  if (failed.length > 0) {
    console.log(`- Failed tokens:`)
    failed.forEach((f) => {
      console.log(`  - ${f.symbol} (${f.name}): ${f.error}`)
    })
  }
  console.log(`- Total processed: ${downloaded + skipped + failed}`)
}

main().catch(console.error)
