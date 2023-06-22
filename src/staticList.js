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

const STATIC_LIST_PARSED_NAME = "static-list-parsed.json";
const STATIC_LIST_PARSED_PATH = path.join(LIST_DIR, STATIC_LIST_NAME);

const CUSTOM_DESCRIPTION_PATH = path.join("src", "files", "description.json");

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

async function getTokenLists() {
  // Get token lists
  const cowList = await fetchFromCoingecko(cowListUrl);
  const coinGeckoList = await fetchFromCoingecko(coinGeckoListUrl);

  // Combine 2 lists
  const combined = [...cowList.tokens, ...coinGeckoList.tokens];

  console.log("Combined tokens", combined.length);

  return combined;
}

async function getIds() {
  // If ID's file exist
  if (fs.existsSync(IDS_FILE_PATH)) {
    const json = fs.readFileSync(IDS_FILE_PATH, "utf8");
    return JSON.parse(json);
  }

  const combined = await getTokenLists();

  // Get Coingecko id list
  const coinGeckoIdList = await fetchFromCoingecko(coinGeckoIdListUrl);

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
  // If static data file exists, read and return it
  if (fs.existsSync(STATIC_LIST_PATH)) {
    const json = fs.readFileSync(STATIC_LIST_PATH, "utf8");
    return JSON.parse(json);
  }

  const successDelay = 3000; // Delay in milliseconds for successful requests
  const errorDelay = 10000; // Delay in milliseconds for error requests
  const staticData = [];

  let index = 0;
  while (index < idsData.length) {
    const idItem = idsData[index];
    const quoteParams = `localization=false&tickers=false&market_data=true&community_data=false&developer_data=false&sparkline=false`;
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

async function parseStaticData(data) {
  // Get only USD values for market data
  let customDescriptionFile = null;

  if (fs.existsSync(CUSTOM_DESCRIPTION_PATH)) {
    const json = fs.readFileSync(CUSTOM_DESCRIPTION_PATH, "utf8");
    customDescriptionFile = JSON.parse(json);
  }

  const parsed = data.map((item) => {
    const output = { ...item };

    // Market data
    const market_data = output.market_data;

    for (let [key, value] of Object.entries(market_data)) {
      if (value && typeof value === "object" && "usd" in value) {
        market_data[key] = { usd: value.usd };
      }
    }
    output.market_data = market_data;

    // Description
    if (customDescriptionFile && customDescriptionFile[item.id]) {
      output.description = customDescriptionFile[item.id];
    }

    return output;
  });

  // Get hash map (object) of token IDS from our 2 existing lists
  const combined = await getTokenLists();
  const combined_ids = combined.reduce((acc, { address }) => {
    acc[address.toLowerCase()] = true;
    return acc;
  }, {});

  // Filter current static list with only tokens from our 2 exists list
  const filtered = parsed.filter(({ platforms }) => {
    return Object.entries(platforms).some(
      ([chain, address]) =>
        combined_ids[address.toLowerCase()] &&
        ["ethereum", "xdai"].includes(chain)
    );
  });

  writeFile(LIST_DIR, STATIC_LIST_PARSED_NAME, filtered);

  return filtered;
}

async function main() {
  const idsData = await getIds();
  const staticData = await getStaticData(idsData);
  const parsedData = await parseStaticData(staticData);

  console.log("Final output tokens", parsedData.length);
  console.log("Done!!!");
}

main();
