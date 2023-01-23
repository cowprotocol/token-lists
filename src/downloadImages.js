import cowSwapList from "./public/CowSwap.json" assert { type: "json" };
import fetch from "node-fetch";
import { createWriteStream } from "fs";
import path, { dirname } from "path";
import { fileURLToPath } from "url";

async function main() {
  for (const token of cowSwapList.tokens) {
    const { symbol, name, address, chainId, logoURI } = token;
    const filePath = `public/images/${chainId}/${address}.png`;

    console.log(`Download image for ${symbol} (${name})
      URI: ${logoURI}
      File: ${filePath}\n`);
    const dirName = dirname(fileURLToPath(import.meta.url));
    const absolutePath = path.join(dirName, filePath);
    // console.log('absolutePath', absolutePath)
    const fileStream = createWriteStream(absolutePath);
    const response = await fetch(logoURI);
    response.body.pipe(fileStream);
  }
}

main().catch(console.error);
