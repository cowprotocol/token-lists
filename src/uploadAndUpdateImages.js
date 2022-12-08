import dotenv from 'dotenv'
import pinataSdk from '@pinata/sdk'
import {createReadStream} from 'fs'
import { strict as assert } from 'node:assert'
import path, {dirname} from 'path'
import { fileURLToPath } from 'url';

dotenv.config()
const PINATA_KEY = process.env.PINATA_KEY
assert(PINATA_KEY, 'PINATA_KEY is required environment variable')
const PINATA_SECRET = process.env.PINATA_SECRET
assert(PINATA_KEY, 'PINATA_SECRET is required environment variable')
const pinata = new pinataSdk(PINATA_KEY, PINATA_SECRET);

async function main() {
  // const result = await pinata.testAuthentication()
  // console.log(result)
  const dirName = dirname(fileURLToPath(import.meta.url))
  const absolutePath = path.join(dirName, './public/images/1/0x0ae055097c6d159879521c384f1d2123d1f195e6.png')
  const fileRS = createReadStream(absolutePath)
  const options = {
    pinataMetadata: {
        name: '0x0ae055097c6d159879521c384f1d2123d1f195e6.png',
        keyvalues: {
            symbol: 'xDAI',
            name: 'xDAI'
        }
    },
    // pinataOptions: {
    //     cidVersion: 0
    // }
  };
  // TODO: Read directories per network. Upload image, get IPFS, update image link in the CowSwap.json
  // {
  //   IpfsHash: 'QmTtPRDopH7vJZoe8mJoAF4rMEPqFRCqFLrHiv14ARkCxn',
  //   PinSize: 2119,
  //   Timestamp: '2022-12-08T13:12:46.964Z'
  // }
  const result = await pinata.pinFileToIPFS(fileRS, options)

  console.log('Result', result)
}


main().catch(console.error)