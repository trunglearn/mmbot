import React, { useState } from "react";
import * as XLSX from "xlsx";

type WalletRow = {
  network: string;
  privateKey: string;
  token: string; // token mint or address
};

export default function MultiSend() {
  const [wallets, setWallets] = useState<WalletRow[]>([]);
  const [receiveAddress, setReceiveAddress] = useState("");
  const [log, setLog] = useState<string[]>([]);
  const [sending, setSending] = useState(false);

  const appendLog = (m: string) => setLog((l) => [...l, m]);

  const handleFile = async (file?: File) => {
    if (!file) return;
    const data = await file.arrayBuffer();
    const workbook = XLSX.read(data, { type: "array" });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const json = XLSX.utils.sheet_to_json<Record<string, any>>(sheet, { defval: "" });

    // Expect columns: network, privateKey, token
    const parsed: WalletRow[] = json.map((row: any) => ({
      network: String(row.network || row.network?.toString?.() || row.Network || row.NETWORK || "").trim(),
      privateKey: String(row.privateKey || row.privateKey?.toString?.() || row.private_key || row.PrivateKey || "").trim(),
      token: String(row.token || row.token?.toString?.() || row.tokenAddress || row.Token || "").trim(),
    }));

    setWallets(parsed.filter((w) => w.network && w.privateKey));
    appendLog(`Imported ${parsed.length} rows (kept ${parsed.filter((w) => w.network && w.privateKey).length}).`);
  };

  // Basic validation for receive address (not network-specific)
  const validateReceive = (addr: string) => addr && addr.length > 8;

  // Stub send: for each wallet row, we pretend to send token to receiveAddress.
  // Real network integration should be implemented per-chain using private keys and RPC providers.
  const handleSend = async () => {
    if (!validateReceive(receiveAddress)) {
      appendLog("Invalid receive address");
      return;
    }
    if (wallets.length === 0) {
      appendLog("No wallets to send from");
      return;
    }

    setSending(true);
    appendLog(`Starting send to ${receiveAddress} for ${wallets.length} wallets...`);

    for (let i = 0; i < wallets.length; i++) {
      const w = wallets[i];
      appendLog(`Processing [${i + 1}/${wallets.length}] network=${w.network} token=${w.token}`);

      try {
        // Here we only simulate the action. Replace with real send logic.
        await new Promise((r) => setTimeout(r, 400));
        appendLog(`SUCCESS: Sent from wallet ${w.privateKey.slice(0, 6)}... on ${w.network}`);
      } catch (err: any) {
        appendLog(`ERROR: ${err?.message || String(err)}`);
      }
    }

    appendLog("All done");
    setSending(false);
  };

  return (
    <div className="bg-white rounded-2xl shadow-2xl w-full mx-auto overflow-hidden">
      <div className="bg-green-600 text-white text-center py-4">
        <h1 className="text-xl font-semibold">Multi Wallet Send</h1>
      </div>

      <div className="p-6 space-y-6">
        <div>
          <label className="block text-sm font-medium mb-2">Import wallets (Excel or CSV) — columns: network, privateKey, token</label>
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
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium mb-2">Receive address (text)</label>
          <input
            value={receiveAddress}
            onChange={(e) => setReceiveAddress(e.target.value)}
            placeholder="Enter receive address"
            className="w-full px-4 py-3 bg-gray-50 border rounded-lg"
          />
        </div>

        <div className="flex gap-4">
          <button
            onClick={handleSend}
            disabled={sending}
            className="flex-1 bg-green-600 text-white py-3 rounded-lg"
          >
            {sending ? "Sending..." : "Send from all wallets"}
          </button>
          <button onClick={() => setLog([])} className="flex-1 bg-gray-600 text-white py-3 rounded-lg">
            Clear Logs
          </button>
        </div>

        <div>
          <h3 className="font-medium mb-2">Imported wallets</h3>
          <div className="max-h-40 overflow-auto bg-gray-50 p-2 rounded">
            {wallets.length === 0 ? (
              <div className="text-sm text-gray-500">No wallets loaded</div>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr>
                    <th className="text-left">#</th>
                    <th className="text-left">Network</th>
                    <th className="text-left">PrivateKey (masked)</th>
                    <th className="text-left">Token</th>
                  </tr>
                </thead>
                <tbody>
                  {wallets.map((w, i) => (
                    <tr key={i} className="odd:bg-white/2">
                      <td>{i + 1}</td>
                      <td>{w.network}</td>
                      <td>{w.privateKey.slice(0, 6)}...{w.privateKey.slice(-4)}</td>
                      <td>{w.token}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

        <div>
          <h3 className="font-medium mb-2">Log</h3>
          <pre className="text-xs bg-gray-50 p-3 rounded-lg whitespace-pre-wrap break-words h-40 overflow-auto">
            {log.length === 0 ? "No logs yet" : log.join("\n")}
          </pre>
        </div>
      </div>
    </div>
  );
}
