import path from 'path'
import fs from 'fs'
import type { TokenList } from '@uniswap/token-lists'
import pThrottle from 'p-throttle'
import { SRC_DIR } from '../tokenListUtils'
import { fetchJson } from '../utils/fetchJson'
import {
  buildWarnings,
  chunk,
  collectMints,
  findUnansweredMints,
  isUnchanged,
  serializeWarningsFile,
  type ShieldResponse,
  type TokenWarningsFile,
} from './warnings'

/**
 * Builds `TokenWarnings.1000000001.json`: the risk warnings Jupiter's Shield
 * reports for every mint on our Solana lists, under the short codes in `WARNING_CODES`.
 *
 * It is a sidecar rather than `extensions` on the lists themselves for three
 * reasons: warning types such as `1%_TRANSFER_FEES` are not legal token-list
 * extension keys (`^[\w]+$`), extension values cannot be arrays, and warnings
 * move often enough that folding them in would bump the list version — and so
 * re-download the whole list — on most runs.
 *
 * Messages are hoisted into a shared dictionary: the same sentence applies to
 * hundreds of mints, and repeating it per token would multiply the file size
 * for no added information.
 */

const SOLANA_CHAIN_ID = 1000000001
const SOURCE_LISTS = ['CowSwap.1000000001.json', 'Rwa.1000000001.json']
const OUTPUT_FILE = 'TokenWarnings.1000000001.json'
const SHIELD_URL = 'https://lite-api.jup.ag/ultra/v1/shield'

// Shield truncates silently above 30 mints: ask for 40 and it answers for the
// first 30, with no error and nothing in the body to say the rest were dropped.
// A dropped mint is indistinguishable from a clean one, so `fetchShield` also
// checks the response covers everything it asked for — the cap is Jupiter's to
// change, and the next time they lower it this must fail rather than under-report.
const MINTS_PER_REQUEST = 30

// The free Shield tier starts answering 429 well before a list this size is
// covered, so the run is paced and backs off for far longer than a single
// fetch would: it is a nightly job, and finishing slowly beats not finishing.
const REQUEST_INTERVAL_MS = 2_000
const SHIELD_RETRIES = 6
const SHIELD_RETRY_BASE_MS = 5_000

// Refuse to publish when the set of flagged mints collapses — that reads as an
// upstream outage, and a warnings file that lost its warnings is worse than a
// stale one. Set ALLOW_WARNINGS_SHRINK to override for a one-off run.
const MAX_SHRINK_RATIO = 0.3

function readList(fileName: string): TokenList {
  const filePath = path.join(SRC_DIR, fileName)

  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing source list ${filePath}. Run \`yarn solana\` first.`)
  }

  return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as TokenList
}

function readCurrent(): TokenWarningsFile | null {
  const filePath = path.join(SRC_DIR, OUTPUT_FILE)

  if (!fs.existsSync(filePath)) {
    return null
  }

  return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as TokenWarningsFile
}

function assertNoMassiveShrink(next: Record<string, string[]>, current: TokenWarningsFile | null): void {
  const previousCount = Object.keys(current?.warnings ?? {}).length
  if (previousCount === 0) return

  const nextCount = Object.keys(next).length
  const shrinkRatio = 1 - nextCount / previousCount
  if (shrinkRatio <= MAX_SHRINK_RATIO) return

  const percentage = Math.round(shrinkRatio * 100)
  if (process.env.ALLOW_WARNINGS_SHRINK) {
    console.warn(`${OUTPUT_FILE} shrank by ${percentage}% — writing anyway because ALLOW_WARNINGS_SHRINK is set`)
    return
  }

  throw new Error(
    `Refusing to write ${OUTPUT_FILE}: flagged mints dropped from ${previousCount} to ${nextCount} (-${percentage}%). ` +
      `Check whether Shield changed under us, then re-run with ALLOW_WARNINGS_SHRINK=1 if the drop is expected.`,
  )
}

async function fetchShield(mints: string[]): Promise<ShieldResponse> {
  const json = await fetchJson(`${SHIELD_URL}?mints=${mints.join(',')}`, {
    retries: SHIELD_RETRIES,
    minTimeout: SHIELD_RETRY_BASE_MS,
  })
  const { warnings } = (json ?? {}) as Partial<ShieldResponse>

  if (!warnings || typeof warnings !== 'object') {
    throw new Error('Unexpected Shield response shape: expected a `warnings` object')
  }

  const unanswered = findUnansweredMints(mints, { warnings })

  if (unanswered.length > 0) {
    throw new Error(
      `Shield answered for ${Object.keys(warnings).length} of ${mints.length} mints and dropped ` +
        `${unanswered.length} without an error (first: ${unanswered[0]}). Lower MINTS_PER_REQUEST.`,
    )
  }

  return { warnings }
}

async function main(): Promise<void> {
  const mints = collectMints(SOURCE_LISTS.map(readList))
  const batches = chunk(mints, MINTS_PER_REQUEST)
  console.log(`Checking ${mints.length} mints against Shield in ${batches.length} batches`)

  const throttle = pThrottle({ limit: 1, interval: REQUEST_INTERVAL_MS })
  const fetchBatch = throttle(fetchShield)

  // A batch that exhausts its retries aborts the run: publishing the remainder
  // would mark every mint in the lost batch as clean when it is not.
  const responses = await Promise.all(batches.map((batch) => fetchBatch(batch)))

  const next = buildWarnings(responses)
  const current = readCurrent()

  assertNoMassiveShrink(next.warnings, current)

  const file: TokenWarningsFile = {
    timestamp: isUnchanged(next, current) && current ? current.timestamp : new Date().toISOString(),
    chainId: SOLANA_CHAIN_ID,
    ...next,
  }

  fs.writeFileSync(path.join(SRC_DIR, OUTPUT_FILE), serializeWarningsFile(file))
  console.log(
    `Wrote ${Object.keys(next.warnings).length} flagged mints ` +
      `(${Object.keys(next.types).length} warning types) to ${OUTPUT_FILE}`,
  )
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
