import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import _ from "lodash";

const cowListUrl = "https://files.cow.fi/tokens/CowSwap.json";
const coinGeckoListUrl = "https://files.cow.fi/tokens/CoinGecko.json";
const coinGeckoIdListUrl = "https://api.coingecko.com/api/v3/coins/list";

const LIST_DIR = path.join("src", "lists");

const IDS_FILE_NAME_RAW = "id-list-raw.json";
const IDS_FILE_PATH_RAW = path.join(LIST_DIR, IDS_FILE_NAME_RAW);

const IDS_FILE_NAME_FINAL = "id-list-final.json";
const IDS_FILE_PATH_FINAL = path.join(LIST_DIR, IDS_FILE_NAME_FINAL);

const STATIC_LIST_NAME_RAW = "static-list-raw.json";
const STATIC_LIST_PATH_RAW = path.join(LIST_DIR, STATIC_LIST_NAME_RAW);

const STATIC_LIST_NAME_FINAL = "static-list-final.json";
const STATIC_LIST_PATH_FINAL = path.join(LIST_DIR, STATIC_LIST_NAME_FINAL);

const CUSTOM_DESCRIPTION_PATH = path.join("src", "files", "description.json");

const TOTAL_LIST_LENGTH = 50;

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

  console.log(`Writing file ${filePath}, length: ${input.length}`);

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
  // const coinGeckoList = await fetchFromCoingecko(coinGeckoListUrl);

  // Create input token list
  // const result = [...cowList.tokens, ...coinGeckoList.tokens];
  const list = [...cowList.tokens];

  // Make the list unique by symbol
  const unique = _.uniqBy(list, ({ symbol }) => symbol);

  // Get an address and lowercase symbols
  const result = unique.map(({ symbol, address }) => ({
    symbol: symbol.toLowerCase(),
    address: address.toLowerCase(),
  }));

  console.log("Input token list", result.length);

  return result;
}

async function getIds() {
  // If ID's file exist
  if (fs.existsSync(IDS_FILE_PATH_RAW)) {
    const json = fs.readFileSync(IDS_FILE_PATH_RAW, "utf8");
    return JSON.parse(json);
  }

  // Get input list
  const inputList = await getTokenLists();

  // Get Coingecko id list
  const coinGeckoIdList = await fetchFromCoingecko(coinGeckoIdListUrl);

  // Get coin gecko list of ids for that uniq list
  const idsData = coinGeckoIdList.filter((el) =>
    inputList.some((input) => input.symbol === el.symbol.toLowerCase())
  );

  // Write ID's file
  writeFile(LIST_DIR, IDS_FILE_NAME_RAW, idsData);

  return idsData;
}

async function getStaticData(idsData) {
  // If static data file exists, read and return it
  if (fs.existsSync(STATIC_LIST_PATH_RAW)) {
    const json = fs.readFileSync(STATIC_LIST_PATH_RAW, "utf8");
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
  writeFile(LIST_DIR, STATIC_LIST_NAME_RAW, staticData);

  return staticData;
}

async function getStaticDataFinal(data) {
  // Get only USD values for market data
  let customDescriptionFile = null;

  if (fs.existsSync(CUSTOM_DESCRIPTION_PATH)) {
    const json = fs.readFileSync(CUSTOM_DESCRIPTION_PATH, "utf8");
    customDescriptionFile = JSON.parse(json);
  }

  // Modify the data
  const parsed = data.map((item) => {
    const output = { ...item };

    // Parse Market data to only get USD values
    const market_data = output.market_data;

    for (let [key, value] of Object.entries(market_data)) {
      if (value && typeof value === "object" && "usd" in value) {
        market_data[key] = { usd: value.usd };
      }
    }
    output.market_data = market_data;

    // Add custom description
    if (customDescriptionFile && customDescriptionFile[item.id]) {
      output.description = customDescriptionFile[item.id];
    }

    return output;
  });

  // Get hash map (object) of token IDS from our input list
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

  // Sort the data by market cap and take limit the list
  const output = filtered.slice(0, TOTAL_LIST_LENGTH);

  writeFile(LIST_DIR, STATIC_LIST_NAME_FINAL, output);

  return output;
}

async function getIdsFinal(data) {
  const ids = data.map(({ name, symbol, address, id }) => ({
    id,
    name,
    symbol,
    address,
  }));

  writeFile(LIST_DIR, IDS_FILE_NAME_FINAL, ids);

  return ids;
}

async function main() {
  if (!fs.existsSync(LIST_DIR)) {
    fs.mkdirSync(LIST_DIR);
  }

  const idsDataRaw = await getIds();
  const staticDataRaw = await getStaticData(idsDataRaw);
  const staticDataFinal = await getStaticDataFinal(staticDataRaw);
  const idsDataFinal = await getIdsFinal(staticDataFinal);

  console.log("Final output token length", idsDataFinal.length);
  console.log("Done!!!");
}

main();
