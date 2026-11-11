import path from 'path'
import fs from 'fs'
import type { TokenList } from '@uniswap/token-lists'
import pThrottle from 'p-throttle'
import { SRC_DIR } from '../tokenListUtils.js'
import { fetchJson } from '../utils/fetchJson.js'
import { assertNoMassiveShrink } from '../utils/shrinkGuard.js'
import {
  buildWarnings,
  chunk,
  collectMints,
  findUnansweredMints,
  isUnchanged,
  type ShieldResponse,
  type TokenWarningsFile,
} from './warnings.js'

/**
 * Fetch Jupiter Shield warnings for today's default and RWA membership.
 * Keep warnings separate from token metadata and store each message once.
 */

const SOLANA_CHAIN_ID = 1000000001
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

function readCurrent(): TokenWarningsFile | null {
  const filePath = path.join(SRC_DIR, OUTPUT_FILE)

  if (!fs.existsSync(filePath)) {
    return null
  }

  return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as TokenWarningsFile
}

async function fetchShield(mints: string[]): Promise<ShieldResponse> {
  const json = await fetchJson(`${SHIELD_URL}?mints=${mints.join(',')}`, {
    retries: SHIELD_RETRIES,
    minTimeout: SHIELD_RETRY_BASE_MS,
  })
  const { warnings } = (json ?? {}) as Partial<ShieldResponse>

  if (!warnings || typeof warnings !== 'object' || Array.isArray(warnings)) {
    throw new Error('Unexpected Shield response shape: expected a `warnings` object')
  }
  for (const [mint, entries] of Object.entries(warnings)) {
    if (
      !mints.includes(mint) ||
      !Array.isArray(entries) ||
      entries.some(
        (entry) =>
          !entry ||
          typeof entry.type !== 'string' ||
          typeof entry.message !== 'string' ||
          typeof entry.severity !== 'string',
      )
    ) {
      throw new Error('Invalid Shield mint or warning fields')
    }
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

export async function generateSolanaWarnings(lists: TokenList[]): Promise<TokenWarningsFile> {
  const current = readCurrent()
  const mints = collectMints(lists)
  const batches = chunk(mints, MINTS_PER_REQUEST)
  console.log(`Checking ${mints.length} mints against Shield in ${batches.length} batches`)

  const throttle = pThrottle({ limit: 1, interval: REQUEST_INTERVAL_MS })
  const fetchBatch = throttle(fetchShield)

  // A batch that exhausts its retries aborts the run: publishing the remainder
  // would mark every mint in the lost batch as clean when it is not.
  const responses = await Promise.all(batches.map((batch) => fetchBatch(batch)))

  const next = buildWarnings(responses)

  assertNoMassiveShrink({
    file: OUTPUT_FILE,
    unit: 'flagged mints',
    previousCount: Object.keys(current?.warnings ?? {}).length,
    nextCount: Object.keys(next.warnings).length,
    override: 'ALLOW_WARNINGS_SHRINK',
  })

  return {
    timestamp: isUnchanged(next, current) && current ? current.timestamp : new Date().toISOString(),
    chainId: SOLANA_CHAIN_ID,
    ...next,
  }
}
