import React, { useCallback, useMemo, useState } from "react";
import * as XLSX from "xlsx";
import { type BscNet, type NetKey } from "./constants";
import type {
  NetworkDescriptor,
  ParsedRow,
  TokenEntry,
  WalletCandidate,
  WalletInfo,
} from "./type/multiSend";
import { formatTokenAmount, shortAddress, uniqueTokens } from "./utils/token";
import { hydrateSolWallet, sendSolanaTokens } from "./solana/solanaMultiSendService";
import { hydrateBscWallet, sendBscTokens } from "./bsc/bscMultiSendService";

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
      return hydrateSolWallet(candidate, appendLog);
    }
    return hydrateBscWallet(candidate, appendLog);
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
          await sendSolanaTokens({
            wallet,
            tokens: activeTokens,
            destination: trimmedReceive,
            appendLog,
            updateBalance: updateTokenBalance,
          });
        } else {
          await sendBscTokens({
            wallet,
            tokens: activeTokens,
            destination: trimmedReceive,
            appendLog,
            updateBalance: updateTokenBalance,
          });
        }
      } catch (err: any) {
        appendLog(`❌ Lỗi khi gửi từ ví ${wallet.displayAddress ?? wallet.address}: ${err?.message || String(err)}`);
      }
    }

    appendLog("Hoàn tất tiến trình gửi.");
    setSending(false);
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
