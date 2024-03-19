export const OMNIBRIDGE_CONTRACT_ABI = [{
  'inputs': [{'internalType': 'address', 'name': '_nativeToken', 'type': 'address'}],
  'name': 'bridgedTokenAddress',
  'outputs': [{'internalType': 'address', 'name': '', 'type': 'address'}],
  'stateMutability': 'view',
  'type': 'function'
}]

export const MULTICALL_ABI = [
  {
    'inputs': [
      {
        'internalType': 'bool',
        'name': 'requireSuccess',
        'type': 'bool'
      },
      {
        'components': [
          {
            'internalType': 'address',
            'name': 'target',
            'type': 'address'
          },
          {
            'internalType': 'bytes',
            'name': 'callData',
            'type': 'bytes'
          }
        ],
        'internalType': 'struct Multicall3.Call[]',
        'name': 'calls',
        'type': 'tuple[]'
      }
    ],
    'name': 'tryAggregate',
    'outputs': [
      {
        'components': [
          {
            'internalType': 'bool',
            'name': 'success',
            'type': 'bool'
          },
          {
            'internalType': 'bytes',
            'name': 'returnData',
            'type': 'bytes'
          }
        ],
        'internalType': 'struct Multicall3.Result[]',
        'name': 'returnData',
        'type': 'tuple[]'
      }
    ],
    'stateMutability': 'payable',
    'type': 'function'
  }
]

export const MULTICALL_ADDRESS = '0xca11bde05977b3631167028862be2a173976ca11'

export const OMNIBRIDGE_ADDRESS = '0xf6A78083ca3e2a662D6dd1703c939c8aCE2e268d'

export const UNISWAP_TOKENS_LIST = 'https://gateway.ipfs.io/ipns/tokens.uniswap.org'

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
