import fetch from "node-fetch";
import fs from "fs";
import path from "path";

const BUILD_DIR = path.join(".", 'build');
const PAGE_LIMIT = 50

if (!fs.existsSync(BUILD_DIR)){
  fs.mkdirSync(BUILD_DIR);
}

async function fetchCoingeckoTop(limit, page) {
  console.log(`Fetch page CoinGecko's Tokens, sorted by Market Cap: Page ${page} (${limit} results)`)
  const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=${limit}&page=${page}&sparkline=false&category=ethereum-ecosystem`;
  const res = await fetch(url);
  const json = await res.json();
  return json;
}

async function fetchCoingeckoAll() {
  console.log(`Fetch all CoinGecko's ERC20 Tokens`)
  const url = "https://tokens.coingecko.com/uniswap/all.json";
  const res = await fetch(url);
  const json = await res.json();
  return json;
}

async function writeJson(fileName, data) {
  const filePath = path.join(BUILD_DIR, fileName)
  console.log(`Write data ${filePath}`);
  fs.writeFileSync(filePath, data)
}

function createSortMap(tokens) {
  return tokens.reduce((r, e, i) => {
    r[e.symbol.toLowerCase()] = i;
    return r;
  }, {});
}

function createFinalResult(tokens, version) {
  return JSON.stringify(
    {
      name: "CoinGecko",
      timestamp: new Date().toISOString(),
      version: Object.assign(
        {
          major: 0,
          minor: 1,
          patch: 7,
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


async function combineTokens(version) {
  const output = [];

  const jsonsInDir = fs
    .readdirSync(BUILD_DIR)
    .filter(
      (file) => path.extname(file) === ".json" && file.startsWith("tokens")
    );

  jsonsInDir.forEach((file) => {
    const fileData = fs.readFileSync(path.join(BUILD_DIR, file));
    const json = JSON.parse(fileData.toString());
    output.push(...json);
  });

  writeJson("combined.json", createFinalResult(output, version));
}

async function fetchTokens(page, limit, allTokens) {

  const top = await fetchCoingeckoTop(limit, page);  

  const filtered = allTokens.tokens.filter((c) =>
    top.some((t) => t.symbol.toLowerCase() === c.symbol.toLowerCase())
  );

  const sortMap = createSortMap(top);
  const sorted = filtered.sort(
    (a, b) =>
      sortMap[a.symbol.toLowerCase()] - sortMap[b.symbol.toLowerCase()]
  );

  writeJson(`tokens-${page}.json`, JSON.stringify(sorted, 0, 4));
}

async function main() {
  const allTokens = await fetchCoingeckoAll(); // FIXME: This is acting as filter, it should be removed and fetchTokens would be in charge of getting the symbols/address/etc

  for (let page=1; page<=5; page++) {
    await fetchTokens(page, PAGE_LIMIT, allTokens)
  }
  await combineTokens({ patch: 8 }); // TODO: Improve versioning of the file
}

main()
  .catch(console.error)

