import { SupportedChainId } from '@cowprotocol/cow-sdk'
import { join } from 'node:path'
import { env } from 'node:process'

// CoW protocol contract address. Could be any address in theory for checking the token is permittable
export const SPENDER_ADDRESS = '0xC92E8bdf79f0507f65a392b0ab4667716BFE0110'

export const DEFAULT_RPC_URLS: Record<SupportedChainId, string> = {
  [SupportedChainId.MAINNET]: 'https://mainnet.infura.io/v3/' + env.INFURA_API_KEY,
  [SupportedChainId.ARBITRUM_ONE]: 'https://arbitrum.meowrpc.com',
  [SupportedChainId.BASE]: 'https://mainnet.base.org',
  [SupportedChainId.GNOSIS_CHAIN]: 'https://rpc.gnosischain.com',
  [SupportedChainId.SEPOLIA]: 'https://ethereum-sepolia.publicnode.com',
  [SupportedChainId.AVALANCHE]: 'https://api.avax.network/ext/bc/C/rpc',
  [SupportedChainId.POLYGON]: 'https://polygon-rpc.com',
}

export const BASE_PATH = join('..', 'public')
