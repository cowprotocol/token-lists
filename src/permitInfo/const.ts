import { env } from 'node:process'
import { join } from 'node:path'

// CoW protocol contract address. Could be any address in theory for checking the token is permittable
export const SPENDER_ADDRESS = '0xC92E8bdf79f0507f65a392b0ab4667716BFE0110'

export const DEFAULT_RPC_URLS: Record<number, string> = {
  1: 'https://mainnet.infura.io/v3/' + env.INFURA_API_KEY,
  100: 'https://rpc.gnosischain.com',
  11155111: 'https://ethereum-sepolia.publicnode.com',
}

export const BASE_PATH = join('..', 'public')
