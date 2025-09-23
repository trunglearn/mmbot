import axios from "axios";
import bs58 from "bs58";
import { Buffer } from "buffer";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  VersionedTransaction,
} from "@solana/web3.js";
import { NETWORKS, type NetKey } from "../constants";

export type PumpFunPriorityLevel = "low" | "medium" | "high" | "extreme";

export type PumpFunBuyParams = {
  network: NetKey;
  privateKey: string; // bs58
  tokenMint: string;
  amountSol: number;
  slippageBps?: number;
  priorityLevel?: PumpFunPriorityLevel;
  commitment?: "processed" | "confirmed" | "finalized";
};

export type PumpFunBuyResult = {
  signature: string;
  spentLamports: bigint;
};

const ensureAmount = (amount: number) => {
  const parsed = Number(String(amount).replace(",", "."));
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("Số lượng SOL không hợp lệ");
  }
  return parsed;
};

const buildConnection = (network: NetKey) => new Connection(NETWORKS[network].rpc, "confirmed");

export const buyTokenOnPumpFun = async (
  params: PumpFunBuyParams,
  log?: (msg: string) => void
): Promise<PumpFunBuyResult> => {
  const {
    network,
    privateKey,
    tokenMint,
    amountSol,
    slippageBps = 100,
    priorityLevel = "high",
    commitment = "confirmed",
  } = params;
  const cleanAmount = ensureAmount(amountSol);
  const lamports = BigInt(Math.floor(cleanAmount * LAMPORTS_PER_SOL));

  const conn = buildConnection(network);
  const secret = bs58.decode(privateKey.trim());
  const wallet = Keypair.fromSecretKey(secret);
  const mint = new PublicKey(tokenMint.trim());
  log?.(`👤 Wallet: ${wallet.publicKey.toBase58()}`);
  log?.(`🎯 Token: ${mint.toBase58()}`);
  log?.(`💵 Amount: ${cleanAmount} SOL (${lamports.toString()} lamports)`);
  log?.(`⚙️ Priority level: ${priorityLevel} | Slippage ${slippageBps} bps`);

  const endpoint = NETWORKS[network].pumpFunSwap;
  if (!endpoint) {
    throw new Error(`Chưa cấu hình pump.fun endpoint cho network ${network}`);
  }

  const body: Record<string, string> = {
    wallet: wallet.publicKey.toBase58(),
    type: "BUY",
    mint: mint.toBase58(),
    inAmount: lamports.toString(),
    priorityFeeLevel: priorityLevel,
    commitment,
  };
  if (slippageBps) body.slippageBps = String(slippageBps);

  log?.("📡 Gọi QuickNode Pump.fun API …");
  const response = await axios.post(endpoint, body, {
    timeout: 15000,
    headers: { "Content-Type": "application/json" },
  });
  const txBase64: string | undefined =
    response.data?.transaction ?? response.data?.result?.transaction ?? response.data?.data?.transaction;

  if (!txBase64) {
    throw new Error("Pump.fun API không trả về transaction");
  }

  const rawTx = Buffer.from(txBase64, "base64");
  const tx = VersionedTransaction.deserialize(rawTx);
  tx.sign([wallet]);

  const signature = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  log?.(`🚀 Tx gửi: ${signature}`);
  await conn.confirmTransaction(signature, "confirmed");
  log?.("✅ Đã xác nhận giao dịch");

  return { signature, spentLamports: lamports };
};
