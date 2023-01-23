import fetch from "node-fetch";
import fs from "fs";
import path from "path";

const BUILD_DIR = path.join(".", "build");
const LIST_DIR = path.join(BUILD_DIR, "lists");
const PAGE_LIMIT = 50;
const FILE_PREFIX = "coingecko";
const OUTPUT_FILE = "CoinGecko.json";

// Prevent rate-limit issues https://www.coingecko.com/en/api/documentation
const WAIT_TIME_BETWEEN_REQUEST = 2000;

async function fetchCoingeckoTop(limit, page) {
  console.log(
    `Fetch page CoinGecko's Tokens, sorted by Market Cap: Page ${page} (${limit} results)`
  );
  const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=${limit}&page=${page}&sparkline=false&category=ethereum-ecosystem`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `Error fetching page ${page}. Error: ${
        res.status
      }, Message: ${await res.text()}`
    );
  }
  const json = await res.json();
  return json;
}

async function fetchCoingeckoAll() {
  console.log(`Fetch all CoinGecko's ERC20 Tokens`);
  const url = "https://tokens.coingecko.com/uniswap/all.json";
  const res = await fetch(url);
  const json = await res.json();
  return json;
}

async function writeJson(filePath, data) {
  console.log(`Write data ${filePath}`);
  fs.writeFileSync(filePath, data);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createSortMap(tokens) {
  return tokens.reduce((r, e, i) => {
    r[e.symbol.toLowerCase()] = i;
    return r;
  }, {});
}

function buildTokenList(tokens, version) {
  return JSON.stringify(
    {
      name: "CoinGecko",
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
        "https://www.coingecko.com/assets/thumbnail-007177f3eca19695592f0b8b0eabbdae282b54154e1be912285c9034ea6cbaf2.png",
      keywords: ["default", "list", "coingecko"],
      tokens: tokens,
    },
    0,
    4
  );
}

async function writeCoingeckoListFile(version) {
  const combinedTokens = [];

  const tokenFiles = fs
    .readdirSync(BUILD_DIR)
    .filter(
      (file) => path.extname(file) === ".json" && file.startsWith(FILE_PREFIX)
    );

  tokenFiles.forEach((file) => {
    const tokensJson = fs.readFileSync(path.join(BUILD_DIR, file));
    const tokens = JSON.parse(tokensJson.toString());
    combinedTokens.push(...tokens);
  });

  const filePath = path.join(LIST_DIR, OUTPUT_FILE);
  writeJson(filePath, buildTokenList(combinedTokens, version));
}

async function fetchTokens(page, limit, allTokens) {
  const tokens = await fetchCoingeckoTop(limit, page); // TODO: We need to map this tokens to an enhanced version

  const filteredTokens = allTokens.tokens.filter((c) =>
    tokens.some((t) => t.symbol.toLowerCase() === c.symbol.toLowerCase())
  );

  const sortMap = createSortMap(tokens);
  const sortedTokens = filteredTokens.sort(
    (a, b) => sortMap[a.symbol.toLowerCase()] - sortMap[b.symbol.toLowerCase()] // TODO: @nenad why do you sort filteredTokens, and use sortMap symbol as the sorting field?
  );

  const filePath = path.join(BUILD_DIR, `${FILE_PREFIX}-${page}.json`);
  writeJson(filePath, JSON.stringify(sortedTokens, 0, 4));
}

function ensureBuildDir(dirs) {
  for (let dir of dirs) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir);
    }
  }
}

async function main() {
  ensureBuildDir([BUILD_DIR, LIST_DIR]);
  const allTokens = await fetchCoingeckoAll(); // FIXME: This is acting as filter, it should be removed and fetchTokens would be in charge of getting the symbols/address/etc

  for (let page = 1; page <= 5; page++) {
    await fetchTokens(page, PAGE_LIMIT, allTokens);
    await sleep(WAIT_TIME_BETWEEN_REQUEST);
  }
  await writeCoingeckoListFile({ patch: 1 }); // TODO: Improve versioning of the file
}

main().catch(console.error);
