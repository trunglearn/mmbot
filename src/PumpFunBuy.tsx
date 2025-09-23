import React, { useMemo, useRef, useState } from "react";
import * as XLSX from "xlsx";
import bs58 from "bs58";
import { Eye, EyeOff, FileDown, Upload, Play, Pause, Trash2 } from "lucide-react";
import { type NetKey } from "./constants";
import { buyTokenOnPumpFun, type PumpFunPriorityLevel } from "./solana/pumpFunClient";
import { shortAddress } from "./utils/token";

const DEFAULT_SLIPPAGE_BPS = 100;
const DEFAULT_PRIORITY_LEVEL: PumpFunPriorityLevel = "high";

type BatchRow = {
  privateKey: string;
  amount: number;
  memo?: string;
};

type BatchState = {
  rows: BatchRow[];
  idx: number;
  success: number;
  failed: number;
};

const createTemplate = () => {
  const headers = ["privateKey", "amount", "memo"];
  const sample = ["<bs58_private_key>", "0.05", "optional note"];
  const csv = [headers.join(","), sample.join(",")].join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "pumpfun-template.csv";
  a.click();
  URL.revokeObjectURL(url);
};

const parseAmount = (value: string | number) => {
  const num = Number(String(value).replace(",", "."));
  return Number.isFinite(num) ? num : NaN;
};

