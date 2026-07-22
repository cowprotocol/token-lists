# CMC DEX Metrics in addToken PRs — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enrich automated `addToken` PR descriptions with CoinMarketCap DEX metrics (liquidity, 24h volume, holders), without ever blocking PR creation.

**Architecture:** A new self-contained module `scripts/cmcMetrics.mjs` scrapes the CMC DEX page (`__NEXT_DATA__` JSON) and exposes `enrichWithCmcMetrics(values)` — an async function that never throws and writes pre-formatted display strings onto the `values` object. `scripts/processRequest.mjs` becomes async and calls it for `addToken` only. The `execute-add-token` job in `processRequest.yml` renders those strings in a markdown table.

**Tech Stack:** Node 20 (global `fetch`, `AbortSignal.timeout`), `node:test` + `node:assert/strict`, GitHub Actions (`actions/github-script`).

## Global Constraints

- **Non-blocking:** `enrichWithCmcMetrics` MUST NOT throw under any circumstance. Enrichment failure must not fail the `extract-info` step or trigger the `failure()` issue-close handler.
- **Scope:** `addToken` only. Do not touch `removeToken` / `addImage` PR bodies.
- **Do not modify** `token-dex-table.mjs` (self-contained dev tool; duplication of scraping logic is accepted).
- **Test runner:** `yarn test` (`node --test`, discovers `*.test.mjs`).
- **Formatting:** metric formatting lives in JS (testable); the YAML template does plain substitution only.
- **Chain map:** only these `NETWORK_CONFIG` keys have CMC slugs — `MAINNET→ethereum`, `ARBITRUM_ONE→arbitrum`, `BASE→base`, `AVALANCHE→avalanche`, `POLYGON→polygon`, `BNB→bnb`, `GNOSIS_CHAIN→gnosis`, `LINEA→linea`. `PLASMA`/`INK` are intentionally unmapped → `n/a`.

## File Structure

- Create: `scripts/cmcMetrics.mjs` — CMC scraping + formatting + `enrichWithCmcMetrics`.
- Create: `scripts/cmcMetrics.test.mjs` — unit tests for the module.
- Modify: `scripts/processRequest.mjs` — make `processRequest` async, call enrichment for `addToken`.
- Modify: `scripts/processRequest.test.mjs` — await async `processRequest`, mock `fetch`.
- Modify: `.github/workflows/processRequest.yml` — `await` the call, add metrics table to add-token `prBody`.

---

### Task 1: `scripts/cmcMetrics.mjs` module + tests

**Files:**
- Create: `scripts/cmcMetrics.mjs`
- Test: `scripts/cmcMetrics.test.mjs`

**Interfaces:**
- Consumes: nothing (leaf module). Reads global `fetch`.
- Produces:
  - `NETWORK_TO_CMC_SLUG: Record<string,string>`
  - `fetchWithRetry(url: string, opts?: {attempts?: number, timeoutMs?: number}): Promise<Response>`
  - `cmcTokenUrl(slug: string, address: string): string`
  - `fetchCmcData({slug, address}): Promise<{liquidity: number|null, volume24h: number|null, holders: number|null}>` (throws on HTTP/parse error)
  - `usd(x: number|null): string` — `'$1,234'` or `'n/a'`
  - `count(x: number|null): string` — `'1,234'` or `'n/a'`
  - `enrichWithCmcMetrics(values): Promise<void>` — never throws; sets `values.cmcLiquidity`, `values.cmcVolume24h`, `values.cmcHolders`, `values.cmcUrl`

- [ ] **Step 1: Write the failing tests**

Create `scripts/cmcMetrics.test.mjs`:

