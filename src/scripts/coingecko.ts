import fs from 'fs'
import path from 'path'
import { BUILD_DIR, writeTokenListToBuild, writeTokenListToSrc } from './tokenListUtils'
import type { TokenInfo, TokenList } from '@uniswap/token-lists'

const PAGE_LIMIT = 50
const FILE_PREFIX = 'coingecko'
const OUTPUT_FILE = 'CoinGecko.json'

// Prevent rate-limit issues https://www.coingecko.com/en/api/documentation
const WAIT_TIME_BETWEEN_REQUEST = 2000

async function fetchCoingeckoTop(limit: number, page: number) {
  console.log(`Fetch page CoinGecko's Tokens, sorted by Market Cap: Page ${page} (${limit} results)`)
  const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=${limit}&page=${page}&sparkline=false&category=ethereum-ecosystem`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Error fetching page ${page}. Error: ${res.status}, Message: ${await res.text()}`)
  }
  const json = await res.json();
  return json;
}

async function fetchCoingeckoAll() {
  console.log(`Fetch all CoinGecko's ERC20 Tokens`)
  const url = 'https://tokens.coingecko.com/uniswap/all.json';
  const res = await fetch(url);
  const json = await res.json();
  return json;
}

async function writeJson(filePath: string, data: any) {
  console.log(`Write data ${filePath}`);
  fs.writeFileSync(filePath, data)
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createSortMap(tokens: TokenInfo[]) {
  return tokens.reduce<{ [address: string]: number }>((r, e, i) => {
    r[e.symbol.toLowerCase()] = i;
    return r;
  }, {});
}

function buildTokenList(tokens: TokenInfo[], version: { patch: number }): TokenList {
  return {
    name: 'CoinGecko',
    timestamp: new Date().toISOString(),
    version: Object.assign(
      {
        major: 0,
        minor: 0,
        patch: 1,
      },
      version
    ),
    logoURI:
      'https://support.coingecko.com/hc/article_attachments/4499575478169/CoinGecko_logo.png',
    keywords: ['default', 'list', 'coingecko'],
    tokens: tokens,
  }
}


async function writeCoingeckoListFile(version: { patch: number }) {
  const combinedTokens: TokenInfo[] = [];

  const tokenFiles = fs
    .readdirSync(BUILD_DIR)
    .filter(
      (file) => path.extname(file) === '.json' && file.startsWith(FILE_PREFIX)
    );

  tokenFiles.forEach((file) => {
    const tokensJson = fs.readFileSync(path.join(BUILD_DIR, file));
    const tokens = JSON.parse(tokensJson.toString());
    combinedTokens.push(...tokens);
  });

  const tokenList = buildTokenList(combinedTokens, version)

  writeTokenListToBuild(OUTPUT_FILE, tokenList)
  writeTokenListToSrc(OUTPUT_FILE, tokenList)
}

async function fetchTokens(page: number, limit: number, allTokens: TokenList) {
  const tokens = await fetchCoingeckoTop(limit, page); // TODO: We need to map this tokens to an enhanced version

  const filteredTokens = allTokens.tokens.filter((c) =>
    tokens.some((t: TokenInfo) => t.symbol.toLowerCase() === c.symbol.toLowerCase())
  );

  const sortMap = createSortMap(tokens);
  const sortedTokens = filteredTokens.sort(
    (a, b) =>
      sortMap[a.symbol.toLowerCase()] - sortMap[b.symbol.toLowerCase()] // TODO: @nenad why do you sort filteredTokens, and use sortMap symbol as the sorting field?
  );

  const filePath = path.join(BUILD_DIR, `${FILE_PREFIX}-${page}.json`)
  writeJson(filePath, JSON.stringify(sortedTokens, null, 4));
}

async function main() {
  const allTokens = await fetchCoingeckoAll(); // FIXME: This is acting as filter, it should be removed and fetchTokens would be in charge of getting the symbols/address/etc

  for (let page = 1; page <= 5; page++) {
    await fetchTokens(page, PAGE_LIMIT, allTokens)
    await sleep(WAIT_TIME_BETWEEN_REQUEST)
  }

  await writeCoingeckoListFile({patch: 1}); // TODO: Improve versioning of the file
}

main()
  .catch(console.error)

