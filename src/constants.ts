// Shared constants and ABIs for SOL and BSC swaps
import { PublicKey } from "@solana/web3.js";
import { API_URLS } from "@raydium-io/raydium-sdk-v2";

export const NETWORKS = {
  mainnet: {
    rpc: "https://necessary-cool-waterfall.solana-mainnet.quiknode.pro/f965569b37ae159010d579b803fdbcb2042f4091",
    raydiumProgram: new PublicKey("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8"),
    solscanBase: "https://solscan.io",
    swapHost: "https://transaction-v1.raydium.io",
    feeEndpoint: `${API_URLS.BASE_HOST}${API_URLS.PRIORITY_FEE}`,
    explorerClusterQS: "",
    pumpFunSwap: "https://necessary-cool-waterfall.solana-mainnet.quiknode.pro/pump-fun/swap",
  },
  devnet: {
    rpc: "https://necessary-cool-waterfall.solana-devnet.quiknode.pro/f965569b37ae159010d579b803fdbcb2042f4091",
    raydiumProgram: new PublicKey("DRaya7Kj3aMWQSy19kSjvmuwq9docCHofyP9kanQGaav"),
    solscanBase: "https://solscan.io",
    swapHost: "https://transaction-v1-devnet.raydium.io",
    feeEndpoint: `${API_URLS.BASE_HOST}${API_URLS.PRIORITY_FEE}`,
    explorerClusterQS: "?cluster=devnet",
    pumpFunSwap: "https://necessary-cool-waterfall.solana-devnet.quiknode.pro/pump-fun/swap",
  },
} as const;
export type NetKey = keyof typeof NETWORKS;

export const DATASIZE_V4 = 752;
export const OFF_BASE = 400;
export const OFF_QUOTE = 432;
export const SOL_PSEUDO_MINT = "So11111111111111111111111111111111111111112";
export const TOKEN_ACC_SIZE = 165;

export const BSC_ENDPOINTS = {
  mainnet: {
    rpc: "https://necessary-cool-waterfall.bsc.quiknode.pro/f965569b37ae159010d579b803fdbcb2042f4091",
    routerV2: "0x10ED43C718714eb63d5aA57B78B54704E256024E",
    factoryV2: "0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73",
    wbnb: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
    chainId: 56,
    explorer: "https://bscscan.com",
  },
  testnet: {
    rpc: "https://necessary-cool-waterfall.bsc-testnet.quiknode.pro/f965569b37ae159010d579b803fdbcb2042f4091",
    routerV2: "0xD99D1c33F9fC3444f8101754aBC46c52416550D1",
    factoryV2: "0x6725F303b657a9451d8BA641348b6761A6CC7a17",
    wbnb: "0xae13d989dac2f0debff460ac112a837c89baa7cd",
    chainId: 97,
    explorer: "https://testnet.bscscan.com",
  },
} as const;
export type BscNet = keyof typeof BSC_ENDPOINTS;

export const ERC20_ABI = [
  { constant: true, inputs: [], name: "decimals", outputs: [{ name: "", type: "uint8" }], stateMutability: "view", type: "function" },
  { constant: true, inputs: [], name: "symbol", outputs: [{ name: "", type: "string" }], stateMutability: "view", type: "function" },
  { constant: true, inputs: [{ name: "owner", type: "address" }], name: "balanceOf", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" },
] as const;

export const FACTORY_V2_ABI = [
  { constant: true, inputs: [{ name: "tokenA", type: "address" }, { name: "tokenB", type: "address" }], name: "getPair", outputs: [{ name: "pair", type: "address" }], stateMutability: "view", type: "function" },
] as const;

export const ROUTER_V2_ABI = [
  { constant: true, inputs: [{ name: "amountIn", type: "uint256" }, { name: "path", type: "address[]" }], name: "getAmountsOut", outputs: [{ name: "amounts", type: "uint256[]" }], stateMutability: "view", type: "function" },
  { constant: false, inputs: [{ name: "amountOutMin", type: "uint256" }, { name: "path", type: "address[]" }, { name: "to", type: "address" }, { name: "deadline", type: "uint256" }], name: "swapExactETHForTokensSupportingFeeOnTransferTokens", outputs: [], stateMutability: "payable", type: "function" },
] as const;

export const SUI_NETWORKS = {
  mainnet: {
    // QuickNode mainnet (bạn cung cấp)
    rpc: "https://necessary-cool-waterfall.sui-mainnet.quiknode.pro/f965569b37ae159010d579b803fdbcb2042f4091",
    explorerTx: (digest: string) => `https://suivision.xyz/txblock/${digest}`,
  },
  testnet: {
    // Testnet: QuickNode không hỗ trợ → dùng public
    rpc: "https://fullnode.testnet.sui.io:443",
    explorerTx: (digest: string) => `https://suivision.xyz/txblock/${digest}?network=testnet`,
  },
} as const;
export type SuiNetKey = keyof typeof SUI_NETWORKS;

export const SUI_COIN_TYPE = "0x2::sui::SUI";