```js
import { describe, it, mock, afterEach } from 'node:test'
import assert from 'node:assert/strict'

import { enrichWithCmcMetrics, usd, count } from './cmcMetrics.mjs'

// Build a minimal CMC DEX page mirroring the __NEXT_DATA__ shape fetchCmcData parses.
const makeHtml = ({ holders, liqUsd, vol24h }) => {
  const data = {
    props: {
      pageProps: {
        holdersCount: holders,
        dehydratedState: {
          queries: [
            {
              queryKey: ['dex-token-info'],
              state: { data: { liqUsd, sts: [{ tp: '24h', vu: vol24h }] } },
            },
          ],
        },
      },
    },
  }
  return `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(
    data,
  )}</script></html>`
}

describe('usd', () => {
  it('formats and handles nullish', () => {
    assert.equal(usd(1234567), '$1,234,567')
    assert.equal(usd(null), 'n/a')
    assert.equal(usd(NaN), 'n/a')
  })
})

describe('count', () => {
  it('formats and handles nullish', () => {
    assert.equal(count(12345), '12,345')
    assert.equal(count(null), 'n/a')
  })
})

describe('enrichWithCmcMetrics', () => {
  const originalFetch = global.fetch
  afterEach(() => {
    global.fetch = originalFetch
  })

  it('populates formatted metrics on success', async () => {
    global.fetch = mock.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => makeHtml({ holders: 12345, liqUsd: 1234567, vol24h: 98765 }),
    }))
    const values = { network: 'MAINNET', address: '0xabc' }
    await enrichWithCmcMetrics(values)
    assert.equal(values.cmcLiquidity, '$1,234,567')
    assert.equal(values.cmcVolume24h, '$98,765')
    assert.equal(values.cmcHolders, '12,345')
    assert.equal(values.cmcUrl, 'https://dex.coinmarketcap.com/token/ethereum/0xabc/')
  })

  it('defaults to n/a and does not throw when fetch rejects', async () => {
    global.fetch = mock.fn(async () => {
      throw new Error('network down')
    })
    const values = { network: 'MAINNET', address: '0xabc' }
    await assert.doesNotReject(enrichWithCmcMetrics(values))
    assert.equal(values.cmcLiquidity, 'n/a')
    assert.equal(values.cmcVolume24h, 'n/a')
    assert.equal(values.cmcHolders, 'n/a')
    // Token URL is still set so the reviewer has a link.
    assert.equal(values.cmcUrl, 'https://dex.coinmarketcap.com/token/ethereum/0xabc/')
  })

  it('defaults to n/a for unmapped chains without fetching', async () => {
    const fetchMock = mock.fn(async () => ({ ok: true, status: 200, text: async () => '' }))
    global.fetch = fetchMock
    const values = { network: 'PLASMA', address: '0xabc' }
    await enrichWithCmcMetrics(values)
    assert.equal(values.cmcLiquidity, 'n/a')
    assert.equal(values.cmcHolders, 'n/a')
    assert.equal(fetchMock.mock.callCount(), 0)
    assert.equal(values.cmcUrl, 'https://dex.coinmarketcap.com')
  })

  it('defaults to n/a on non-ok HTTP response', async () => {
    global.fetch = mock.fn(async () => ({ ok: false, status: 404, text: async () => '' }))
    const values = { network: 'BASE', address: '0xdef' }
    await enrichWithCmcMetrics(values)
    assert.equal(values.cmcHolders, 'n/a')
    assert.equal(values.cmcUrl, 'https://dex.coinmarketcap.com/token/base/0xdef/')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn test scripts/cmcMetrics.test.mjs`
Expected: FAIL — `Cannot find module './cmcMetrics.mjs'` / imports undefined.

- [ ] **Step 3: Write the module**

Create `scripts/cmcMetrics.mjs`:

```js
// Fetch CoinMarketCap DEX metrics (liquidity, 24h volume, holders) for a token
// and format them for inclusion in an automated PR description.
//
// Non-blocking by design: enrichWithCmcMetrics never throws. Any failure
// (unlisted token, unmapped chain, network error, timeout) leaves the metric
// fields at their 'n/a' defaults so PR creation can proceed.

// Map token-lists network identifiers (NETWORK_CONFIG keys) -> CMC DEX chain slug.
export const NETWORK_TO_CMC_SLUG = {
  MAINNET: 'ethereum',
  ARBITRUM_ONE: 'arbitrum',
  BASE: 'base',
  AVALANCHE: 'avalanche',
  POLYGON: 'polygon',
  BNB: 'bnb',
  GNOSIS_CHAIN: 'gnosis',
  LINEA: 'linea',
  // PLASMA, INK: no CMC DEX slug -> treated as "no data".
}

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Fetch a URL with a timeout and short retry/backoff. Tuned for CI. */
export async function fetchWithRetry(url, { attempts = 2, timeoutMs = 10000 } = {}) {
  let lastErr
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA },
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (res.status === 429 || res.status >= 500) {
        throw new Error(`HTTP ${res.status}`)
      }
      return res
    } catch (err) {
      lastErr = err
      if (i < attempts - 1) await sleep(1000 * (i + 1)) // linear backoff
    }
  }
  throw lastErr
}

/** Build the CMC DEX token page URL. */
export function cmcTokenUrl(slug, address) {
  return `https://dex.coinmarketcap.com/token/${slug}/${address}/`
}

