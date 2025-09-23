import { Buffer } from "buffer";
import bs58 from "bs58";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createTransferInstruction,
  getAssociatedTokenAddress,
} from "@solana/spl-token";
import { NETWORKS, type NetKey } from "../constants";
import {
  type TokenEntry,
  type WalletCandidate,
  type WalletInfo,
} from "../type/multiSend";
import { formatTokenAmount, shortAddress } from "../utils/token";

type SolTokenMetadata = {
  name?: string;
  symbol?: string;
};

const TOKEN_METADATA_PROGRAM_ID = new PublicKey(
  "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"
);

const metadataCache = new Map<string, SolTokenMetadata | null>();

const readRustString = (buffer: Buffer, offset: number) => {
  if (buffer.length < offset + 4) {
    return { value: "", offset };
  }
  const len = buffer.readUInt32LE(offset);
  let cursor = offset + 4;
  const end = cursor + len;
  if (buffer.length < end) {
    const value = buffer
      .slice(cursor)
      .toString("utf8")
      .replace(/\0/g, "")
      .trim();
    return { value, offset: buffer.length };
  }
  const value = buffer
    .slice(cursor, end)
    .toString("utf8")
    .replace(/\0/g, "")
    .trim();
  return { value, offset: end };
};

const fetchSolTokenMetadata = async (
  conn: Connection,
  mint: PublicKey,
  appendLog: (msg: string) => void
): Promise<SolTokenMetadata | null> => {
  const key = mint.toBase58();
  if (metadataCache.has(key)) {
    return metadataCache.get(key) ?? null;
  }

  try {
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("metadata"), TOKEN_METADATA_PROGRAM_ID.toBuffer(), mint.toBuffer()],
      TOKEN_METADATA_PROGRAM_ID
    );
    const account = await conn.getAccountInfo(pda, "confirmed");
    if (!account) {
      metadataCache.set(key, null);
      return null;
    }

    const buffer = Buffer.from(account.data);
    if (buffer.length < 66) {
      metadataCache.set(key, null);
      return null;
    }

    let cursor = 1 + 32 + 32; // key + updateAuthority + mint
    const nameRes = readRustString(buffer, cursor);
    cursor = nameRes.offset;
    const symbolRes = readRustString(buffer, cursor);

    const metadata: SolTokenMetadata = {
      name: nameRes.value,
      symbol: symbolRes.value,
    };
    metadataCache.set(key, metadata);
    return metadata;
  } catch (err: any) {
    appendLog(`Không lấy được metadata cho ${key}: ${err?.message || String(err)}`);
    metadataCache.set(key, null);
    return null;
  }
};

const formatMintLabel = (mint: string, metadata: SolTokenMetadata | null | undefined) => {
  const symbol = metadata?.symbol?.trim();
  if (symbol) return symbol;
  const name = metadata?.name?.trim();
  if (name) return name;
  return shortAddress(mint, 4, 4);
};

const buildConnection = (solNet?: NetKey) => {
  const netKey = solNet ?? "mainnet";
  return new Connection(NETWORKS[netKey].rpc, "confirmed");
};

