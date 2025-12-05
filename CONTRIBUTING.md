# Contributing

```sh
yarn install
```

```sh
COINGECKO_API_KEY=your_api_key_here yarn generateAuxLists
```

Consider reading <https://github.com/cowprotocol/cowswap/blob/develop/CONTRIBUTING.md>.

## Workflows

This repository uses several GitHub Actions workflows to automate testing, validation, list generation, and deployment.

### Self-Serve Token Requests
*   [`processRequest.yml`](.github/workflows/processRequest.yml) - Validates issues and orchestrates image optimization and token changes.
*   [`executeAction.yml`](.github/workflows/executeAction.yml) - Handles the actual execution of token additions/removals and PR creation.
*   [`optimizeImage.yml`](.github/workflows/optimizeImage.yml) - Optimizes and resizes token images (reusable workflow).

### Scheduled Maintenance & Updates
*   [`cowFi-tokens.yml`](.github/workflows/cowFi-tokens.yml) - Generates, uploads, and caches the cow.fi token list every 3 hours.
*   [`generateAuxLists.yml`](.github/workflows/generateAuxLists.yml) - Generates auxiliary token lists daily or on manual trigger.
*   [`updatePermitInfo.yml`](.github/workflows/updatePermitInfo.yml) - Fetches and updates on-chain permit information for supported chains.

### CI & Validation
*   [`ci.yml`](.github/workflows/ci.yml) - Validates the codebase on PRs and pushes by running schema validation and tests.
*   [`cla.yml`](.github/workflows/cla.yml) - Verifies that contributors have signed the Contributor License Agreement.

### Deployment
*   [`s3Deploy.yml`](.github/workflows/s3Deploy.yml) - Deploys the main `CowSwap.json` list to S3 and invalidates cache on Release.
