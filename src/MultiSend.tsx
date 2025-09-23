import React, { useCallback, useMemo, useState } from "react";
import * as XLSX from "xlsx";
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
  createAssociatedTokenAccountInstruction,
  createTransferInstruction,
  getAssociatedTokenAddress,
} from "@solana/spl-token";
import { Web3 } from "web3";
import { BSC_ENDPOINTS, BscNet, ERC20_ABI, NETWORKS, NetKey } from "./constants";

type ChainKind = "sol" | "bsc";

type ParsedRow = {
  network: string;
  privateKey: string;
  token: string;
};

type WalletCandidate = {
  id: string;
  chain: ChainKind;
  solNet?: NetKey;
  bscNet?: BscNet;
  privateKey: string;
  rawNetwork: string;
  tokens: string[];
};

type TokenEntry = {
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

type WalletInfo = {
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

type NetworkDescriptor =
  | { chain: "sol"; solNet: NetKey }
  | { chain: "bsc"; bscNet: BscNet };

const formatTokenAmount = (amount: bigint, decimals: number, precision = 6) => {
  if (amount === 0n) return "0";
  if (decimals === 0) return amount.toString();
  const negative = amount < 0n;
  const absAmount = negative ? -amount : amount;
  const base = 10n ** BigInt(decimals);
  const integerPart = absAmount / base;
  let fractionPart = absAmount % base;
  if (fractionPart === 0n) {
    return `${negative ? "-" : ""}${integerPart.toString()}`;
  }
  const fractionStrRaw = fractionPart.toString().padStart(decimals, "0");
  const fractionStr = fractionStrRaw.slice(0, precision).replace(/0+$/, "");
  return `${negative ? "-" : ""}${integerPart.toString()}${fractionStr ? "." + fractionStr : ""}`;
};

const shortAddress = (addr: string, head = 6, tail = 4) => {
  if (addr.length <= head + tail + 3) return addr;
  return `${addr.slice(0, head)}...${addr.slice(-tail)}`;
};

const classifyNetwork = (raw: string): NetworkDescriptor | null => {
  const normalized = (raw || "").trim().toLowerCase();
  if (!normalized) return null;
  if (normalized.includes("sol")) {
    const solNet: NetKey = normalized.includes("dev") ? "devnet" : "mainnet";
    return { chain: "sol", solNet };
  }
  if (normalized.includes("bsc") || normalized.includes("bnb")) {
    const bscNet: BscNet = normalized.includes("test") || normalized.includes("chapel") ? "testnet" : "mainnet";
    return { chain: "bsc", bscNet };
  }
  return null;
};

const normalizeEvmPrivateKey = (raw: string) => {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("Private key trống");
  const prefixed = trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(prefixed)) {
    throw new Error("Private key BSC phải là hex 64 ký tự (có/không '0x').");
  }
  return prefixed as `0x${string}`;
};

const uniqueTokens = (tokens: string[]) => {
  const set = new Set(tokens.map((t) => t.trim()).filter(Boolean));
  return Array.from(set);
};

export default function MultiSend() {
  const [wallets, setWallets] = useState<WalletInfo[]>([]);
  const [receiveAddress, setReceiveAddress] = useState("");
  const [log, setLog] = useState<string[]>([]);
  const [sending, setSending] = useState(false);

  const appendLog = useCallback((entry: string) => {
    setLog((prev) => [...prev, entry]);
  }, []);

  const resetState = () => {
    setWallets([]);
    setLog([]);
  };

  const buildCandidates = (rows: ParsedRow[]): WalletCandidate[] => {
    const grouped = new Map<string, WalletCandidate>();

    rows.forEach((row, idx) => {
      const descriptor = classifyNetwork(row.network);
      if (!descriptor) {
        appendLog(`Bỏ qua dòng ${idx + 1}: network '${row.network}' không hỗ trợ.`);
        return;
      }
      const key =
        descriptor.chain === "sol"
          ? `${descriptor.chain}:${descriptor.solNet}:${row.privateKey.trim()}`
          : `${descriptor.chain}:${descriptor.bscNet}:${row.privateKey.trim()}`;
      const existing = grouped.get(key);
      if (existing) {
        existing.tokens.push(row.token);
      } else {
        grouped.set(key, {
          id: key,
          chain: descriptor.chain,
          solNet: descriptor.chain === "sol" ? descriptor.solNet : undefined,
          bscNet: descriptor.chain === "bsc" ? descriptor.bscNet : undefined,
          privateKey: row.privateKey.trim(),
          rawNetwork: row.network,
          tokens: row.token ? [row.token] : [],
        });
      }
    });

    return Array.from(grouped.values()).map((candidate) => ({
      ...candidate,
      tokens: uniqueTokens(candidate.tokens),
    }));
  };

  const handleFile = async (file?: File) => {
    if (!file) return;
    try {
      const data = await file.arrayBuffer();
      const workbook = XLSX.read(data, { type: "array" });
      const sheetName = workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];
      const json = XLSX.utils.sheet_to_json<Record<string, any>>(sheet, { defval: "" });

      const rows: ParsedRow[] = json.map((row) => ({
        network: String(
          row.network ??
            row.Network ??
            row.NETWORK ??
            row.chain ??
            row.Chain ??
            row.CHANNEL ??
            ""
        ).trim(),
        privateKey: String(
          row.privateKey ??
            row.private_key ??
            row.PrivateKey ??
            row.privateKeyHex ??
            row.Private_Key ??
            ""
        ).trim(),
        token: String(
          row.token ??
            row.tokenAddress ??
            row.Token ??
            row.TokenAddress ??
            row.contract ??
            ""
        ).trim(),
      }));

      const filtered = rows.filter((r) => r.privateKey && r.network);
      if (!filtered.length) {
        appendLog("Không tìm thấy dòng hợp lệ trong file.");
        return;
      }

      const candidates = buildCandidates(filtered);
      if (!candidates.length) {
        appendLog("Không có ví nào được import sau khi nhóm theo network/private key.");
        return;
      }

      setWallets(
        candidates.map((cand) => ({
          id: cand.id,
          chain: cand.chain,
          solNet: cand.solNet,
          bscNet: cand.bscNet,
          privateKey: cand.privateKey,
          rawNetwork: cand.rawNetwork,
          tokens: [],
          loading: true,
        }))
      );
      appendLog(`Imported ${filtered.length} dòng (gộp thành ${candidates.length} ví).`);

      for (let i = 0; i < candidates.length; i++) {
        const candidate = candidates[i];
        try {
          const hydrated = await hydrateWallet(candidate);
          setWallets((prev) => {
            const copy = [...prev];
            const idx = copy.findIndex((w) => w.id === candidate.id);
            if (idx !== -1) {
              copy[idx] = hydrated;
            }
            return copy;
          });
          appendLog(
            `Ví ${hydrated.displayAddress ?? hydrated.address ?? "?"} (${candidate.rawNetwork}) tải thành công ${hydrated.tokens.length} token.`
          );
        } catch (err: any) {
          const message = err?.message || String(err);
          appendLog(`❌ Không thể tải ví ${candidate.privateKey.slice(0, 6)}...: ${message}`);
          setWallets((prev) => {
            const copy = [...prev];
            const idx = copy.findIndex((w) => w.id === candidate.id);
            if (idx !== -1) {
              copy[idx] = { ...copy[idx], loading: false, error: message };
            }
            return copy;
          });
        }
      }
    } catch (err: any) {
      appendLog(`Lỗi đọc file: ${err?.message || String(err)}`);
    }
  };

  const hydrateWallet = async (candidate: WalletCandidate): Promise<WalletInfo> => {
    if (candidate.chain === "sol") {
      return hydrateSolWallet(candidate);
    }
    return hydrateBscWallet(candidate);
  };

  const hydrateSolWallet = async (candidate: WalletCandidate): Promise<WalletInfo> => {
    const netKey = candidate.solNet ?? "mainnet";
    const conn = new Connection(NETWORKS[netKey].rpc, "confirmed");
    const secret = bs58.decode(candidate.privateKey.trim());
    const keypair = Keypair.fromSecretKey(secret);
    const address = keypair.publicKey.toBase58();
    const balanceLamports = BigInt(await conn.getBalance(keypair.publicKey, "confirmed"));

    const tokens: TokenEntry[] = [];
    tokens.push({
      id: `${candidate.id}-SOL`,
      kind: "native",
      symbol: "SOL",
      rawAmount: balanceLamports,
      decimals: 9,
      formatted: formatTokenAmount(balanceLamports, 9),
      selected: balanceLamports > 0n,
    });

    for (const token of candidate.tokens) {
      try {
        const mint = new PublicKey(token);
        const parsed = await conn.getParsedTokenAccountsByOwner(keypair.publicKey, { mint }, "confirmed");
        let total = 0n;
        let decimals = 0;
        if (parsed.value.length > 0) {
          const tokenAmount = parsed.value[0].account.data.parsed.info.tokenAmount;
          decimals = tokenAmount.decimals ?? 0;
          total = BigInt(tokenAmount.amount);
        }
        const formatted = decimals >= 0 ? formatTokenAmount(total, decimals) : total.toString();
        tokens.push({
          id: `${candidate.id}-${mint.toBase58()}`,
          kind: "spl",
          symbol: shortAddress(mint.toBase58(), 4, 4),
          tokenAddress: mint.toBase58(),
          rawAmount: total,
          decimals,
          formatted,
          selected: total > 0n,
          status: parsed.value.length === 0 ? "Không có token account" : undefined,
        });
      } catch (err: any) {
        appendLog(`Không đọc được token SPL ${token}: ${err?.message || String(err)}`);
      }
    }

    return {
      id: candidate.id,
      chain: "sol",
      solNet: netKey,
      privateKey: candidate.privateKey,
      rawNetwork: candidate.rawNetwork,
      address,
      displayAddress: shortAddress(address, 6, 4),
      tokens,
      loading: false,
    };
  };

  const hydrateBscWallet = async (candidate: WalletCandidate): Promise<WalletInfo> => {
    const netKey = candidate.bscNet ?? "mainnet";
    const cfg = BSC_ENDPOINTS[netKey];
    const priv = normalizeEvmPrivateKey(candidate.privateKey);
    const web3 = new Web3(cfg.rpc);
    const account = web3.eth.accounts.privateKeyToAccount(priv);
    const address = Web3.utils.toChecksumAddress(account.address);
    const balanceWei = BigInt(await web3.eth.getBalance(address));

    const tokens: TokenEntry[] = [
      {
        id: `${candidate.id}-BNB`,
        kind: "native",
        symbol: "BNB",
        rawAmount: balanceWei,
        decimals: 18,
        formatted: formatTokenAmount(balanceWei, 18),
        selected: balanceWei > 0n,
      },
    ];

    for (const token of candidate.tokens) {
      try {
        if (!Web3.utils.isAddress(token)) {
          appendLog(`Token ${token} không phải địa chỉ BEP-20 hợp lệ.`);
          continue;
        }
        const checksum = Web3.utils.toChecksumAddress(token);
        const contract = new web3.eth.Contract(ERC20_ABI as any, checksum);
        const [symbol, decimalsStr, balanceStr] = await Promise.all([
          contract.methods.symbol().call().catch(() => shortAddress(checksum, 4, 4)),
          contract.methods.decimals().call().catch(() => "18"),
          contract.methods.balanceOf(address).call().catch(() => "0"),
        ]);
        const decimals = Number(decimalsStr) || 0;
        const balanceBig = BigInt(balanceStr);
        tokens.push({
          id: `${candidate.id}-${checksum}`,
          kind: "bep20",
          symbol,
          tokenAddress: checksum,
          rawAmount: balanceBig,
          decimals,
          formatted: formatTokenAmount(balanceBig, decimals),
          selected: balanceBig > 0n,
        });
      } catch (err: any) {
        appendLog(`Không thể đọc token ${token} trên BSC: ${err?.message || String(err)}`);
      }
    }

    return {
      id: candidate.id,
      chain: "bsc",
      bscNet: netKey,
      privateKey: candidate.privateKey,
      rawNetwork: candidate.rawNetwork,
      address,
      displayAddress: shortAddress(address, 6, 4),
      tokens,
      loading: false,
    };
  };

  const toggleTokenSelection = (walletId: string, tokenId: string, selected: boolean) => {
    setWallets((prev) =>
      prev.map((wallet) => {
        if (wallet.id !== walletId) return wallet;
        const tokens = wallet.tokens.map((token) =>
          token.id === tokenId ? { ...token, selected } : token
        );
        return { ...wallet, tokens };
      })
    );
  };

  const toggleAllTokens = (walletId: string, selected: boolean) => {
    setWallets((prev) =>
      prev.map((wallet) => {
        if (wallet.id !== walletId) return wallet;
        return {
          ...wallet,
          tokens: wallet.tokens.map((token) => ({ ...token, selected })),
        };
      })
    );
  };

  const selectedCount = useMemo(() => {
    return wallets
      .map((w) => w.tokens.filter((t) => t.selected && t.rawAmount > 0n).length)
      .reduce((a, b) => a + b, 0);
  }, [wallets]);

  const handleSend = async () => {
    if (sending) return;
    if (!wallets.length) {
      appendLog("Chưa có ví nào để gửi.");
      return;
    }
    const trimmedReceive = receiveAddress.trim();
    if (!trimmedReceive) {
      appendLog("Vui lòng nhập địa chỉ nhận.");
      return;
    }
    if (selectedCount === 0) {
      appendLog("Không có token nào được chọn để gửi.");
      return;
    }

    setSending(true);
    appendLog(`Bắt đầu gửi tới ${trimmedReceive} (${selectedCount} token).`);

    for (const wallet of wallets) {
      const activeTokens = wallet.tokens.filter((t) => t.selected && t.rawAmount > 0n);
      if (!activeTokens.length) continue;

      try {
        if (wallet.chain === "sol") {
          await sendSolTokens(wallet, activeTokens, trimmedReceive);
        } else {
          await sendBscTokens(wallet, activeTokens, trimmedReceive);
        }
      } catch (err: any) {
        appendLog(`❌ Lỗi khi gửi từ ví ${wallet.displayAddress ?? wallet.address}: ${err?.message || String(err)}`);
      }
    }

    appendLog("Hoàn tất tiến trình gửi.");
    setSending(false);
  };

  const sendSolTokens = async (wallet: WalletInfo, tokens: TokenEntry[], destination: string) => {
    if (!wallet.solNet) throw new Error("Thiếu thông tin network Solana.");
    let destPubkey: PublicKey;
    try {
      destPubkey = new PublicKey(destination);
    } catch {
      appendLog(`Địa chỉ nhận không hợp lệ cho Solana: ${destination}`);
      return;
    }

    const conn = new Connection(NETWORKS[wallet.solNet].rpc, "confirmed");
    const secret = bs58.decode(wallet.privateKey.trim());
    const owner = Keypair.fromSecretKey(secret);

    for (const token of tokens) {
      try {
        if (token.kind === "native") {
          await sendSolNative(conn, owner, destPubkey, token.rawAmount, wallet.id, token.id);
        } else if (token.kind === "spl" && token.tokenAddress) {
          await sendSplToken(conn, owner, destPubkey, wallet.id, token);
        } else {
          appendLog(`Token ${token.symbol} không hỗ trợ gửi trên Solana.`);
        }
      } catch (err: any) {
        appendLog(
          `❌ Lỗi gửi token ${token.symbol} từ ${wallet.displayAddress ?? wallet.address}: ${
            err?.message || String(err)
          }`
        );
      }
    }
  };

  const sendSolNative = async (
    conn: Connection,
    owner: Keypair,
    destination: PublicKey,
    rawAmount: bigint,
    walletId: string,
    tokenId: string
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
      `Gửi ${formatTokenAmount(lamportsToSend, 9)} SOL từ ${shortAddress(owner.publicKey.toBase58())}…`
    );
    const signature = await sendAndConfirmTransaction(conn, tx, [owner], { skipPreflight: false });
    appendLog(`✅ Tx SOL: ${signature}`);
    updateTokenBalance(walletId, tokenId, 0n, 9);
  };

  const sendSplToken = async (
    conn: Connection,
    owner: Keypair,
    destination: PublicKey,
    walletId: string,
    token: TokenEntry
  ) => {
    if (!token.tokenAddress) return;
    const mint = new PublicKey(token.tokenAddress);
    const sourceAta = await getAssociatedTokenAddress(mint, owner.publicKey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
    const destAta = await getAssociatedTokenAddress(mint, destination, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);

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
    ix.push(createTransferInstruction(sourceAta, destAta, owner.publicKey, token.rawAmount, [], TOKEN_PROGRAM_ID));

    const tx = new Transaction().add(...ix);
    tx.feePayer = owner.publicKey;
    tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
    tx.sign(owner);

    appendLog(`Gửi ${token.formatted} ${token.symbol} (SPL) từ ${shortAddress(owner.publicKey.toBase58())}…`);
    const signature = await sendAndConfirmTransaction(conn, tx, [owner], { skipPreflight: false });
    appendLog(`✅ Tx SPL ${token.symbol}: ${signature}`);
    updateTokenBalance(walletId, token.id, 0n, token.decimals);
  };

  const sendBscTokens = async (wallet: WalletInfo, tokens: TokenEntry[], destination: string) => {
    if (!wallet.bscNet) throw new Error("Thiếu thông tin network BSC.");
    if (!Web3.utils.isAddress(destination)) {
      appendLog(`Địa chỉ nhận không hợp lệ cho BSC: ${destination}`);
      return;
    }
    const cfg = BSC_ENDPOINTS[wallet.bscNet];
    const priv = normalizeEvmPrivateKey(wallet.privateKey);
    const web3 = new Web3(cfg.rpc);
    const account = web3.eth.accounts.privateKeyToAccount(priv);

    for (const token of tokens) {
      try {
        if (token.kind === "native") {
          await sendBnb(web3, account, destination, cfg.chainId, wallet.id, token.id, token.rawAmount);
        } else if (token.kind === "bep20" && token.tokenAddress) {
          await sendBep20Token(web3, account, destination, cfg.chainId, wallet.id, token);
        } else {
          appendLog(`Token ${token.symbol} không hỗ trợ gửi trên BSC.`);
        }
      } catch (err: any) {
        appendLog(
          `❌ Lỗi gửi token ${token.symbol} từ ${wallet.displayAddress ?? wallet.address}: ${
            err?.message || String(err)
          }`
        );
      }
    }
  };

  const sendBnb = async (
    web3: Web3,
    account: any,
    destination: string,
    chainId: number,
    walletId: string,
    tokenId: string,
    rawAmount: bigint
  ) => {
    const gasPrice = BigInt(await web3.eth.getGasPrice());
    const gasLimit = 21000n;
    const fee = gasPrice * gasLimit;
    if (rawAmount <= fee) {
      appendLog(`Ví ${account.address} không đủ BNB để trả phí gas.`);
      return;
    }
    const value = rawAmount - fee;
    const nonce = await web3.eth.getTransactionCount(account.address, "pending");

    const tx = {
      to: destination,
      value: `0x${value.toString(16)}`,
      gas: `0x${gasLimit.toString(16)}`,
      gasPrice: `0x${gasPrice.toString(16)}`,
      nonce: `0x${nonce.toString(16)}`,
      chainId,
    } as const;

    appendLog(`Gửi ${formatTokenAmount(value, 18)} BNB từ ${shortAddress(account.address)}…`);
    const signed = await account.signTransaction(tx);
    if (!signed.rawTransaction) throw new Error("Không ký được giao dịch BNB.");
    const receipt = await web3.eth.sendSignedTransaction(signed.rawTransaction);
    appendLog(`✅ Tx BNB: ${receipt.transactionHash}`);
    updateTokenBalance(walletId, tokenId, 0n, 18);
  };

  const sendBep20Token = async (
    web3: Web3,
    account: any,
    destination: string,
    chainId: number,
    walletId: string,
    token: TokenEntry
  ) => {
    if (!token.tokenAddress) return;
    const contract = new web3.eth.Contract(ERC20_ABI as any, token.tokenAddress);
    const data = contract.methods.transfer(destination, token.rawAmount.toString()).encodeABI();
    let gas: bigint;
    try {
      const estimated = await contract.methods.transfer(destination, token.rawAmount.toString()).estimateGas({
        from: account.address,
      });
      gas = BigInt(estimated) + 10000n; // buffer
    } catch {
      gas = 150000n;
    }
    const gasPrice = BigInt(await web3.eth.getGasPrice());
    const nonce = await web3.eth.getTransactionCount(account.address, "pending");
    const tx = {
      to: token.tokenAddress,
      data,
      value: "0x0",
      gas: `0x${gas.toString(16)}`,
      gasPrice: `0x${gasPrice.toString(16)}`,
      nonce: `0x${nonce.toString(16)}`,
      chainId,
    } as const;
    appendLog(`Gửi ${token.formatted} ${token.symbol} từ ${shortAddress(account.address)}…`);
    const signed = await account.signTransaction(tx);
    if (!signed.rawTransaction) throw new Error("Không ký được giao dịch token.");
    const receipt = await web3.eth.sendSignedTransaction(signed.rawTransaction);
    appendLog(`✅ Tx ${token.symbol}: ${receipt.transactionHash}`);
    updateTokenBalance(walletId, token.id, 0n, token.decimals);
  };

  const updateTokenBalance = (walletId: string, tokenId: string, rawAmount: bigint, decimals: number) => {
    setWallets((prev) =>
      prev.map((wallet) => {
        if (wallet.id !== walletId) return wallet;
        return {
          ...wallet,
          tokens: wallet.tokens.map((token) =>
            token.id === tokenId
              ? {
                  ...token,
                  rawAmount,
                  formatted: formatTokenAmount(rawAmount, decimals),
                  selected: rawAmount > 0n ? token.selected : false,
                }
              : token
          ),
        };
      })
    );
  };

  return (
    <div className="bg-white rounded-2xl shadow-2xl w-full mx-auto overflow-hidden">
      <div className="bg-green-600 text-white text-center py-4">
        <h1 className="text-xl font-semibold">Multi Wallet Send</h1>
      </div>

      <div className="p-6 space-y-6">
        <div>
          <label className="block text-sm font-medium mb-2">
            Import wallets (Excel/CSV) — yêu cầu cột: network, privateKey, token (token optional)
          </label>
          <div className="flex items-center gap-3">
            <input
              type="file"
              accept=".xlsx,.xls,.csv"
              onChange={(e) => handleFile(e.target.files?.[0])}
              className="text-sm"
            />
            <button
              type="button"
              onClick={() => {
                const headers = ["network", "privateKey", "token"];
                const sample = ["bsc", "0xYOUR_PRIVATE_KEY", "0xTOKEN_ADDRESS"];
                const csv = [headers.join(","), sample.join(",")].join("\n");
                const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = "wallets-template.csv";
                a.click();
                URL.revokeObjectURL(url);
              }}
              className="px-3 py-2 bg-gray-200 rounded text-sm"
            >
              Download template
            </button>
            <button
              type="button"
              onClick={resetState}
              className="px-3 py-2 bg-gray-100 rounded text-sm"
            >
              Reset
            </button>
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium mb-2">Receive address</label>
          <input
            value={receiveAddress}
            onChange={(e) => setReceiveAddress(e.target.value)}
            placeholder="Địa chỉ ví nhận (Solana hoặc BSC)"
            className="w-full px-4 py-3 bg-gray-50 border rounded-lg"
          />
        </div>

        <div className="flex gap-4">
          <button
            onClick={handleSend}
            disabled={sending}
            className="flex-1 bg-green-600 text-white py-3 rounded-lg disabled:opacity-60"
          >
            {sending ? "Đang gửi..." : `Send selected (${selectedCount})`}
          </button>
          <button onClick={() => setLog([])} className="flex-1 bg-gray-600 text-white py-3 rounded-lg">
            Clear Logs
          </button>
        </div>

        <div>
          <h3 className="font-medium mb-2">Imported wallets</h3>
          <div className="max-h-64 overflow-auto bg-gray-50 p-3 rounded space-y-3">
            {wallets.length === 0 ? (
              <div className="text-sm text-gray-500">Chưa có ví nào được import</div>
            ) : (
              wallets.map((wallet) => (
                <div key={wallet.id} className="bg-white rounded-lg border shadow-sm p-4 space-y-3">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="text-sm font-semibold text-gray-800">
                        {wallet.rawNetwork} · {wallet.chain.toUpperCase()}
                      </div>
                      <div className="text-xs text-gray-500 break-all">
                        {wallet.address ? wallet.address : wallet.loading ? "Đang tải..." : "Không xác định"}
                      </div>
                    </div>
                    <div className="text-xs text-right">
                      {wallet.loading && <div className="text-amber-600">Loading...</div>}
                      {wallet.error && <div className="text-red-600">{wallet.error}</div>}
                      {!wallet.loading && !wallet.error && (
                        <button
                          type="button"
                          onClick={() => toggleAllTokens(wallet.id, true)}
                          className="text-green-600 hover:underline mr-2"
                        >
                          Chọn hết
                        </button>
                      )}
                      {!wallet.loading && !wallet.error && (
                        <button
                          type="button"
                          onClick={() => toggleAllTokens(wallet.id, false)}
                          className="text-gray-500 hover:underline"
                        >
                          Bỏ chọn
                        </button>
                      )}
                    </div>
                  </div>
                  {wallet.tokens.length === 0 ? (
                    <div className="text-xs text-gray-500">Không có token.</div>
                  ) : (
                    <div className="space-y-2">
                      {wallet.tokens.map((token) => (
                        <label
                          key={token.id}
                          className={`flex items-start gap-3 rounded border p-2 ${
                            token.rawAmount === 0n ? "opacity-60" : ""
                          }`}
                        >
                          <input
                            type="checkbox"
                            className="mt-1"
                            checked={token.selected}
                            onChange={(e) => toggleTokenSelection(wallet.id, token.id, e.target.checked)}
                            disabled={wallet.loading || !!wallet.error || token.rawAmount === 0n}
                          />
                          <div className="flex-1">
                            <div className="text-sm font-medium text-gray-800">
                              {token.symbol} {token.tokenAddress ? `· ${shortAddress(token.tokenAddress, 4, 4)}` : ""}
                            </div>
                            <div className="text-xs text-gray-600">
                              Balance: {token.formatted}
                            </div>
                            {token.status && <div className="text-xs text-gray-400">{token.status}</div>}
                          </div>
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        </div>

        <div>
          <h3 className="font-medium mb-2">Log</h3>
          <pre className="text-xs bg-gray-50 p-3 rounded-lg whitespace-pre-wrap break-words h-48 overflow-auto">
            {log.length === 0 ? "No logs yet" : log.join("\n")}
          </pre>
        </div>
      </div>
    </div>
  );
}
