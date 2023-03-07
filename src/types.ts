export type Version = {
  major: number;
  minor: number;
  patch: number;
};

export type Token = {
  chainId: number;
  address: string;
  name: string;
  symbol: string;
  decimals: number;
  logoURI: string;
};

export type TokenList = {
  name: string;
  timestamp: string;
  version: Version;
  logoURI: string;
  keywords: string[];
  tokens: Token[];
};
