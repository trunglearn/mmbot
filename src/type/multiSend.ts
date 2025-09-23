import type { BscNet, NetKey } from "../constants";

export type ChainKind = "sol" | "bsc";

export type ParsedRow = {
  network: string;
  privateKey: string;
  token: string;
};

export type WalletCandidate = {
  id: string;
  chain: ChainKind;
  solNet?: NetKey;
  bscNet?: BscNet;
  privateKey: string;
  rawNetwork: string;
  tokens: string[];
};

export type TokenEntry = {
  id: string;
  kind: "native" | "spl" | "bep20";
  symbol: string;
  tokenAddress?: string;
  rawAmount: bigint;
  decimals: number;
  formatted: string;
  selected: boolean;
  status?: string;
};

export type WalletInfo = {
  id: string;
  chain: ChainKind;
  solNet?: NetKey;
  bscNet?: BscNet;
  privateKey: string;
  rawNetwork: string;
  address?: string;
  displayAddress?: string;
  tokens: TokenEntry[];
  loading: boolean;
  error?: string;
};

export type NetworkDescriptor =
  | { chain: "sol"; solNet: NetKey }
  | { chain: "bsc"; bscNet: BscNet };
