export const ARBITRUM_BRIDGE_ABI = [
  {
    inputs: [{ internalType: 'address', name: 'l1ERC20', type: 'address' }],
    name: 'calculateL2TokenAddress',
    outputs: [{ internalType: 'address', name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
]
