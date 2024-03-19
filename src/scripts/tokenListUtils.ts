import path from 'path'
import fs from 'fs'
import type { TokenList } from '@uniswap/token-lists'

export const BUILD_DIR = path.join('.', 'build')
const LIST_DIR = path.join(BUILD_DIR, 'lists')

function ensureListsBuildDir() {
  const dirs = [BUILD_DIR, LIST_DIR]

  for (let dir of dirs) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir);
    }
  }
}

function getTokenListsBuildPath(outputPath: string): string {
  return path.join(LIST_DIR, outputPath)
}

export function writeTokenListToBuild(outputPath: string, tokenList: TokenList) {
  const filePath = getTokenListsBuildPath(outputPath)

  ensureListsBuildDir()

  fs.writeFileSync(filePath, JSON.stringify(tokenList, null, 2))
}
