import React, { useMemo, useRef, useState } from "react";
import { Eye, EyeOff, FileDown, Upload, Play, Trash2, Pause, RefreshCw } from "lucide-react";
import * as XLSX from "xlsx";
import bs58 from "bs58";
import axios from "axios";
import { Buffer } from "buffer";
import {
    Connection,
    Keypair,
    VersionedTransaction,
    Transaction,
    PublicKey,
    LAMPORTS_PER_SOL,
    sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
    getAssociatedTokenAddress,
    createAssociatedTokenAccountInstruction,
    NATIVE_MINT,
} from "@solana/spl-token";
import { NETWORKS, NetKey, DATASIZE_V4, OFF_BASE, OFF_QUOTE, SOL_PSEUDO_MINT, TOKEN_ACC_SIZE } from "./constants";

// ------------------------------- Types -------------------------------------

type BatchRow = {
    privateKey: string; // bs58
    amount: number; // SOL amount
    tokenMint?: string; // optional override
    memo?: string; // optional note for your tracking
    __row?: number; // for UI index tracking
};

// ------------------------ Small utilities ----------------------------------

const toLamports = (sol: number) => BigInt(Math.floor(sol * LAMPORTS_PER_SOL));

const isValidMint = (s: string) => {
    try {
        const pk = new PublicKey(s);
        return PublicKey.isOnCurve(pk) || true; // if ctor ok, it's syntactically valid
    } catch {
        return false;
    }
};

const short = (s: string, n = 6) => (s.length <= 2 * n ? s : `${s.slice(0, n)}…${s.slice(-n)}`);

// ------------------------ Main Component -----------------------------------

