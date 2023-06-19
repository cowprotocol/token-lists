import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import _ from "lodash";

const cowListUrl = "https://files.cow.fi/tokens/CowSwap.json";
const coinGeckoListUrl = "https://files.cow.fi/tokens/CoinGecko.json";
const coinGeckoIdListUrl = "https://api.coingecko.com/api/v3/coins/list";

const LIST_DIR = path.join("src", "lists");
const IDS_FILE_PATH = path.join(LIST_DIR, "id-list.json");

async function fetchList(url) {
  console.log(`Fetching ${url}`);
  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`Error fetching list ${url}`);
  }

  const json = await res.json();
  return json;
}

async function writeFile(filePath, data) {
  console.log(`Writing file ${filePath}`);
  fs.writeFileSync(filePath, data);
}

async function getIds() {
  // If ID's file exist
  if (fs.existsSync(IDS_FILE_PATH)) {
    return fs.readFileSync(IDS_FILE_PATH, "utf8");
  }

  // Get token lists
  const cowList = await fetchList(cowListUrl);
  const coinGeckoList = await fetchList(coinGeckoListUrl);

  // Get Coingecko id list
  const coinGeckoIdList = await fetchList(coinGeckoIdListUrl);

  // Combine 2 lists
  const combined = [...cowList.tokens, ...coinGeckoList.tokens];

  // Crate unique list by symbols from those 2
  const uniq = _.uniqBy(combined, ({ symbol }) => symbol);
  // Get just an array of symbols
  const symbols = uniq.map(({ symbol }) => symbol.toLowerCase());

  // Get coin gecko list of ids for that uniq list
  const ids = coinGeckoIdList.filter((el) =>
    symbols.includes(el.symbol.toLowerCase())
  );

  // Write id's file
  const data = JSON.stringify(ids, null, 4);

  if (!fs.existsSync(LIST_DIR)) {
    fs.mkdirSync(LIST_DIR, { recursive: true });
  }

  await writeFile(IDS_FILE_PATH, data);

  return data;
}

async function main() {
  const ids_data = await getIds();

  console.log(ids_data);
}

main();
