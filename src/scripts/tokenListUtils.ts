import path from 'path'
import fs from 'fs'
import type { TokenList } from '@uniswap/token-lists'

export const BUILD_DIR = path.join('.', 'build')
export const SRC_DIR = path.join('.', 'src/public')
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

export const isTruthy = <T>(value: T | null | undefined | false): value is T => !!value

export function writeTokenListToBuild(outputPath: string, tokenList: TokenList) {
  const filePath = getTokenListsBuildPath(outputPath)

  ensureListsBuildDir()

  fs.writeFileSync(filePath, JSON.stringify(tokenList, null, 2))
}

export function writeTokenListToSrc(outputPath: string, tokenList: TokenList) {
  fs.writeFileSync(path.join(SRC_DIR, outputPath), JSON.stringify(tokenList, null, 2))
}
