import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import { CoinGeckoClient, CoinMarket } from "coingecko-api-v3";
import { Token, TokenList, Version } from "./types";

const BUILD_DIR = path.join(".", "build");
const LIST_DIR = path.join(BUILD_DIR, "lists");
const PAGE_LIMIT = 50;
const PAGE_COUNT = 5;
const FILE_PREFIX = "coingecko";
const OUTPUT_FILE = "CoinGecko.json";
const SUPPORTED_CHAINS = [
  { name: "ethereum", chainId: 1 },
  { name: "xdai", chainId: 100 },
];

const client = new CoinGeckoClient({
  timeout: 10_000,
  autoRetry: true, // will automatically handle 429s and adjust retry time
});

async function fetchCoingeckoAll() {
  console.log(`Fetch all CoinGecko's ERC20 Tokens`);
  const url = "https://tokens.coingecko.com/uniswap/all.json";
  return (await fetch(url).then((res) => res.json())) as TokenList;
}

async function fetchCoinMarkets(page: number) {
  return client.coinMarket({
    page,
    order: "market_cap_desc",
    per_page: PAGE_LIMIT,
    vs_currency: "usd",
    sparkline: false,
    ...({ category: "ethereum-ecosystem" } as any), // not typed in the library, but passed in the request
  });
}

async function writeJson(filePath: string, data: any) {
  console.log(`Write data ${filePath}`);
  await fs.promises.writeFile(filePath, data);
}

function createSortMap(tokens: Token[]) {
  return tokens.reduce<Record<string, number>>((r, e, i) => {
    r[e.symbol.toLowerCase()] = i;
    return r;
  }, {});
}

function buildTokenList(tokens: Token[], version: Partial<Version>) {
  const tokenList: TokenList = {
    name: "CoinGecko",
    timestamp: new Date().toISOString(),
    version: {
      major: 0,
      minor: 0,
      patch: 1,
      ...version,
    },
    logoURI:
      "https://www.coingecko.com/assets/thumbnail-007177f3eca19695592f0b8b0eabbdae282b54154e1be912285c9034ea6cbaf2.png",
    keywords: ["default", "list", "coingecko"],
    tokens,
  };

  return JSON.stringify(tokenList, null, 4);
}

async function writeCoingeckoListFile(version: Partial<Version>) {
  const combinedTokens: Token[] = [];

  const tokenFiles = fs
    .readdirSync(BUILD_DIR)
    .filter(
      (file) => path.extname(file) === ".json" && file.startsWith(FILE_PREFIX)
    );

  tokenFiles.forEach((file) => {
    const tokensJson = fs.readFileSync(path.join(BUILD_DIR, file));
    const tokens = JSON.parse(tokensJson.toString()) as Token[];
    combinedTokens.push(...tokens);
  });

  const filePath = path.join(LIST_DIR, OUTPUT_FILE);
  await writeJson(filePath, buildTokenList(combinedTokens, version));
}

// Match a CoinMarket to a token from the Coingecko TokenList based on
// matching symbol and Coingecko numeric ID (extracted from the image URL),
// because symbols often collide.
function findTokenFromList(
  coinMarket: CoinMarket,
  tokens: Token[]
): Token | null {
  const imageIdPattern = /\/coins\/images\/(\d+)\//;
  const match = coinMarket.image.match(imageIdPattern);
  if (!match) {
    return null;
  }
  return tokens.find(
    (token) =>
      coinMarket.symbol.toLowerCase() === token.symbol.toLowerCase() &&
      token.logoURI.match(imageIdPattern)?.[1] === match[1]
  );
}

async function fetchTokens(coinMarkets: CoinMarket[], coingeckoAll: TokenList) {
  const tokens: Token[] = [];

  for (const coinMarket of coinMarkets) {
    // The coin market data lacks some required fields (decimals, address, chain ID)
    const { id, name } = coinMarket;

    // If the coin market can be matched to a token in an existing token list,
    // use that directly.
    const tokenFromList = findTokenFromList(coinMarket, coingeckoAll.tokens);
    if (tokenFromList) {
      tokens.push(tokenFromList);
      continue;
    }

    // Otherwise, fetch the coin data to get missing fields.
    const coin = await client.coinId({
      id,
      sparkline: false,
      tickers: false,
      community_data: false,
      market_data: false,
      developer_data: false,
      localization: false,
    });

    const {
      // Fields such as name are also present in the coin data, but are
      // unused in favour of the coin market data.
      image: { thumb: logoURI },
      detail_platforms,
    } = coin as typeof coin & {
      detail_platforms: {
        [chain: string]: { decimal_place: number; contract_address: string };
      };
    };

    // Try supported chains in order to get the contract address and decimals.
    const chain = SUPPORTED_CHAINS.find(({ name }) => detail_platforms[name]);

    if (!chain) {
      // If there is no `detail_platforms` entry found, it is likely either not an
      // ERC20, or not on a supported chain.
      console.log(`Unsupported coin: ${id}`);
      continue;
    }

    const { chainId } = chain;
    const { decimal_place: decimals, contract_address: address } =
      detail_platforms[chain.name];

    if (decimals === 0 || address === "") {
      // Some coins have a `detail_platforms` field but lack basic token data.
      console.log(`Invalid token data: ${id}`);
      continue;
    }

    const token: Token = {
      chainId,
      address,
      name,
      symbol: coinMarket.symbol.toUpperCase(),
      decimals,
      logoURI,
    };
    tokens.push(token);
  }

  return tokens;
}

async function fetchPage(page: number, coingeckoAll: TokenList) {
  const coinMarkets = await fetchCoinMarkets(page);
  const tokens = await fetchTokens(coinMarkets, coingeckoAll);

  const sortMap = createSortMap(tokens);
  const sortedTokens = tokens.sort(
    (a, b) => sortMap[a.symbol.toLowerCase()] - sortMap[b.symbol.toLowerCase()]
  );

  const filePath = path.join(BUILD_DIR, `${FILE_PREFIX}-${page}.json`);
  await writeJson(filePath, JSON.stringify(sortedTokens, null, 4));

  return tokens;
}

function ensureBuildDir(dirs: string[]) {
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir);
    }
  }
}

async function main() {
  ensureBuildDir([BUILD_DIR, LIST_DIR]);

  const coingeckoAll = await fetchCoingeckoAll();

  for (let page = 1; page <= PAGE_COUNT; page++) {
    await fetchPage(page, coingeckoAll);
  }

  await writeCoingeckoListFile({ patch: 1 }); // TODO: Improve versioning of the file
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
