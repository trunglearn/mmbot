import React, { useState } from "react";
import bs58 from "bs58";
import * as bip39 from "bip39";
import { derivePath } from "ed25519-hd-key";
import { Keypair } from "@solana/web3.js";

type WalletRow = {
    idx: number;
    address: string;
    base58: string;
    secretArray: number[];
    mnemonic: string;
};

export default function SolanaWalletFactory() {
    const [count, setCount] = useState<number>(5);
    const [rows, setRows] = useState<WalletRow[]>([]);
    const [busy, setBusy] = useState(false);
    const [copied, setCopied] = useState<string | null>(null);

    async function generate() {
        if (!count || count <= 0) return;
        setBusy(true);
        try {
            const out: WalletRow[] = [];
            for (let i = 0; i < count; i++) {
                const mnemonic = bip39.generateMnemonic(128);
                const seed = await bip39.mnemonicToSeed(mnemonic);
                const { key } = derivePath("m/44'/501'/0'/0'", seed.toString("hex"));
                const kp = Keypair.fromSeed(key);
                const address = kp.publicKey.toBase58();
                const secretArray = Array.from(kp.secretKey);
                const base58Priv = bs58.encode(kp.secretKey);
                out.push({ idx: i + 1, address, base58: base58Priv, secretArray, mnemonic });
            }
            setRows(out);
        } finally {
            setBusy(false);
        }
    }

    async function copy(text: string, id: string) {
        await navigator.clipboard.writeText(text);
        setCopied(id);
        setTimeout(() => setCopied(null), 1200);
    }

    function exportCSV() {
        const header = ["Address", "Base58 PrivateKey", "PrivateKey", "Mnemonic"];
        const lines: string[] = [header.join(",")];
        for (const r of rows) {
            const secretJson = JSON.stringify(r.secretArray).replace(/"/g, '""');
            const mnem = r.mnemonic.replace(/"/g, '""');
            lines.push([r.address, r.base58, `"${secretJson}"`, `"${mnem}"`].join(","));
        }
        const BOM = "\uFEFF";
        const NL = "\r\n";
        const csv = BOM + lines.join(NL);
        const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `solana_wallets_${Date.now()}.csv`;
        a.click();
        URL.revokeObjectURL(url);
    }

    function clearAll() {
        setRows([]);
    }

    return (
        // ✅ Wrapper trung tính: KHÔNG set bg trắng full màn
        <section className="container mx-auto max-w-5xl px-4 py-8">
            {/* Card trung tâm */}
            <div className="bg-white rounded-2xl shadow-2xl w-full mx-auto overflow-hidden max-w-2xl ring-1 ring-amber-100">
                {/* HEAD */}
                <div className="bg-amber-500 text-white text-center py-4 rounded-t-2xl">
                    <h2 className="text-xl font-semibold leading-tight">Solana Wallet Factory</h2>
                    <p className="text-sm opacity-90">Tạo nhiều ví · Copy nhanh · Xuất CSV (UTF-8 BOM)</p>
                </div>

                {/* BODY */}
                <div className="p-6 space-y-6">
                    {/* Chain */}
                    <div>
                        <label className="block text-sm font-medium mb-2">Chain</label>
                        <select
                            className="w-full h-12 bg-amber-50 border border-amber-200 rounded-lg px-4 text-amber-800"
                            disabled
                        >
                            <option>Solana</option>
                        </select>
                        <div className="text-xs text-gray-500 mt-1">
                            Derivation: <code>m/44&apos;/501&apos;/0&apos;/0&apos;</code> · Mỗi ví một mnemonic 12 từ
                        </div>
                    </div>

                    {/* Count + Generate */}
                    <div>
                        <label className="block text-sm font-medium mb-2">Số lượng ví</label>
                        <div className="flex gap-3">
                            <input
                                type="number"
                                min={1}
                                className="flex-1 h-12 bg-white border border-amber-200 rounded-lg px-4 focus:outline-none focus:ring-2 focus:ring-amber-400/70"
                                value={count}
                                onChange={(e) => setCount(parseInt(e.target.value || "0"))}
                            />
                            <button
                                onClick={generate}
                                disabled={busy || !count || count <= 0}
                                className="h-12 px-4 rounded-lg bg-amber-500 text-white font-semibold disabled:opacity-50 shadow"
                                title="Generate"
                            >
                                Tạo ví
                            </button>
                        </div>
                        <div className="text-xs text-gray-500 mt-1">Tạo mới sẽ thay thế danh sách hiện tại.</div>
                    </div>

                    {/* Actions */}
                    <div className="flex gap-3">
                        <button
                            onClick={exportCSV}
                            disabled={!rows.length}
                            className="flex-1 h-12 px-4 rounded-lg bg-amber-500 text-white font-semibold disabled:opacity-50 shadow"
                        >
                            ⬇️ Export CSV
                        </button>
                        <button
                            onClick={clearAll}
                            disabled={!rows.length}
                            className="flex-1 h-12 px-4 rounded-lg bg-amber-50 text-amber-800 border border-amber-200 hover:bg-amber-100 disabled:opacity-50"
                        >
                            Clear
                        </button>
                    </div>

                    {/* LIST */}
                    <div className="space-y-4">
                        {rows.map((r) => (
                            <div
                                key={r.idx}
                                className="rounded-xl bg-white text-gray-900 shadow ring-1 ring-amber-100 overflow-hidden"
                            >
                                <div className="px-4 py-2 bg-amber-50 border-b border-amber-100 flex items-center gap-3">
                                    <div className="w-6 h-6 rounded-full bg-amber-500 text-white text-sm grid place-items-center">
                                        {r.idx}
                                    </div>
                                    <div className="text-sm text-amber-800 font-medium">Wallet #{r.idx}</div>
                                </div>

                                <FieldRow
                                    label="Address"
                                    value={r.address}
                                    onCopy={() => copy(r.address, `addr-${r.idx}`)}
                                    copied={copied === `addr-${r.idx}`}
                                />
                                <FieldRow
                                    label="Base58 PrivateKey"
                                    value={r.base58}
                                    onCopy={() => copy(r.base58, `b58-${r.idx}`)}
                                    copied={copied === `b58-${r.idx}`}
                                />
                                <FieldRow
                                    label="PrivateKey (64 bytes array)"
                                    value={JSON.stringify(r.secretArray)}
                                    mono
                                    onCopy={() => copy(JSON.stringify(r.secretArray), `arr-${r.idx}`)}
                                    copied={copied === `arr-${r.idx}`}
                                />
                                <FieldRow
                                    label="Mnemonic (12 words)"
                                    value={r.mnemonic}
                                    onCopy={() => copy(r.mnemonic, `mne-${r.idx}`)}
                                    copied={copied === `mne-${r.idx}`}
                                />
                            </div>
                        ))}

                        {!rows.length && (
                            <p className="text-center text-amber-400">
                                Chưa có ví nào. Nhập số lượng và bấm <b>Tạo ví</b>.
                            </p>
                        )}
                    </div>
                </div>
            </div>
        </section>
    );
}

/* -------------------------- Field row -------------------------- */
function FieldRow({
    label,
    value,
    onCopy,
    mono,
    copied,
}: {
    label: string;
    value: string;
    onCopy: () => void;
    mono?: boolean;
    copied?: boolean;
}) {
    return (
        <div className="grid grid-cols-1 md:grid-cols-12 gap-3 px-4 py-3 border-t border-amber-100 items-center">
            <div className="md:col-span-3 text-sm text-amber-800">{label}</div>
            <div
                className={`md:col-span-7 text-sm bg-amber-50 rounded-lg px-3 py-2 overflow-x-auto ${mono ? "font-mono" : ""}`}
            >
                {value}
            </div>
            <div className="md:col-span-2">
                <button
                    onClick={onCopy}
                    className="w-full md:w-auto h-10 px-3 py-2 rounded-lg bg-amber-200 hover:bg-amber-300 text-amber-900 text-sm"
                >
                    {copied ? "Copied ✓" : "Copy"}
                </button>
            </div>
        </div>
    );
}