/** Fetch the CMC DEX page and extract liquidity/volume/holders from __NEXT_DATA__. */
export async function fetchCmcData({ slug, address }) {
  const url = cmcTokenUrl(slug, address)
  const res = await fetchWithRetry(url)
  if (!res.ok) throw new Error(`CMC returned HTTP ${res.status} for ${url}`)
  const html = await res.text()

  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/)
  if (!m) throw new Error(`No __NEXT_DATA__ found for ${url} (token may be unlisted on CMC DEX)`)

  const pageProps = JSON.parse(m[1])?.props?.pageProps ?? {}
  const holders = pageProps.holdersCount ?? null
  const tokenInfo = (pageProps.dehydratedState?.queries ?? []).find(
    (q) => Array.isArray(q.queryKey) && q.queryKey[0] === 'dex-token-info',
  )?.state?.data

  const liquidity = tokenInfo?.liqUsd != null ? Number(tokenInfo.liqUsd) : null
  const stat24h = (tokenInfo?.sts ?? []).find((s) => s.tp === '24h')
  const volume24h = stat24h?.vu != null ? Number(stat24h.vu) : null

  return { liquidity, volume24h, holders }
}

/** Format a number as compact USD, or 'n/a'. */
export function usd(x) {
  if (x == null || Number.isNaN(x)) return 'n/a'
  return '$' + Math.round(x).toLocaleString('en-US')
}

/** Format a plain integer count, or 'n/a'. */
export function count(x) {
  if (x == null || Number.isNaN(Number(x))) return 'n/a'
  return Number(x).toLocaleString('en-US')
}

/**
 * Enrich `values` with formatted CMC DEX metrics. NEVER throws.
 * Sets: cmcLiquidity, cmcVolume24h, cmcHolders (formatted strings, 'n/a' on miss)
 * and cmcUrl (token page URL, or the DEX homepage when the chain is unmapped).
 */