export const hydrateSolWallet = async (
  candidate: WalletCandidate,
  appendLog: (msg: string) => void
): Promise<WalletInfo> => {
  const conn = buildConnection(candidate.solNet);
  const secret = bs58.decode(candidate.privateKey.trim());
  const keypair = Keypair.fromSecretKey(secret);
  const address = keypair.publicKey.toBase58();
  const balanceLamports = BigInt(
    await conn.getBalance(keypair.publicKey, "confirmed")
  );

  const tokens: TokenEntry[] = [];
  if (balanceLamports > 0n) {
    tokens.push({
      id: `${candidate.id}-SOL`,
      kind: "native",
      symbol: "SOL",
      rawAmount: balanceLamports,
      decimals: 9,
      formatted: formatTokenAmount(balanceLamports, 9),
      selected: true,
    });
  }

  const requestedTokens = candidate.tokens.map((t) => t.trim()).filter(Boolean);
  if (requestedTokens.length > 0) {
    for (const token of requestedTokens) {
      if (token.toUpperCase() === "SOL") continue;
      try {
        const mint = new PublicKey(token);
        const parsed = await conn.getParsedTokenAccountsByOwner(
          keypair.publicKey,
          { mint },
          "confirmed"
        );
        let total = 0n;
        let decimals = 0;
        if (parsed.value.length > 0) {
          const tokenAmount = parsed.value[0].account.data.parsed.info.tokenAmount;
          decimals = tokenAmount.decimals ?? 0;
          total = BigInt(tokenAmount.amount);
        }
        if (total > 0n) {
          const metadata = await fetchSolTokenMetadata(conn, mint, appendLog);
          const label = formatMintLabel(mint.toBase58(), metadata);
          tokens.push({
            id: `${candidate.id}-${mint.toBase58()}`,
            kind: "spl",
            symbol: label,
            tokenAddress: mint.toBase58(),
            rawAmount: total,
            decimals,
            formatted: formatTokenAmount(total, decimals),
            selected: true,
          });
        } else {
          appendLog(
            `Token ${token} trong ví ${shortAddress(address)} có số dư 0 — bỏ qua.`
          );
        }
      } catch (err: any) {
        appendLog(`Không đọc được token SPL ${token}: ${err?.message || String(err)}`);
      }
    }
  } else {
    const merged = new Map<string, { amount: bigint; decimals: number }>();
    const solPrograms = [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID];
    for (const programId of solPrograms) {
      const parsed = await conn.getParsedTokenAccountsByOwner(
        keypair.publicKey,
        { programId },
        "confirmed"
      );
      parsed.value.forEach((entry) => {
        const info = entry.account.data.parsed.info;
        const mint = info.mint as string;
        const amountInfo = info.tokenAmount;
        const decimals = amountInfo.decimals ?? 0;
        const amount = BigInt(amountInfo.amount);
        const existing = merged.get(mint);
        if (existing) {
          merged.set(mint, { amount: existing.amount + amount, decimals });
        } else {
          merged.set(mint, { amount, decimals });
        }
      });
    }

    if (merged.size === 0) {
      appendLog(`Ví ${shortAddress(address)} không có token SPL nào.`);
    }

    for (const [mint, value] of merged.entries()) {
      if (value.amount <= 0n) continue;
      let metadata: SolTokenMetadata | null = null;
      try {
        metadata = await fetchSolTokenMetadata(conn, new PublicKey(mint), appendLog);
      } catch (metaErr: any) {
        appendLog(`Không lấy được metadata cho ${mint}: ${metaErr?.message || String(metaErr)}`);
      }
      const label = formatMintLabel(mint, metadata);
      tokens.push({
        id: `${candidate.id}-${mint}`,
        kind: "spl",
        symbol: label,
        tokenAddress: mint,
        rawAmount: value.amount,
        decimals: value.decimals,
        formatted: formatTokenAmount(value.amount, value.decimals),
        selected: true,
      });
    }
  }

  return {
    id: candidate.id,
    chain: "sol",
    solNet: candidate.solNet,
    privateKey: candidate.privateKey,
    rawNetwork: candidate.rawNetwork,
    address,
    displayAddress: shortAddress(address, 6, 4),
    tokens,
    loading: false,
  };
};

