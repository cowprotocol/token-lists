import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import _ from "lodash";

const cowListUrl = "https://files.cow.fi/tokens/CowSwap.json";
const coinGeckoListUrl = "https://files.cow.fi/tokens/CoinGecko.json";
const coinGeckoIdListUrl = "https://api.coingecko.com/api/v3/coins/list";

const LIST_DIR = path.join("src", "lists");
const IDS_FILE_NAME = "id-list.json";
const IDS_FILE_PATH = path.join(LIST_DIR, IDS_FILE_NAME);

const STATIC_LIST_NAME = "static-list.json";
const STATIC_LIST_PATH = path.join(LIST_DIR, STATIC_LIST_NAME);

async function fetchFromCoingecko(url) {
  console.log(`Fetching ${url}`);
  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`Error fetching list ${url}`, res);
  }

  const json = await res.json();
  return json;
}

async function writeFile(dir, filename, input) {
  const data = JSON.stringify(input, null, 4);
  const filePath = path.join(dir, filename);

  console.log(`Writing file ${filePath}`);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(filePath, data);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getIds() {
  // If ID's file exist
  if (fs.existsSync(IDS_FILE_PATH)) {
    const json = fs.readFileSync(IDS_FILE_PATH, "utf8");
    return JSON.parse(json);
  }

  // Get token lists
  const cowList = await fetchFromCoingecko(cowListUrl);
  const coinGeckoList = await fetchFromCoingecko(coinGeckoListUrl);

  // Get Coingecko id list
  const coinGeckoIdList = await fetchFromCoingecko(coinGeckoIdListUrl);

  // Combine 2 lists
  const combined = [...cowList.tokens, ...coinGeckoList.tokens];

  // Crate unique list by symbols from those 2
  const uniq = _.uniqBy(combined, ({ symbol }) => symbol);
  // Get just an array of symbols
  const symbols = uniq.map(({ symbol }) => symbol.toLowerCase());

  // Get coin gecko list of ids for that uniq list
  const idsData = coinGeckoIdList.filter((el) =>
    symbols.includes(el.symbol.toLowerCase())
  );

  // Write ID's file
  writeFile(LIST_DIR, IDS_FILE_NAME, idsData);

  return idsData;
}

async function getStaticData(idsData) {
  const successDelay = 3000; // Delay in milliseconds for successful requests
  const errorDelay = 10000; // Delay in milliseconds for error requests
  const staticData = [];

  let index = 0;
  while (index < idsData.length) {
    const idItem = idsData[index];
    const quoteParams = `localization=false&tickers=false&market_data=false&community_data=false&developer_data=false&sparkline=false`;
    const url = `https://api.coingecko.com/api/v3/coins/${idItem.id}?${quoteParams}`;

    console.log(`Fetching data for ID: ${idItem.id}`);

    try {
      const data = await fetchFromCoingecko(url);
      staticData.push(data);
      await sleep(successDelay); // Delay after a successful fetch
      index++; // Move to the next item
    } catch (error) {
      console.log(error);
      console.error(`Error fetching data for ID: ${idItem.id}`);
      console.log(`Retrying fetch for ID: ${idItem.id}`);
      await sleep(errorDelay); // Delay after an error fetch
    }
  }

  // Write static data file
  writeFile(LIST_DIR, STATIC_LIST_NAME, staticData);

  return staticData;
}

async function main() {
  const idsData = await getIds();
  const staticData = await getStaticData(idsData);

  console.log(staticData.length);
  console.log("Done!!!");
}

main();
