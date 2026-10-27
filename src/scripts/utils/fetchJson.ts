import pRetry, { AbortError } from 'p-retry'

const REQUEST_TIMEOUT_MS = 15_000
const MAX_RETRIES = 3

// Spelled out rather than left to p-retry: passing `minTimeout: undefined` does not fall back to
// its default, it overwrites it, and `Math.max(undefined, 1)` makes every backoff NaN — which
// setTimeout reads as 0, so the retries fire instantly and the rate limit is never waited out.
const DEFAULT_RETRY_BASE_MS = 1_000

export interface FetchJsonOptions {
  retries?: number
  /** First backoff delay in ms; p-retry doubles it on each further attempt. */
  minTimeout?: number
}

export async function fetchJson(url: string, options: FetchJsonOptions = {}): Promise<unknown> {
  return pRetry(
    async () => {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      if (!res.ok) {
        const body = await res.text()
        // 429 (rate limit) is transient — let p-retry back off and retry.
        // Other 4xx are client errors (bad query, removed endpoint) — abort.
        if (res.status >= 400 && res.status < 500 && res.status !== 429) {
          throw new AbortError(`Request to ${url} failed: ${res.status} ${body}`)
        }
        throw new Error(`Request to ${url} failed: ${res.status} ${body}`)
      }
      return res.json()
    },
    {
      retries: options.retries ?? MAX_RETRIES,
      minTimeout: options.minTimeout ?? DEFAULT_RETRY_BASE_MS,
      onFailedAttempt: (err) => {
        console.warn(`${url} attempt ${err.attemptNumber} failed (${err.retriesLeft} retries left): ${err.message}`)
      },
    },
  )
}