const sendSolNative = async (
  conn: Connection,
  owner: Keypair,
  destination: PublicKey,
  rawAmount: bigint,
  walletId: string,
  tokenId: string,
  appendLog: (msg: string) => void,
  updateBalance: (walletId: string, tokenId: string, rawAmount: bigint, decimals: number) => void
) => {
  const feeReserve = 10000n; // ~0.00001 SOL
  if (rawAmount <= feeReserve) {
    appendLog(`Ví ${owner.publicKey.toBase58()} không đủ SOL để trừ phí.`);
    return;
  }
  const lamportsToSend = rawAmount - feeReserve;
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: owner.publicKey,
      toPubkey: destination,
      lamports: Number(lamportsToSend),
    })
  );
  tx.feePayer = owner.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
  tx.sign(owner);
  appendLog(
    `Gửi ${formatTokenAmount(lamportsToSend, 9)} SOL từ ${shortAddress(
      owner.publicKey.toBase58()
    )}…`
  );
  const signature = await sendAndConfirmTransaction(conn, tx, [owner], {
    skipPreflight: false,
  });
  appendLog(`✅ Tx SOL: ${signature}`);
  updateBalance(walletId, tokenId, 0n, 9);
};

const sendSplToken = async (
  conn: Connection,
  owner: Keypair,
  destination: PublicKey,
  walletId: string,
  token: TokenEntry,
  appendLog: (msg: string) => void,
  updateBalance: (walletId: string, tokenId: string, rawAmount: bigint, decimals: number) => void
) => {
  if (!token.tokenAddress) return;
  const mint = new PublicKey(token.tokenAddress);
  const sourceAta = await getAssociatedTokenAddress(
    mint,
    owner.publicKey,
    false,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  const destAta = await getAssociatedTokenAddress(
    mint,
    destination,
    false,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  const ix: Parameters<Transaction["add"]>[0][] = [];
  const destInfo = await conn.getAccountInfo(destAta, "confirmed");
  if (!destInfo) {
    ix.push(
      createAssociatedTokenAccountInstruction(
        owner.publicKey,
        destAta,
        destination,
        mint,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      )
    );
  }
  ix.push(
    createTransferInstruction(
      sourceAta,
      destAta,
      owner.publicKey,
      token.rawAmount,
      [],
      TOKEN_PROGRAM_ID
    )
  );

  const tx = new Transaction().add(...ix);
  tx.feePayer = owner.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
  tx.sign(owner);

  appendLog(
    `Gửi ${token.formatted} ${token.symbol} (SPL) từ ${shortAddress(
      owner.publicKey.toBase58()
    )}…`
  );
  const signature = await sendAndConfirmTransaction(conn, tx, [owner], {
    skipPreflight: false,
  });
  appendLog(`✅ Tx SPL ${token.symbol}: ${signature}`);
  updateBalance(walletId, token.id, 0n, token.decimals);
};

export const sendSolanaTokens = async ({
  wallet,
  tokens,
  destination,
  appendLog,
  updateBalance,
}: {
  wallet: WalletInfo;
  tokens: TokenEntry[];
  destination: string;
  appendLog: (msg: string) => void;
  updateBalance: (walletId: string, tokenId: string, rawAmount: bigint, decimals: number) => void;
}) => {
  if (!wallet.solNet) throw new Error("Thiếu thông tin network Solana.");
  let destPubkey: PublicKey;
  try {
    destPubkey = new PublicKey(destination);
  } catch {
    appendLog(`Địa chỉ nhận không hợp lệ cho Solana: ${destination}`);
    return;
  }

  const conn = buildConnection(wallet.solNet as NetKey);
  const secret = bs58.decode(wallet.privateKey.trim());
  const owner = Keypair.fromSecretKey(secret);

  for (const token of tokens) {
    try {
      if (token.kind === "native") {
        await sendSolNative(
          conn,
          owner,
          destPubkey,
          token.rawAmount,
          wallet.id,
          token.id,
          appendLog,
          updateBalance
        );
      } else if (token.kind === "spl" && token.tokenAddress) {
        await sendSplToken(
          conn,
          owner,
          destPubkey,
          wallet.id,
          token,
          appendLog,
          updateBalance
        );
      } else {
        appendLog(`Token ${token.symbol} không hỗ trợ gửi trên Solana.`);
      }
    } catch (err: any) {
      appendLog(
        `❌ Lỗi gửi token ${token.symbol} từ ${
          wallet.displayAddress ?? wallet.address
        }: ${err?.message || String(err)}`
      );
    }
  }
};
