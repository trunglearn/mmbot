// BscSwap.tsx
import React, { useMemo, useRef, useState } from "react";
import { Eye, EyeOff, FileDown, Upload, Play, Trash2, Pause, RefreshCw } from "lucide-react";
import * as XLSX from "xlsx";
import { Web3 } from "web3";
import { BSC_ENDPOINTS, BscNet, ERC20_ABI, FACTORY_V2_ABI, ROUTER_V2_ABI } from "./constants";

/* ------------------------------------------------------------------------- */
/* Types                                                                     */
/* ------------------------------------------------------------------------- */
type BatchRowBsc = {
    privateKey: string;  // hex 64 (OKX/MetaMask), with or without 0x
    amount: number;      // BNB amount
    tokenOut?: string;   // optional per-row override (BEP-20)
    __row?: number;      // excel row index for UI
};

type Progress = { total: number; done: number; ok: number; fail: number };

/* ------------------------------------------------------------------------- */
/* Small utils                                                               */
/* ------------------------------------------------------------------------- */
const short = (s: string, n = 6) => (s.length <= 2 * n ? s : `${s.slice(0, n)}…${s.slice(-n)}`);

// remove zero-width, BOM, non-breaking space, etc.
const stripZeroWidth = (s: string) =>
    s.replace(/[\u200B-\u200D\uFEFF\u2060\u00A0]/g, "");

const normalizePkBody = (raw: string) => {
    const cleaned = stripZeroWidth(raw).trim().replace(/\s+/g, "").replace(/^0x/i, "");
    return cleaned;
};

const sanitizePk = (raw: string) => {
    const body = normalizePkBody(raw);
    if (!/^[0-9a-fA-F]{64}$/.test(body)) {
        throw new Error("Private key phải là 64 hex (OKX/MetaMask), có/không '0x' đều được.");
    }
    return (`0x${body}`) as `0x${string}`;
};

