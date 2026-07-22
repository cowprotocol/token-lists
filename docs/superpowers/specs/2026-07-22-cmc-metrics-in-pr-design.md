# Design: CoinMarketCap DEX metrics in addToken PRs

Date: 2026-07-22

## Goal

When the token-request automation opens an `addToken` PR, enrich the PR
description with CoinMarketCap DEX metrics for the token: **liquidity**, **24h
volume**, and **holders**.

## Hard constraint: non-blocking

Fetching CMC data must **never** prevent a PR from being created. If the token
is not listed on CMC DEX, the chain is unmapped, the request times out, or any
other error occurs, PR creation proceeds unchanged with `n/a` shown for the
missing values.

## Decisions (agreed)

- **Location:** enrich `issueInfo` inside `scripts/processRequest.mjs` (not a
  separate workflow step).
- **Scope:** `addToken` only. `removeToken` and `addImage` PRs are unchanged.
- **Reuse:** create a **new** module for the scraping/enrichment logic; leave
  `token-dex-table.mjs` untouched (a self-contained dev tool). Some scraping
  logic is duplicated by design — accepted trade-off for lower blast radius.

## Components

### 1. `scripts/cmcMetrics.mjs` (new)

Self-contained module holding the CMC DEX scraping logic (copied and adapted
from `token-dex-table.mjs`), plus the enrichment entry point.

Exports:

- `NETWORK_TO_CMC_SLUG` — maps token-lists network identifiers (the
  `NETWORK_CONFIG` keys: `MAINNET`, `ARBITRUM_ONE`, `BASE`, `AVALANCHE`,
  `POLYGON`, `BNB`, `GNOSIS_CHAIN`, `LINEA`) to CMC DEX chain slugs. `PLASMA`
  and `INK` are intentionally absent (no CMC DEX slug) → treated as "no data".
- `fetchCmcData({ slug, address })` — fetches the CMC DEX page and extracts
  `liquidity`, `volume24h`, `holders` from the embedded `__NEXT_DATA__` JSON.
  Throws on HTTP error / missing data.
- `fetchWithRetry(url, opts)` — timeout + retry helper. Tuned for CI:
  **2 attempts, ~10s timeout** each (vs 3/20s in the dev script) so a dead
  token cannot stall the job.
- `usd(x)` — compact USD formatter, returns `'n/a'` for null/NaN.
- `enrichWithCmcMetrics(values)` — **async, never throws**. Given the parsed
  `values` object (has `network`, `address`), looks up the slug, fetches data,
  and writes **pre-formatted display strings** onto `values`:
  - `values.cmcLiquidity` — e.g. `'$1,234,567'` or `'n/a'`
  - `values.cmcVolume24h` — e.g. `'$98,765'` or `'n/a'`
  - `values.cmcHolders` — e.g. `'12,345'` or `'n/a'`
  - `values.cmcUrl` — the CMC DEX token URL (or a fallback/empty string)

  Wrapped entirely in try/catch. On any failure it logs a warning and leaves
  the fields at their `'n/a'` defaults. Formatting lives here (in JS, testable)
  so the YAML template stays a dumb substitution.

### 2. `scripts/processRequest.mjs` (modified)

- `processRequest(context, core)` becomes `async`.
- After validation, when `operation === 'addToken'`, `await
  enrichWithCmcMetrics(values)` before `core.setOutput('issueInfo', ...)`.
- Enrichment failure cannot fail the step (try/catch inside the helper).

### 3. `.github/workflows/processRequest.yml` (modified)

- `processRequest(context, core);` → `await processRequest(context, core);`
  in the `extract-info` github-script step.
- Extend the `execute-add-token` job's `prBody` with a metrics block:

  ```markdown
  ### CoinMarketCap DEX metrics

  | Liquidity | 24h Volume | Holders |
  |-----------|-----------|---------|
  | <cmcLiquidity> | <cmcVolume24h> | <cmcHolders> |

  [View on CoinMarketCap ↗︎](<cmcUrl>)
  ```

  Values come from `fromJSON(needs.process-request.outputs.issueInfo).cmcLiquidity`
  etc. Table always renders; `n/a` cells are an honest "not on CMC DEX" signal.
  The `removeToken` and `addImage` `prBody` blocks are unchanged.

## Data flow

```
issue opened (addToken label)
  → extract-info step: await processRequest(context, core)
      → extractFieldValues / applyNetworkConfig / generateImageUrls / validate
      → enrichWithCmcMetrics(values)   [addToken only, never throws]
          → NETWORK_TO_CMC_SLUG[network] → fetchCmcData → usd() formatting
          → values.cmcLiquidity / cmcVolume24h / cmcHolders / cmcUrl
      → core.setOutput('issueInfo', JSON.stringify(values))
  → execute-add-token job: prBody template reads cmc* fields from issueInfo
```

## Error handling

| Failure mode                         | Result                                  |
|--------------------------------------|-----------------------------------------|
| Token not listed on CMC DEX (no data)| all cmc fields `'n/a'`, PR created      |
| HTTP error / 429 / 5xx / timeout     | all cmc fields `'n/a'`, PR created      |
| Network not in `NETWORK_TO_CMC_SLUG` | all cmc fields `'n/a'`, PR created      |
| Unexpected throw in enrichment       | caught + logged, fields `'n/a'`, PR created |

## Testing — `scripts/processRequest.test.mjs`

Add cases (mock global `fetch`):

1. `addToken` + successful CMC response → `values.cmcLiquidity` /
   `cmcVolume24h` / `cmcHolders` populated with formatted strings; `cmcUrl` set.
2. `addToken` + `fetch` rejects / returns non-ok → fields default to `'n/a'`;
   `processRequest` does **not** throw.
3. `addToken` + network with no slug (e.g. `PLASMA`) → fields `'n/a'`, no fetch
   attempted, no throw.
4. Non-`addToken` operation → no `cmc*` fields added / no fetch attempted.

Use a sample `__NEXT_DATA__` HTML fixture mirroring the shape parsed in
`fetchCmcData` (`props.pageProps.holdersCount` and the `dex-token-info` query
with `liqUsd` / `sts[].vu`).

## Out of scope

- Refactoring `token-dex-table.mjs`.
- Metrics for `removeToken` / `addImage`.
- Any CMC API-key based approach (we scrape the public DEX page, as the existing
  dev script does).