export async function enrichWithCmcMetrics(values) {
  values.cmcLiquidity = 'n/a'
  values.cmcVolume24h = 'n/a'
  values.cmcHolders = 'n/a'
  values.cmcUrl = 'https://dex.coinmarketcap.com'

  try {
    const slug = NETWORK_TO_CMC_SLUG[String(values.network || '').toUpperCase()]
    if (!slug || !values.address) return

    values.cmcUrl = cmcTokenUrl(slug, values.address)

    const { liquidity, volume24h, holders } = await fetchCmcData({
      slug,
      address: values.address,
    })
    values.cmcLiquidity = usd(liquidity)
    values.cmcVolume24h = usd(volume24h)
    values.cmcHolders = count(holders)
  } catch (err) {
    console.warn(`Could not fetch CMC metrics for ${values.address}: ${err.message}`)
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `yarn test scripts/cmcMetrics.test.mjs`
Expected: PASS (all cases). The "fetch rejects" case takes ~1s due to one retry backoff — expected.

- [ ] **Step 5: Commit**

```bash
git add scripts/cmcMetrics.mjs scripts/cmcMetrics.test.mjs
git commit -m "feat: add cmcMetrics module for CMC DEX metrics enrichment"
```

---

### Task 2: Integrate enrichment into `processRequest.mjs`

**Files:**
- Modify: `scripts/processRequest.mjs`
- Test: `scripts/processRequest.test.mjs`

**Interfaces:**
- Consumes: `enrichWithCmcMetrics` from Task 1.
- Produces: `processRequest(context, core): Promise<void>` (now async). Adds `cmcLiquidity`/`cmcVolume24h`/`cmcHolders`/`cmcUrl` to the `issueInfo` output for `addToken`.

- [ ] **Step 1: Update the existing tests (make async, mock fetch)**

In `scripts/processRequest.test.mjs`, add the import at the top (after the existing imports):

```js
import { mock } from 'node:test'
```

Note: `describe`, `it`, `mock` are already imported on line 1 — **do not duplicate**. Only ensure `mock` is present (it already is).

Replace the entire `describe('processRequest', ...)` block (lines 108-153) with:

```js
describe('processRequest', () => {
  process.env.FIELD_NAMES = 'network,symbol,name,address,url,decimals,reason'

  const originalFetch = global.fetch
  afterEach(() => {
    global.fetch = originalFetch
  })

  it('processes request', async () => {
    // addToken triggers CMC enrichment -> mock fetch so the unit test stays offline.
    global.fetch = mock.fn(async () => ({ ok: false, status: 404, text: async () => '' }))

    const body = `
      ### network
      POLYGON

      ### symbol
      USDC

      ### url
      https://some.url
      ### decimals
      99

      ### reason
      Something

      ### name
      USD Coin

      ### address
      0x123`
    const context = createContext(body)
    const core = createMockCore()

    await processRequest(context, core)

    const info = getIssueInfo(core)
    assert.equal(info.network, 'POLYGON')
    assert.equal(info.chainId, 137)
    // Enrichment ran but the token is "unlisted" (404) -> n/a, PR still proceeds.
    assert.equal(info.cmcLiquidity, 'n/a')
    assert.equal(info.cmcUrl, 'https://dex.coinmarketcap.com/token/polygon/0x123/')
  })

  it('handles errors', async () => {
    const errorCases = [
      { labels: ['invalid'], pattern: /No valid operation/ },
      { labels: ['addToken'], pattern: /Missing required/ },
    ]

    for (const { labels, pattern } of errorCases) {
      const context = createContext('### network\nMAINNET', labels)
      const core = createMockCore()
      await assert.rejects(processRequest(context, core), pattern)
    }
  })
})
```

Also update the top import line 1 to include `afterEach`:

```js
import { describe, it, mock, afterEach } from 'node:test'
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn test scripts/processRequest.test.mjs`
Expected: FAIL — `info.cmcLiquidity` is `undefined` (enrichment not wired yet); the `handles errors` case may also fail because `processRequest` is not yet async.

- [ ] **Step 3: Wire enrichment into `processRequest.mjs`**

Add the import near the top of `scripts/processRequest.mjs` (below the existing exports, or at the very top — top is cleanest):

```js
import { enrichWithCmcMetrics } from './cmcMetrics.mjs'
```

Replace the `processRequest` function (lines 69-87) with:

```js
export const processRequest = async (context, core) => {
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

  // Enrich addToken PRs with CMC DEX metrics. Never throws / never blocks.
  if (operation === 'addToken') {
    await enrichWithCmcMetrics(values)
  }

  core.setOutput('operation', operation)
  core.setOutput('issueInfo', JSON.stringify(values))
  core.setOutput('needsImageOptimization', ['addImage', 'addToken'].includes(operation))
}
```

- [ ] **Step 4: Run the full test suite to verify it passes**

Run: `yarn test`
Expected: PASS — all `cmcMetrics` and `processRequest` tests green.

- [ ] **Step 5: Commit**

```bash
git add scripts/processRequest.mjs scripts/processRequest.test.mjs
git commit -m "feat: enrich addToken issueInfo with CMC DEX metrics"
```

---

### Task 3: Render metrics in the add-token PR body

**Files:**
- Modify: `.github/workflows/processRequest.yml`

**Interfaces:**
- Consumes: `cmcLiquidity`/`cmcVolume24h`/`cmcHolders`/`cmcUrl` fields on `issueInfo` (Task 2).
- Produces: no code interface (workflow YAML).

- [ ] **Step 1: `await` the async call**

In `.github/workflows/processRequest.yml`, change the `extract-info` step script (currently line 44) from:

```yaml
            processRequest(context, core);
```

to:

```yaml
            await processRequest(context, core);
```

(`actions/github-script` runs the script in an async wrapper, so top-level `await` is supported.)

- [ ] **Step 2: Add the metrics table to the add-token `prBody`**

In the `execute-add-token` job, replace the `### Reason` block of `prBody` (lines 84-88) with the metrics table followed by the reason:

```yaml
        ### CoinMarketCap DEX metrics

        | Liquidity | 24h Volume | Holders |
        |-----------|-----------|---------|
        | ${{ fromJSON(needs.process-request.outputs.issueInfo).cmcLiquidity }} | ${{ fromJSON(needs.process-request.outputs.issueInfo).cmcVolume24h }} | ${{ fromJSON(needs.process-request.outputs.issueInfo).cmcHolders }} |

        [View on CoinMarketCap ↗︎](${{ fromJSON(needs.process-request.outputs.issueInfo).cmcUrl }})

        ### Reason

        ```
        ${{ fromJSON(needs.process-request.outputs.issueInfo).reason }}
        ```
```

Leave the `execute-remove-token` and `execute-add-image` `prBody` blocks unchanged.

- [ ] **Step 3: Verify the workflow YAML still parses**

Run:
```bash
python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/processRequest.yml')); print('YAML OK')"
```
Expected: `YAML OK` (no parse error).

If `actionlint` is available, also run `actionlint .github/workflows/processRequest.yml` and expect no new errors.

- [ ] **Step 4: Sanity-check the rendered body shape**

Confirm by eye that the add-token `prBody` now contains, in order: the address line, block-explorer link, image table, the new "CoinMarketCap DEX metrics" table, the CMC link, then the Reason block.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/processRequest.yml
git commit -m "feat: show CMC DEX metrics in automated addToken PR body"
```

---

## Self-Review Notes

- **Spec coverage:** liquidity/volume/holders fetch (Task 1), addToken-only enrichment (Task 2), non-blocking try/catch + defaults (Task 1 `enrichWithCmcMetrics`), PR-body table (Task 3), tests for success/failure/unmapped/non-addToken (Tasks 1 & 2), `token-dex-table.mjs` untouched. All covered.
- **Type consistency:** `enrichWithCmcMetrics` field names (`cmcLiquidity`, `cmcVolume24h`, `cmcHolders`, `cmcUrl`) are identical across the module, the processRequest test assertions, and the YAML template.
- **Non-blocking:** guaranteed by the internal try/catch in `enrichWithCmcMetrics` plus the fact that it only mutates `values`; even a caught-and-logged error cannot reject `processRequest`.