function PumpFunBuy() {
  const [network, setNetwork] = useState<NetKey>("mainnet");
  const [tokenMint, setTokenMint] = useState("");
  const [singlePrivateKey, setSinglePrivateKey] = useState("");
  const [singleAmount, setSingleAmount] = useState("0.01");
  const [showPk, setShowPk] = useState(false);

  const [slippageBps, setSlippageBps] = useState(DEFAULT_SLIPPAGE_BPS.toString());
  const [priorityLevel, setPriorityLevel] = useState<PumpFunPriorityLevel>(DEFAULT_PRIORITY_LEVEL);

  const [logLines, setLogLines] = useState<string[]>([]);
  const appendLog = (line: string) => setLogLines((prev) => [...prev, line]);
  const clearLog = () => setLogLines([]);

  const [batch, setBatch] = useState<BatchState>({ rows: [], idx: 0, success: 0, failed: 0 });
  const [batchRunning, setBatchRunning] = useState(false);
  const pauseRef = useRef(false);

  const selectedSummary = useMemo(() => {
    if (!batch.rows.length) return "";
    return `${batch.rows.length} wallets | Thành công: ${batch.success} · Thất bại: ${batch.failed}`;
  }, [batch]);

  const validateInputs = () => {
    if (tokenMint.trim().length === 0) {
      throw new Error("Vui lòng nhập địa chỉ token (mint pump.fun)");
    }
    try {
      bs58.decode(singlePrivateKey.trim());
    } catch {
      throw new Error("Private key không phải định dạng bs58");
    }
  };

  const handleSingleBuy = async () => {
    try {
      clearLog();
      validateInputs();
      const amount = Number(singleAmount.replace(",", "."));
      if (!Number.isFinite(amount) || amount <= 0) {
        throw new Error("Số lượng SOL không hợp lệ");
      }
      appendLog("🚀 Bắt đầu mua 1 ví …");
      const res = await buyTokenOnPumpFun(
        {
          network,
          privateKey: singlePrivateKey.trim(),
          tokenMint: tokenMint.trim(),
          amountSol: amount,
          slippageBps: Number(slippageBps) || DEFAULT_SLIPPAGE_BPS,
          priorityLevel,
        },
        (msg) => appendLog(msg)
      );
      appendLog(`🎉 Hoàn tất. Tx: ${res.signature}`);
    } catch (err: any) {
      appendLog(`❌ Lỗi: ${err?.message || String(err)}`);
    }
  };

  const handleFileUpload = async (file?: File) => {
    if (!file) return;
    try {
      const buffer = await file.arrayBuffer();
      const workbook = XLSX.read(buffer, { type: "array" });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json<Record<string, any>>(sheet, { defval: "" });
      const parsed: BatchRow[] = rows
        .map((row) => ({
          privateKey: String(row.privateKey ?? row.PrivateKey ?? "").trim(),
          amount: parseAmount(row.amount ?? row.Amount ?? row.sol ?? ""),
          memo: String(row.memo ?? row.Memo ?? "").trim() || undefined,
        }))
        .filter((row) => row.privateKey && Number.isFinite(row.amount));

      if (!parsed.length) {
        appendLog("File không có dòng hợp lệ.");
        return;
      }
      setBatch({ rows: parsed, idx: 0, success: 0, failed: 0 });
      appendLog(`📥 Đã tải ${parsed.length} ví.`);
    } catch (err: any) {
      appendLog(`❌ Lỗi đọc file: ${err?.message || String(err)}`);
    }
  };

  const runBatch = async () => {
    if (!batch.rows.length) {
      appendLog("Không có dữ liệu batch");
      return;
    }
    if (batchRunning) {
      appendLog("Batch đang chạy");
      return;
    }
    if (!tokenMint.trim()) {
      appendLog("Vui lòng nhập token mint");
      return;
    }

    setBatchRunning(true);
    pauseRef.current = false;
    appendLog("🚀 Bắt đầu mua hàng loạt …");

    let idx = 0;
    let success = 0;
    let failed = 0;

    for (const row of batch.rows) {
      if (pauseRef.current) {
        appendLog("⏸️ Batch tạm dừng");
        break;
      }
      idx += 1;
      setBatch((prev) => ({ ...prev, idx }));
      appendLog(`➡️ [${idx}/${batch.rows.length}] Ví: ${shortAddress(row.privateKey, 6, 4)} · Amount ${row.amount}`);
      try {
        const res = await buyTokenOnPumpFun(
          {
            network,
            privateKey: row.privateKey,
            tokenMint: tokenMint.trim(),
            amountSol: row.amount,
            slippageBps: Number(slippageBps) || DEFAULT_SLIPPAGE_BPS,
            priorityLevel,
          },
          (msg) => appendLog(`   ${msg}`)
        );
        success += 1;
        appendLog(`   ✅ Tx ${res.signature}`);
      } catch (err: any) {
        failed += 1;
        appendLog(`   ❌ Lỗi: ${err?.message || String(err)}`);
      }
      setBatch((prev) => ({ ...prev, success, failed }));
    }

    setBatch((prev) => ({ ...prev, idx, success, failed }));
    setBatchRunning(false);
    appendLog("🏁 Batch kết thúc");
  };

  const stopBatch = () => {
    if (!batchRunning) return;
    pauseRef.current = true;
    setBatchRunning(false);
  };

  const clearBatch = () => {
    setBatch({ rows: [], idx: 0, success: 0, failed: 0 });
  };

  return (
    <div className="bg-white rounded-2xl shadow-2xl w-full mx-auto overflow-hidden">
      <div className="bg-purple-600 text-white text-center py-4">
        <h1 className="text-xl font-semibold">Pump.fun Multi Buy</h1>
      </div>

      <div className="p-6 space-y-6">
        <div className="grid md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium mb-2">Network</label>
            <select
              value={network}
              onChange={(e) => setNetwork(e.target.value as NetKey)}
              className="w-full px-4 py-3 bg-gray-50 border rounded-lg"
            >
              <option value="mainnet">Mainnet</option>
              <option value="devnet">Devnet (test)</option>
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium mb-2">Token mint (pump.fun)</label>
            <input
              value={tokenMint}
              onChange={(e) => setTokenMint(e.target.value.trim())}
              placeholder="Ví dụ: 6yz..."
              className="w-full px-4 py-3 bg-gray-50 border rounded-lg"
            />
          </div>
        </div>

        <div className="grid md:grid-cols-3 gap-4">
          <div>
            <label className="block text-sm font-medium mb-2">Slippage (bps)</label>
            <input
              value={slippageBps}
              onChange={(e) => setSlippageBps(e.target.value)}
              className="w-full px-4 py-3 bg-gray-50 border rounded-lg"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-2">Priority fee level</label>
            <select
              value={priorityLevel}
              onChange={(e) => setPriorityLevel(e.target.value as PumpFunPriorityLevel)}
              className="w-full px-4 py-3 bg-gray-50 border rounded-lg"
            >
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="extreme">Extreme</option>
            </select>
          </div>
          <div className="flex flex-col justify-end text-xs text-gray-500">
            <span>Slippage mặc định 1% (100 bps). Ưu tiên trải nghiệm tốt chọn High.</span>
          </div>
        </div>

        <div className="border rounded-lg p-4 space-y-4">
          <h2 className="font-semibold text-gray-700">Mua đơn lẻ</h2>
          <div className="grid md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-2">Private key (bs58)</label>
              <div className="relative">
                <input
                  type={showPk ? "text" : "password"}
                  value={singlePrivateKey}
                  onChange={(e) => setSinglePrivateKey(e.target.value)}
                  className="w-full px-4 py-3 bg-gray-50 border rounded-lg pr-12"
                  placeholder="bs58..."
                />
                <button
                  type="button"
                  onClick={() => setShowPk((prev) => !prev)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-purple-600"
                >
                  {showPk ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium mb-2">Số lượng SOL</label>
              <input
                value={singleAmount}
                onChange={(e) => setSingleAmount(e.target.value)}
                className="w-full px-4 py-3 bg-gray-50 border rounded-lg"
                placeholder="0.01"
              />
            </div>
          </div>
          <button
            type="button"
            onClick={handleSingleBuy}
            className="w-full bg-purple-600 text-white py-3 rounded-lg"
          >
            Mua ngay
          </button>
        </div>

        <div className="border rounded-lg p-4 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold text-gray-700">Batch mua hàng loạt</h2>
            <span className="text-xs text-gray-500">{selectedSummary}</span>
          </div>
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              onClick={createTemplate}
              className="px-3 py-2 bg-gray-100 border rounded flex items-center gap-2 text-sm"
            >
              <FileDown size={16} /> Tải template
            </button>
            <label className="px-3 py-2 bg-gray-100 border rounded flex items-center gap-2 text-sm cursor-pointer">
              <Upload size={16} />
              Upload danh sách
              <input type="file" accept=".xlsx,.xls,.csv" hidden onChange={(e) => handleFileUpload(e.target.files?.[0])} />
            </label>
            <button
              type="button"
              onClick={runBatch}
              disabled={batchRunning}
              className="px-3 py-2 bg-purple-600 text-white rounded flex items-center gap-2 text-sm disabled:opacity-60"
            >
              <Play size={16} /> Chạy batch
            </button>
            <button
              type="button"
              onClick={stopBatch}
              className="px-3 py-2 bg-orange-500 text-white rounded flex items-center gap-2 text-sm"
            >
              <Pause size={16} /> Dừng
            </button>
            <button
              type="button"
              onClick={clearBatch}
              className="px-3 py-2 bg-gray-200 text-gray-700 rounded flex items-center gap-2 text-sm"
            >
              <Trash2 size={16} /> Xóa danh sách
            </button>
          </div>

          <div className="bg-gray-50 border rounded p-3 text-xs max-h-40 overflow-auto">
            {batch.rows.length === 0 ? (
              <div className="text-gray-500">Chưa có dữ liệu. Import file template (privateKey, amount).</div>
            ) : (
              <ul className="space-y-1">
                {batch.rows.map((row, idx) => (
                  <li key={idx} className="flex justify-between">
                    <span>
                      {idx + 1}. {shortAddress(row.privateKey, 4, 4)} · {row.amount} SOL
                      {row.memo ? ` · ${row.memo}` : ""}
                    </span>
                    {idx + 1 === batch.idx ? <span className="text-purple-600">Đang xử lý…</span> : null}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <div>
          <h3 className="font-medium mb-2">Log</h3>
          <pre className="text-xs bg-gray-50 border rounded-lg p-3 h-48 overflow-auto whitespace-pre-wrap break-words">
            {logLines.length === 0 ? "Chưa có log" : logLines.join("\n")}
          </pre>
        </div>
      </div>
    </div>
  );
}

export default PumpFunBuy;