/* ------------------------------------------------------------------------- */
/* Component                                                                 */
/* ------------------------------------------------------------------------- */
function BscSwap() {
    // Global UI state
    const [net, setNet] = useState<BscNet>("testnet");
    const [defaultTokenOut, setDefaultTokenOut] = useState<string>("");   // dùng nếu ô tokenOut trống
    const [defaultSlippage, setDefaultSlippage] = useState<string>("1.0"); // slippage chung (không lấy từ file)
    const [status, setStatus] = useState<string>("");

    // Single quick-test (tùy dùng)
    const [pk, setPk] = useState<string>("");
    const [showPk, setShowPk] = useState<boolean>(false);
    const [amountBnb, setAmountBnb] = useState<string>("0.001");

    // Batch state
    const [rows, setRows] = useState<BatchRowBsc[]>([]);
    const [batchErrors, setBatchErrors] = useState<string[]>([]);
    const [isRunning, setIsRunning] = useState(false);
    const [isPaused, setIsPaused] = useState(false);
    const pauseRef = useRef(false);
    const [progress, setProgress] = useState<Progress>({ total: 0, done: 0, ok: 0, fail: 0 });
    const fileRef = useRef<HTMLInputElement | null>(null);

    const log = (s: string) => setStatus((p) => (p ? p + "\n" + s : s));

    const header = useMemo(
        () => (
            <div className="bg-amber-500 text-white text-center py-4">
                <h2 className="text-xl font-semibold">BNB → Token (PancakeSwap V2 · QuickNode) – Batch by Excel</h2>
            </div>
        ),
        []
    );

    /* ----------------------------------------------------------------------- */
    /* Core swap (single)                                                      */
    /* ----------------------------------------------------------------------- */
    const swapOnce = async (params: {
        privateKey: string;
        amountBnb: number;
        tokenOut: string;
        slippagePct: number; // dùng slippage chung từ UI
        logPrefix?: string;
    }) => {
        const { privateKey, amountBnb, tokenOut, slippagePct, logPrefix } = params;
        const tag = logPrefix ? `[${logPrefix}] ` : "";

        const cfg = BSC_ENDPOINTS[net];
        if (!Web3.utils.isAddress(tokenOut)) throw new Error(`${tag}Token address không hợp lệ (BEP-20).`);

        const web3 = new Web3(cfg.rpc);
        const priv = sanitizePk(privateKey); // ✅ robust sanitize
        const acc = web3.eth.accounts.privateKeyToAccount(priv);
        web3.eth.accounts.wallet.clear();
        web3.eth.accounts.wallet.add(acc);
        web3.eth.defaultAccount = acc.address;

        log(`${tag}🔗 Network: ${net.toUpperCase()} @ ${cfg.rpc}`);
        log(`${tag}👤 From: ${acc.address}`);
        log(`${tag}🪙 Base: BNB | Token out: ${Web3.utils.toChecksumAddress(tokenOut)}`);

        const router = new web3.eth.Contract(ROUTER_V2_ABI as any, cfg.routerV2);
        const factory = new web3.eth.Contract(FACTORY_V2_ABI as any, cfg.factoryV2);
        const wbnb = cfg.wbnb;

        // ensure pair WBNB/TOKEN exists
        const pair = await factory.methods.getPair(wbnb, tokenOut).call();
        if (pair === "0x0000000000000000000000000000000000000000") {
            throw new Error(`${tag}Cặp WBNB/token chưa tồn tại trên PancakeSwap V2.`);
        }

        // pretty logs
        let sym = "TOKEN",
            dec = 18;
        try {
            const erc20 = new web3.eth.Contract(ERC20_ABI as any, tokenOut);
            sym = await erc20.methods.symbol().call();
            dec = parseInt(await erc20.methods.decimals().call(), 10);
        } catch {
            /* ignore */
        }

        const amtInWei = web3.utils.toWei(String(parseFloat(String(amountBnb).replace(",", "."))), "ether");
        const path = [wbnb, tokenOut];
        const amounts = await router.methods.getAmountsOut(amtInWei, path).call();
        const out = BigInt(amounts[1]);
        const slip = Math.max(0, Math.min(100, Number(slippagePct)));
        const outMin = (out * BigInt(Math.floor((100 - slip) * 100))) / BigInt(10000);

        log(`${tag}📈 Quote V2: out=${out.toString()} (≈ ${Number(out) / 10 ** dec} ${sym})`);
        log(`${tag}🎯 outMin (slippage ${slip}%): ${outMin.toString()} (${Number(outMin) / 10 ** dec} ${sym})`);

        const gasPrice = await web3.eth.getGasPrice();
        const deadline = Math.floor(Date.now() / 1000) + 60 * 5;

        const tx = router.methods.swapExactETHForTokensSupportingFeeOnTransferTokens(
            outMin.toString(),
            path,
            acc.address,
            deadline
        );

        // safe gas estimate
        let gas: bigint;
        try {
            const g = await tx.estimateGas({ from: acc.address, value: amtInWei });
            gas = BigInt(g);
        } catch (e: any) {
            log(`${tag}⚠️ estimateGas lỗi, dùng fallback 300000. Message: ${e?.message || e}`);
            gas = 300000n;
        }

        const nonce = await web3.eth.getTransactionCount(acc.address, "pending");
        log(`${tag}⛽ gas=${gas.toString()} | gasPrice=${gasPrice} wei | nonce=${nonce}`);

        const sent = await tx.send({
            from: acc.address,
            value: amtInWei,
            gas: Number(gas),
            gasPrice,
            nonce
        });

        const txHash = sent?.transactionHash || sent;
        log(`${tag}✅ Swap thành công: ${txHash}`);
        log(`${tag}🔍 ${cfg.explorer}/tx/${txHash}`);
    };

    const handleSwapSingle = async () => {
        setStatus("");
        try {
            const token = defaultTokenOut.trim();
            if (!Web3.utils.isAddress(token)) throw new Error("Default Token Address không hợp lệ (BEP-20).");
            const slip = parseFloat(defaultSlippage || "1.0");
            await swapOnce({
                privateKey: pk,
                amountBnb: parseFloat(amountBnb),
                tokenOut: token,
                slippagePct: isFinite(slip) ? slip : 1.0
            });
        } catch (err: any) {
            log(`❌ ${err?.reason || err?.message || String(err)}`);
        }
    };

    /* ----------------------------------------------------------------------- */
    /* Excel helpers                                                            */
    /* ----------------------------------------------------------------------- */
    const handleDownloadTemplate = () => {
        // Chỉ 3 cột theo yêu cầu
        const ws = XLSX.utils.json_to_sheet<BatchRowBsc>([
            { privateKey: "0x<hex64>", amount: 0.002, tokenOut: "" }
        ]);
        // ép kiểu text cho ô privateKey để Excel không làm hỏng chuỗi
        if (ws["A2"]) (ws["A2"] as any).t = "s";
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, "batch");
        XLSX.writeFile(wb, "bsc_batch_template.xlsx");
    };

    const handleFile = async (file?: File | null) => {
        if (!file) return;
        setBatchErrors([]);
        const buf = await file.arrayBuffer();
        const wb = XLSX.read(buf);
        const sheet = wb.Sheets[wb.SheetNames[0]];
        const json = XLSX.utils.sheet_to_json<any>(sheet, { defval: "" });

        const parsed: BatchRowBsc[] = json.map((row, i) => ({
            privateKey: String(row.privateKey || row.PrivateKey || row["private_key"] || "").trim(),
            amount: Number(row.amount || row.Amount || row["BNB"] || 0),
            tokenOut: String(row.tokenOut || row.TokenOut || row["token_out"] || "").trim(),
            __row: i + 2 // header ở dòng 1
        }));

        const errs: string[] = [];
        const hasDefault = defaultTokenOut.trim().length > 0;

        for (const r of parsed) {
            if (!r.privateKey) {
                errs.push(`Row ${r.__row}: thiếu privateKey`);
            } else {
                try {
                    r.privateKey = sanitizePk(r.privateKey); // ✅ chuẩn hoá + thêm 0x
                } catch {
                    errs.push(`Row ${r.__row}: privateKey hex không hợp lệ (${short(r.privateKey)})`);
                }
            }

            if (!(r.amount > 0)) errs.push(`Row ${r.__row}: amount (BNB) phải > 0`);

            // tokenOut có thể trống, khi đó phải có defaultTokenOut ở UI
            if (r.tokenOut) {
                if (!Web3.utils.isAddress(r.tokenOut))
                    errs.push(`Row ${r.__row}: tokenOut không hợp lệ (${short(r.tokenOut)})`);
            } else if (!hasDefault) {
                errs.push(`Row ${r.__row}: tokenOut trống và Default Token Address cũng trống → cần điền một trong hai`);
            }
        }

        setRows(parsed);
        setProgress({ total: parsed.length, done: 0, ok: 0, fail: 0 });
        if (errs.length) setBatchErrors(errs);
    };

    /* ----------------------------------------------------------------------- */
    /* Batch runner                                                             */
    /* ----------------------------------------------------------------------- */
    const runBatch = async () => {
        if (!rows.length) {
            setBatchErrors(["Chưa có dữ liệu — hãy Upload file Excel/CSV trước."]);
            return;
        }
        if (!defaultTokenOut.trim()) {
            // Không bắt buộc nếu mọi dòng đều có tokenOut, nhưng cảnh báo sớm
            const anyMissing = rows.some((r) => !r.tokenOut?.trim());
            if (anyMissing) {
                setBatchErrors(["Một số dòng không có tokenOut và Default Token Address đang trống. Hãy nhập Default Token Address."]);
                return;
            }
        }

        setIsRunning(true);
        setIsPaused(false);
        pauseRef.current = false;
        setStatus("");
        setProgress({ total: rows.length, done: 0, ok: 0, fail: 0 });

        const slip = parseFloat(defaultSlippage || "1.0");
        const slippagePct = isFinite(slip) ? slip : 1.0;

        for (let idx = 0; idx < rows.length; idx++) {
            // pause support
            // eslint-disable-next-line no-await-in-loop
            while (pauseRef.current) await new Promise((r) => setTimeout(r, 200));

            const r = rows[idx];
            const label = `Row#${r.__row ?? idx + 1}`;
            const token = (r.tokenOut && r.tokenOut.trim()) ? r.tokenOut.trim() : defaultTokenOut.trim();

            try {
                // eslint-disable-next-line no-await-in-loop
                await swapOnce({
                    privateKey: r.privateKey,
                    amountBnb: r.amount,
                    tokenOut: token,
                    slippagePct,
                    logPrefix: label
                });
                setProgress((p) => ({ ...p, done: p.done + 1, ok: p.ok + 1 }));
            } catch (e: any) {
                setProgress((p) => ({ ...p, done: p.done + 1, fail: p.fail + 1 }));
                log(`${label} → ❌ ${e?.reason || e?.message || String(e)}`);
                console.error(e);
            }

            // nhỏ nhẹ RPC
            // eslint-disable-next-line no-await-in-loop
            await new Promise((r) => setTimeout(r, 250));
        }

        setIsRunning(false);
        log(`🏁 Batch done → OK: ${progress.ok} / FAIL: ${progress.fail}`);
    };

    const togglePause = () => {
        pauseRef.current = !pauseRef.current;
        setIsPaused(pauseRef.current);
    };

    const clearBatch = () => {
        setRows([]);
        setBatchErrors([]);
        setProgress({ total: 0, done: 0, ok: 0, fail: 0 });
    };

    return (
        <div className="bg-white rounded-2xl shadow-2xl w-full mx-auto overflow-hidden">
            {header}
            <div className="p-6 space-y-8">
                {/* Network & default token/slippage */}
                <div className="grid md:grid-cols-3 gap-4">
                    <div>
                        <label className="block text-sm font-medium mb-2">Network</label>
                        <select
                            value={net}
                            onChange={(e) => setNet(e.target.value as BscNet)}
                            className="w-full px-4 py-3 bg-gray-50 border rounded-lg"
                        >
                            <option value="mainnet">Mainnet (Chain 56)</option>
                            <option value="testnet">Testnet / Chapel (Chain 97)</option>
                        </select>
                    </div>
                    <div>
                        <label className="block text-sm font-medium mb-2">Default Token Address (dùng khi cột tokenOut trống)</label>
                        <input
                            type="text"
                            value={defaultTokenOut}
                            onChange={(e) => setDefaultTokenOut(e.target.value.trim())}
                            className="w-full px-4 py-3 bg-gray-50 border rounded-lg"
                            placeholder="Ví dụ: 0x55d398... (USDT mainnet)"
                            autoComplete="off"
                            spellCheck={false}
                        />
                    </div>
                    <div>
                        <label className="block text-sm font-medium mb-2">Default Slippage (%)</label>
                        <input
                            type="text"
                            value={defaultSlippage}
                            onChange={(e) => setDefaultSlippage(e.target.value)}
                            className="w-full px-4 py-3 bg-gray-50 border rounded-lg"
                            placeholder="1.0"
                        />
                    </div>
                </div>

                {/* Quick single test (optional) */}
                <div className="border rounded-xl p-4 bg-gray-50">
                    <div className="flex items-center justify-between mb-3">
                        <h2 className="font-semibold">Test nhanh (1 ví)</h2>
                        <button
                            onClick={() => setShowPk(!showPk)}
                            className="text-amber-700 flex items-center gap-2"
                            type="button"
                            title={showPk ? "Hide" : "Show"}
                        >
                            {showPk ? <EyeOff size={16} /> : <Eye size={16} />} {showPk ? "Ẩn" : "Hiện"} key
                        </button>
                    </div>
                    <div className="grid md:grid-cols-3 gap-3">
                        <input
                            type={showPk ? "text" : "password"}
                            value={pk}
                            onChange={(e) => setPk(e.target.value)}
                            className="w-full px-4 py-3 bg-white border rounded-lg"
                            placeholder="0x..."
                            autoComplete="off"
                            spellCheck={false}
                        />
                        <input
                            type="text"
                            value={amountBnb}
                            onChange={(e) => setAmountBnb(e.target.value)}
                            className="w-full px-4 py-3 bg-white border rounded-lg"
                            placeholder="0.001"
                        />
                        <button onClick={handleSwapSingle} className="bg-amber-500 text-white py-3 rounded-lg">
                            Swap (1 ví)
                        </button>
                    </div>
                    <p className="text-xs text-gray-500 mt-2">
                        Mẹo: Trong Excel, đặt cột <code>privateKey</code> là <b>Text</b>. Tránh xuống dòng/space ẩn khi dán.
                    </p>
                </div>

                {/* Batch uploader */}
                <div className="border rounded-xl p-4">
                    <div className="flex items-center justify-between">
                        <h2 className="font-semibold">Batch bằng Excel/CSV</h2>
                        <div className="flex gap-2">
                            <button
                                onClick={handleDownloadTemplate}
                                className="flex items-center gap-2 px-3 py-2 rounded-lg bg-gray-100 border"
                                type="button"
                            >
                                <FileDown size={16} /> Tải template
                            </button>
                            <button
                                onClick={() => fileRef.current?.click()}
                                className="flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-50 border text-amber-700"
                                type="button"
                            >
                                <Upload size={16} /> Upload file
                            </button>
                            <input
                                ref={fileRef}
                                type="file"
                                accept=".xlsx,.xls,.csv"
                                className="hidden"
                                onChange={(e) => handleFile(e.target.files?.[0])}
                            />
                        </div>
                    </div>

                    {batchErrors.length > 0 && (
                        <div className="mt-3 text-sm text-red-700 bg-red-50 border border-red-200 rounded p-3">
                            <div className="font-semibold mb-1">Lỗi/Warning khi đọc file:</div>
                            <ul className="list-disc pl-5 space-y-1">
                                {batchErrors.map((er, i) => (
                                    <li key={i}>{er}</li>
                                ))}
                            </ul>
                        </div>
                    )}

                    {rows.length > 0 && (
                        <div className="mt-4">
                            <div className="flex items-center justify-between mb-2">
                                <div className="text-sm text-gray-600">
                                    Tổng dòng: <b>{rows.length}</b> | Done: <b>{progress.done}</b> | OK: <b>{progress.ok}</b> | FAIL: <b>{progress.fail}</b>
                                </div>
                                <div className="flex gap-2">
                                    {!isRunning ? (
                                        <button onClick={runBatch} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-500 text-white">
                                            <Play size={16} /> Chạy batch
                                        </button>
                                    ) : (
                                        <>
                                            <button onClick={togglePause} className="flex items-center gap-2 px-3 py-2 rounded-lg border">
                                                {isPaused ? <Play size={16} /> : <Pause size={16} />} {isPaused ? "Tiếp tục" : "Tạm dừng"}
                                            </button>
                                            <button disabled className="flex items-center gap-2 px-3 py-2 rounded-lg bg-gray-200 text-gray-500">
                                                <RefreshCw size={16} /> Đang chạy…
                                            </button>
                                        </>
                                    )}
                                    <button onClick={clearBatch} className="flex items-center gap-2 px-3 py-2 rounded-lg border">
                                        <Trash2 size={16} /> Xóa danh sách
                                    </button>
                                </div>
                            </div>

                            <div className="overflow-x-auto border rounded-lg">
                                <table className="min-w-full text-sm">
                                    <thead className="bg-gray-50">
                                        <tr>
                                            <th className="px-3 py-2 text-left">#</th>
                                            <th className="px-3 py-2 text-left">privateKey (hex)</th>
                                            <th className="px-3 py-2 text-left">amount (BNB)</th>
                                            <th className="px-3 py-2 text-left">tokenOut (override)</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {rows.map((r, i) => (
                                            <tr key={i} className={i % 2 ? "bg-white" : "bg-gray-50"}>
                                                <td className="px-3 py-2">{r.__row ?? i + 1}</td>
                                                <td className="px-3 py-2 font-mono">{short(r.privateKey, 8)}</td>
                                                <td className="px-3 py-2">{r.amount}</td>
                                                <td className="px-3 py-2 font-mono">
                                                    {r.tokenOut || <span className="italic text-gray-500">(default)</span>}
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    )}
                </div>

                <pre className="text-xs bg-gray-50 p-3 rounded-lg whitespace-pre-wrap break-words h-72 overflow-auto">{status}</pre>
                <div className="flex gap-4">
                    <button onClick={() => setStatus("")} className="flex-1 bg-gray-600 text-white py-3 rounded-lg">
                        Clear Logs
                    </button>
                </div>
            </div>
        </div>
    );
}

export default BscSwap;