function SolSwap() {
    // Single mode (still available if you want quick test)
    const [privateKey, setPrivateKey] = useState("");
    const [showPrivateKey, setShowPrivateKey] = useState(false);
    const [network, setNetwork] = useState<NetKey>("devnet");
    const [contractAddress, setContractAddress] = useState(
        "Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr" // dUSDC on devnet
    );
    const [amountSol, setAmountSol] = useState("0.001");

    // Batch state
    const [rows, setRows] = useState<BatchRow[]>([]);
    const [batchErrors, setBatchErrors] = useState<string[]>([]);
    const [isRunning, setIsRunning] = useState(false);
    const [isPaused, setIsPaused] = useState(false);
    const pauseRef = useRef(false);

    const [progress, setProgress] = useState({ total: 0, done: 0, ok: 0, fail: 0 });

    const [status, setStatus] = useState("");
    const log = (s: string) => setStatus((p) => (p ? p + "\n" + s : s));

    const onChangeNetwork = (value: NetKey) => {
        setNetwork(value);
        setContractAddress(
            value === "mainnet"
                ? "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R" // RAY mainnet (example)
                : "Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr" // dUSDC devnet
        );
    };

    // ------------------------ Core swap (single) -----------------------------

    const swapOnce = async (params: {
        privateKey: string; // bs58
        destMintStr: string; // token mint
        amountSol: number; // ui amount in SOL
        logPrefix?: string; // optional label
    }) => {
        const { privateKey, destMintStr, amountSol, logPrefix } = params;
        const tag = logPrefix ? `[${logPrefix}] ` : "";

        const net = NETWORKS[network];
        const conn = new Connection(net.rpc, "confirmed");

        const secret = bs58.decode(privateKey.trim());
        const owner = Keypair.fromSecretKey(secret);
        const destMint = new PublicKey(destMintStr.trim());

        const ui = parseFloat(String(amountSol).replace(",", "."));
        if (!isFinite(ui) || ui <= 0) throw new Error("Số lượng SOL không hợp lệ");
        const amountLamports = toLamports(ui);

        log(`${tag}Start swap (QuickNode-only).`);
        log(`${tag}Owner: ${owner.publicKey.toBase58()}`);
        log(`${tag}Dest mint: ${destMint.toBase58()}`);
        log(`${tag}Amount in (lamports): ${amountLamports}`);

        const [rentPerTokenAcc, accountsInfo, balanceLamports] = await Promise.all([
            conn.getMinimumBalanceForRentExemption(TOKEN_ACC_SIZE, "confirmed"),
            (async () => {
                const wsolAta = await getAssociatedTokenAddress(NATIVE_MINT, owner.publicKey);
                const outAta = await getAssociatedTokenAddress(destMint, owner.publicKey);
                const [wsolInfo, outInfo] = await conn.getMultipleAccountsInfo([wsolAta, outAta], "confirmed");
                return { wsolAta, outAta, wsolInfo, outInfo };
            })(),
            conn.getBalance(owner.publicKey, "confirmed"),
        ]);

        const { wsolAta, outAta, wsolInfo, outInfo } = accountsInfo;
        const needRentWSOL = wsolInfo ? 0n : BigInt(rentPerTokenAcc);
        const needRentOut = outInfo ? 0n : BigInt(rentPerTokenAcc);
        const feeBuffer = BigInt(Math.floor(0.005 * LAMPORTS_PER_SOL));
        const totalNeed = BigInt(amountLamports) + needRentWSOL + needRentOut + feeBuffer;
        const balance = BigInt(balanceLamports);

        log(
            `${tag}💰 Balance: ${(Number(balance) / LAMPORTS_PER_SOL).toFixed(6)} SOL | Need ≈ ${(Number(totalNeed) / LAMPORTS_PER_SOL).toFixed(6)} SOL`
        );
        if (balance < totalNeed) {
            throw new Error(
                `${tag}Không đủ SOL: cần ~${(Number(totalNeed) / LAMPORTS_PER_SOL).toFixed(6)} SOL (gồm amount + rent + phí), đang có ${(Number(balance) / LAMPORTS_PER_SOL).toFixed(6)} SOL`
            );
        }

        const gpa = await conn.getProgramAccounts(net.raydiumProgram, {
            commitment: "confirmed",
            encoding: "base64",
            filters: [
                { dataSize: DATASIZE_V4 },
                { memcmp: { offset: OFF_BASE, bytes: destMint.toBase58() } },
                { memcmp: { offset: OFF_QUOTE, bytes: NATIVE_MINT.toBase58() } },
            ],
            dataSlice: { offset: 0, length: 0 },
        });
        if (!gpa.length) {
            log(`${tag}⚠️ Không thấy pool (base=token, quote=wSOL). Có thể route CLMM/khác, vẫn tiếp tục.`);
        } else {
            log(`${tag}🔎 Found pool: ${gpa[0].pubkey.toBase58()}`);
        }

        log(`${tag}🧮 Lấy priority fee …`);
        const feeRes = await axios.get(net.feeEndpoint);
        const priorityMicroLamports: string = String(feeRes.data?.data?.default?.h ?? 15000);

        const txVersion = "V0";
        const slippageBps = 100; // 1%

        log(`${tag}💬 Lấy quote (swap-base-in) …`);
        const { data: swapResponse } = await axios.get(`${net.swapHost}/compute/swap-base-in`, {
            params: {
                inputMint: SOL_PSEUDO_MINT,
                outputMint: destMint.toBase58(),
                amount: amountLamports.toString(),
                slippageBps,
                txVersion,
            },
        });

        if (!outInfo) {
            log(`${tag}🧱 Tạo ATA cho mint đích: ${outAta.toBase58()}`);
            const ix = createAssociatedTokenAccountInstruction(owner.publicKey, outAta, owner.publicKey, destMint);
            const preTx = new Transaction().add(ix);
            preTx.feePayer = owner.publicKey;
            preTx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
            preTx.sign(owner);
            await sendAndConfirmTransaction(conn, preTx, [owner], { skipPreflight: false });
            log(`${tag}✅ ATA created`);
        } else {
            log(`${tag}ℹ️ ATA đã tồn tại: ${outAta.toBase58()}`);
        }

        log(`${tag}🧱 Lấy serialized transactions …`);
        const { data: swapTxs } = await axios.post(`${net.swapHost}/transaction/swap-base-in`, {
            computeUnitPriceMicroLamports: priorityMicroLamports,
            swapResponse,
            txVersion,
            wallet: owner.publicKey.toBase58(),
            wrapSol: true,
            unwrapSol: false,
            outputAccount: outAta.toBase58(),
        });

        const txList: { transaction: string }[] = swapTxs?.data ?? swapTxs;
        if (!Array.isArray(txList) || !txList.length) throw new Error("Trade API không trả về giao dịch");

        log(`${tag}📦 Nhận ${txList.length} transaction(s). Deserialize & ký …`);

        for (let i = 0; i < txList.length; i++) {
            const item = txList[i];
            const buf = Buffer.from(item.transaction, "base64");

            let v0: VersionedTransaction | null = null;
            try {
                v0 = VersionedTransaction.deserialize(buf);
            } catch {
                v0 = null;
            }

            try {
                let sig: string;
                if (v0) {
                    v0.sign([owner]);
                    sig = await conn.sendTransaction(v0, { skipPreflight: true });
                    await conn.confirmTransaction(sig, "confirmed");
                } else {
                    const legacy = Transaction.from(buf);
                    legacy.sign(owner);
                    sig = await sendAndConfirmTransaction(conn, legacy, [owner], { skipPreflight: true });
                }
                log(`${tag}✅ TX ${i + 1}/${txList.length} confirmed: ${sig}`);
                log(`${tag}🔍 ${NETWORKS[network].solscanBase}/tx/${sig}${NETWORKS[network].explorerClusterQS}`);
            } catch (err: any) {
                const logs =
                    err?.logs ||
                    err?.value?.logs ||
                    err?.data?.logs ||
                    (typeof err?.getLogs === "function" ? await err.getLogs() : null);
                log(
                    `${tag}❌ Simulation/Send failed.\nMessage: ${err?.message}\nLogs:\n${Array.isArray(logs) ? logs.join("\n") : JSON.stringify(logs) || "[]"}`
                );
                throw err;
            }
        }

        const parsed = await conn.getParsedAccountInfo(
            await getAssociatedTokenAddress(destMint, Keypair.fromSecretKey(bs58.decode(privateKey.trim())).publicKey),
            "confirmed"
        );
        const parsedInfo: any = parsed.value?.data?.parsed?.info;
        if (parsedInfo?.tokenAmount) {
            log(`${tag}🎯 Nhận vào ATA amount: ${parsedInfo.tokenAmount.uiAmountString}`);
        } else {
            log(`${tag}🔎 Parsed: chưa đọc được số dư mới.`);
        }

        log(`${tag}🎉 Done.`);
    };

    // ------------------------ Single button (still available) -----------------

    const handleSwapSingle = async () => {
        setStatus("");
        try {
            await swapOnce({ privateKey, destMintStr: contractAddress, amountSol: parseFloat(amountSol) });
        } catch (e: any) {
            const fromAxios = e?.response?.data ? `\nAPI: ${JSON.stringify(e.response.data)}` : "";
            log(`❌ ${e?.message || String(e)}${fromAxios}`);
            console.error(e);
        }
    };

    // ------------------------ Excel handling ---------------------------------

    const handleDownloadTemplate = () => {
        const ws = XLSX.utils.json_to_sheet<BatchRow>([
            { privateKey: "<bs58 secret>", amount: 0.123, tokenMint: "", memo: "optional" },
        ]);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, "batch");
        XLSX.writeFile(wb, "sol_batch_template.xlsx");
    };

    const handleFile = async (file?: File | null) => {
        if (!file) return;
        setBatchErrors([]);
        const buf = await file.arrayBuffer();
        const wb = XLSX.read(buf);
        const sheet = wb.Sheets[wb.SheetNames[0]];
        const json = XLSX.utils.sheet_to_json<any>(sheet, { defval: "" });

        const parsed: BatchRow[] = json.map((row, i) => ({
            privateKey: String(row.privateKey || row.PrivateKey || row["private_key"] || "").trim(),
            amount: Number(row.amount || row.Amount || row["SOL"] || 0),
            tokenMint: String(row.tokenMint || row.TokenMint || row["token_mint"] || "").trim(),
            memo: String(row.memo || row.Memo || "").trim(),
            __row: i + 2, // Excel row (assuming headers at row 1)
        }));

        // basic validation + annotate errors
        const errs: string[] = [];
        for (const r of parsed) {
            if (!r.privateKey) errs.push(`Row ${r.__row}: thiếu privateKey`);
            else {
                try {
                    bs58.decode(r.privateKey);
                } catch {
                    errs.push(`Row ${r.__row}: privateKey không phải bs58 hợp lệ (${short(r.privateKey)})`);
                }
            }
            if (!(r.amount > 0)) errs.push(`Row ${r.__row}: amount phải > 0`);
            if (r.tokenMint && !isValidMint(r.tokenMint)) errs.push(`Row ${r.__row}: tokenMint không hợp lệ (${short(r.tokenMint)})`);
        }

        setRows(parsed);
        setProgress({ total: parsed.length, done: 0, ok: 0, fail: 0 });
        if (errs.length) setBatchErrors(errs);
    };

    const fileRef = useRef<HTMLInputElement | null>(null);

    // ------------------------ Batch runner -----------------------------------

    const runBatch = async () => {
        if (!rows.length) {
            setBatchErrors(["Chưa có dữ liệu — hãy Upload file Excel/CSV trước."]);
            return;
        }
        setIsRunning(true);
        setIsPaused(false);
        pauseRef.current = false;
        setStatus("");
        setProgress({ total: rows.length, done: 0, ok: 0, fail: 0 });

        for (let idx = 0; idx < rows.length; idx++) {
            // Pause support
            // eslint-disable-next-line no-await-in-loop
            while (pauseRef.current) await new Promise((r) => setTimeout(r, 200));

            const r = rows[idx];
            const dest = r.tokenMint?.trim() ? r.tokenMint!.trim() : contractAddress.trim();
            const label = `Row#${r.__row ?? idx + 1}`;
            try {
                // eslint-disable-next-line no-await-in-loop
                await swapOnce({ privateKey: r.privateKey, destMintStr: dest, amountSol: r.amount, logPrefix: label });
                setProgress((p) => ({ ...p, done: p.done + 1, ok: p.ok + 1 }));
            } catch (e: any) {
                const fromAxios = e?.response?.data ? `\nAPI: ${JSON.stringify(e.response.data)}` : "";
                log(`${label} → ❌ ${e?.message || String(e)}${fromAxios}`);
                console.error(e);
                setProgress((p) => ({ ...p, done: p.done + 1, fail: p.fail + 1 }));
            }

            // small delay to be gentle to RPC/apis
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

    // ------------------------ UI ---------------------------------------------

    const header = useMemo(() => (
        <div className="bg-green-600 text-white text-center py-4">
            <h1 className="text-xl font-semibold">SOL → Token (Raydium · QuickNode) – Batch by Excel</h1>
        </div>
    ), []);

    return (
        <div className="bg-white rounded-2xl shadow-2xl w-full mx-auto overflow-hidden">
            {header}
            <div className="p-6 space-y-8">
                {/* Network & default token */}
                <div className="grid md:grid-cols-3 gap-4">
                    <div>
                        <label className="block text-sm font-medium mb-2">Network</label>
                        <select
                            value={network}
                            onChange={(e) => onChangeNetwork(e.target.value as NetKey)}
                            className="w-full px-4 py-3 bg-gray-50 border rounded-lg"
                        >
                            <option value="mainnet">Mainnet</option>
                            <option value="devnet">Devnet</option>
                        </select>
                    </div>
                    <div className="md:col-span-2">
                        <label className="block text-sm font-medium mb-2">Default Token Mint (nếu file không có cột tokenMint)</label>
                        <input
                            type="text"
                            value={contractAddress}
                            onChange={(e) => setContractAddress(e.target.value)}
                            className="w-full px-4 py-3 bg-gray-50 border rounded-lg"
                            placeholder={
                                network === "mainnet"
                                    ? "EPjF.. (USDC) / Es9v.. (USDT) / 4k3D.. (RAY)"
                                    : "Gh9Z.. (dUSDC) / DRay3a.. (dRAY)"
                            }
                        />
                    </div>
                </div>

                {/* Single test mode (optional) */}
                <div className="border rounded-xl p-4 bg-gray-50">
                    <div className="flex items-center justify-between mb-3">
                        <h2 className="font-semibold">Test nhanh (1 ví)</h2>
                        <button
                            onClick={() => setShowPrivateKey(!showPrivateKey)}
                            className="text-green-700 flex items-center gap-2"
                            type="button"
                            title={showPrivateKey ? "Hide" : "Show"}
                        >
                            {showPrivateKey ? <EyeOff size={16} /> : <Eye size={16} />} {showPrivateKey ? "Ẩn" : "Hiện"} key
                        </button>
                    </div>
                    <div className="grid md:grid-cols-3 gap-3">
                        <input
                            type={showPrivateKey ? "text" : "password"}
                            value={privateKey}
                            onChange={(e) => setPrivateKey(e.target.value)}
                            className="w-full px-4 py-3 bg-white border rounded-lg"
                            placeholder="privateKey bs58"
                        />
                        <input
                            type="text"
                            value={amountSol}
                            onChange={(e) => setAmountSol(e.target.value)}
                            className="w-full px-4 py-3 bg-white border rounded-lg"
                            placeholder="0.1"
                        />
                        <button onClick={handleSwapSingle} className="bg-green-600 text-white py-3 rounded-lg">
                            Swap (1 ví)
                        </button>
                    </div>
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
                                className="flex items-center gap-2 px-3 py-2 rounded-lg bg-green-50 border text-green-700"
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
                                        <button onClick={runBatch} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-green-600 text-white">
                                            <Play size={16} /> Chạy batch
                                        </button>
                                    ) : (
                                        <>
                                            <button onClick={togglePause} className="flex items-center gap-2 px-3 py-2 rounded-lg border">
                                                {isPaused ? <Play size={16} /> : <Pause size={16} />} {isPaused ? "Tiếp tục" : "Tạm dừng"}
                                            </button>
                                            <button onClick={runBatch} disabled className="flex items-center gap-2 px-3 py-2 rounded-lg bg-gray-200 text-gray-500">
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
                                            <th className="px-3 py-2 text-left">privateKey (bs58)</th>
                                            <th className="px-3 py-2 text-left">amount (SOL)</th>
                                            <th className="px-3 py-2 text-left">tokenMint (override)</th>
                                            <th className="px-3 py-2 text-left">memo</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {rows.map((r, i) => (
                                            <tr key={i} className={i % 2 ? "bg-white" : "bg-gray-50"}>
                                                <td className="px-3 py-2">{r.__row ?? i + 1}</td>
                                                <td className="px-3 py-2 font-mono">{short(r.privateKey, 8)}</td>
                                                <td className="px-3 py-2">{r.amount}</td>
                                                <td className="px-3 py-2 font-mono">{r.tokenMint || <span className="italic text-gray-500">(default)</span>}</td>
                                                <td className="px-3 py-2">{r.memo || ""}</td>
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
                    <button onClick={() => setStatus("")} className="flex-1 bg-gray-600 text-white py-3 rounded-lg">Clear Logs</button>
                </div>
            </div>
        </div>
    );
}

export default SolSwap;
