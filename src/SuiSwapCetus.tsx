// src/SuiSwapCetus.tsx
// Single-file SUI → Token (Cetus) swap — QuickNode-first
// - Mainnet: your QuickNode RPC
// - Testnet: public fullnode
// - Pool lookup: Cetus SDK v2
// - Quote: SDK preSwap (simple & stable)
// - Build swap payload via SDK, send via SDK.FullClient if available, else SuiClient
// - Fetch final status via getTransactionBlock(options) to avoid "undefined"

import React, { useMemo, useState } from "react";
import { Eye, EyeOff } from "lucide-react";

import { SuiClient } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { fromBase64 } from "@mysten/bcs";

// ✅ Cetus SDK v2
import { CetusClmmSDK } from "@cetusprotocol/sui-clmm-sdk";

/* ----------------------------------------------------------------------------
 * CONFIG
 * --------------------------------------------------------------------------*/
type SuiNetKey = "mainnet" | "testnet";
const SUI = "0x2::sui::SUI";

const NETWORKS: Record<SuiNetKey, { rpc: string; explorerTx: (d: string) => string; env: "mainnet" | "testnet" }> = {
    mainnet: {
        // QuickNode mainnet (provided by you)
        rpc: "https://necessary-cool-waterfall.sui-mainnet.quiknode.pro/f965569b37ae159010d579b803fdbcb2042f4091",
        explorerTx: (d) => `https://suivision.xyz/txblock/${d}`,
        env: "mainnet",
    },
    testnet: {
        // Public testnet (QuickNode testnet not available)
        rpc: "https://fullnode.testnet.sui.io:443",
        explorerTx: (d) => `https://suivision.xyz/txblock/${d}?network=testnet`,
        env: "testnet",
    },
};

const GAS_RESERVE = 20_000_000n; // ~0.02 SUI gas buffer

/* ----------------------------------------------------------------------------
 * UTILS
 * --------------------------------------------------------------------------*/
function formatSui(n: bigint) {
    return (Number(n) / 1e9).toLocaleString(undefined, { maximumFractionDigits: 9 });
}

function minOutWithSlippage(estOut: bigint, slipPercent: number): bigint {
    const pct = Math.max(0, Math.min(100, slipPercent));
    const bps = Math.round(pct * 100); // 1% = 100 bps
    return (estOut * BigInt(10_000 - bps)) / 10_000n;
}

function keypairFromString(sk: string) {
    const s = sk.trim();
    if (!s) throw new Error("Private key is empty");
    if (s.startsWith("suiprivkey")) {
        const { secretKey } = decodeSuiPrivateKey(s);
        return Ed25519Keypair.fromSecretKey(secretKey);
    }
    // base64 33-byte (1 scheme + 32 seed)
    const raw = fromBase64(s);
    if (raw.length !== 33) throw new Error("Expect base64 33-byte Sui private key or suiprivkey-*");
    return Ed25519Keypair.fromSecretKey(raw.slice(1));
}

// Weak-shape helpers (SDK responses vary slightly by version)
function normalizePoolList(raw: any): any[] {
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    if (Array.isArray(raw?.data)) return raw.data;
    if (Array.isArray(raw?.pools)) return raw.pools;
    if (Array.isArray(raw?.list)) return raw.list;
    if (Array.isArray(raw?.data?.pools)) return raw.data.pools;
    if (Array.isArray(raw?.data?.lp_list)) return raw.data.lp_list;
    if (Array.isArray(raw?.lp_list)) return raw.lp_list;
    return [];
}
const poolIdOf = (p: any) => p?.id ?? p?.pool_id ?? p?.poolId ?? p?.poolAddress;
const coinAOf = (p: any) => p?.coin_type_a ?? p?.coinTypeA ?? p?.coin_a?.type;
const coinBOf = (p: any) => p?.coin_type_b ?? p?.coinTypeB ?? p?.coin_b?.type;

/* ----------------------------------------------------------------------------
 * COMPONENT
 * --------------------------------------------------------------------------*/
export default function SuiSwapCetus() {
    const [network, setNetwork] = useState<SuiNetKey>("testnet");
    const [priv, setPriv] = useState(""); const [show, setShow] = useState(false);

    const [coinOut, setCoinOut] = useState("");      // full coin type of target token
    const [poolId, setPoolId] = useState("");        // optional forced pool id
    const [amountSui, setAmountSui] = useState("0.1");
    const [slippagePct, setSlippagePct] = useState("0.5");
    const [status, setStatus] = useState("");

    const net = useMemo(() => NETWORKS[network], [network]);
    const log = (s: string) => setStatus((p) => (p ? p + "\n" + s : s));

    async function handleSwap() {
        setStatus("");
        try {
            /* 1) RPC & signer */
            const client = new SuiClient({ url: net.rpc });
            const kp = keypairFromString(priv);
            const sender = kp.getPublicKey().toSuiAddress();

            const ui = parseFloat(String(amountSui).replace(",", "."));
            if (!isFinite(ui) || ui <= 0) throw new Error("Số lượng SUI không hợp lệ");
            const amountIn = BigInt(Math.floor(ui * 1e9));
            const slip = Math.max(0, Math.min(100, Number(slippagePct)));

            log(`🔗 RPC: ${net.rpc}`);
            log(`👤 Sender: ${sender}`);
            log(`🎯 Coin out: ${coinOut || "(chưa nhập)"}`);
            log(`💵 Amount in: ${formatSui(amountIn)} SUI`);

            /* 2) Guard balance */
            const bal = await client.getBalance({ owner: sender, coinType: SUI });
            const total = BigInt(bal.totalBalance);
            if (total < amountIn + GAS_RESERVE) {
                throw new Error(`Không đủ SUI (cần ~${formatSui(amountIn + GAS_RESERVE)} SUI, có ${formatSui(total)} SUI)`);
            }

            /* 3) Init Cetus SDK v2 (bound to our client/RPC) */
            const sdk = CetusClmmSDK.createSDK({
                env: net.env,            // 'mainnet' | 'testnet'
                sui_client: client as any,
                full_rpc_url: net.rpc,
            });
            sdk.setSenderAddress?.(sender);

            /* 4) Resolve pool */
            const outType = coinOut.trim();
            if (!outType.includes("::")) throw new Error("Coin out phải là coin type đầy đủ (0x..::module::NAME).");

            let pool: any;
            if (poolId.trim()) {
                log(`📌 Ép pool: ${poolId.trim()}`);
                pool = await sdk.Pool.getPool(poolId.trim());
            } else {
                log("🔎 Tìm pool bằng sdk.Pool.getPoolByCoins …");
                const res = await sdk.Pool.getPoolByCoins([SUI, outType]);
                const list = normalizePoolList(res);
                if (!list.length) throw new Error("Không tìm thấy pool SUI ↔ token đích trên Cetus.");
                list.sort((a: any, b: any) => Number((b.liquidity ?? b.liquidity_value ?? 0)) - Number((a.liquidity ?? a.liquidity_value ?? 0)));
                pool = list[0];
            }

            const pid = poolIdOf(pool);
            const coinA = coinAOf(pool);
            const coinB = coinBOf(pool);
            if (!pid || !coinA || !coinB) throw new Error("Pool thiếu id/coin types.");

            log(`✅ Pool: ${pid}`);
            log(`   A: ${coinA}`);
            log(`   B: ${coinB}`);

            const a2b =
                coinA === SUI && coinB === outType ? true :
                    coinB === SUI && coinA === outType ? false :
                        (() => { throw new Error("Pool không match với SUI và token đích"); })();

            /* 5) Metadata (decimals) for preSwap */
            const [metaA, metaB] = await Promise.all([
                client.getCoinMetadata({ coinType: coinA }),
                client.getCoinMetadata({ coinType: coinB }),
            ]);
            const decA = (metaA?.decimals ?? (coinA === SUI ? 9 : 9)) as number;
            const decB = (metaB?.decimals ?? (coinB === SUI ? 9 : 9)) as number;

            /* 6) Quote via SDK preSwap (simple & stable) */
            const pre = await sdk.Swap.preSwap({
                pool,
                current_sqrt_price: pool.current_sqrt_price ?? pool.current_sqrt_price_x64 ?? pool.sqrt_price,
                coin_type_a: coinA,
                coin_type_b: coinB,
                decimals_a: decA,
                decimals_b: decB,
                a2b,
                by_amount_in: true,
                amount: amountIn.toString(),
            });
            const estOut = BigInt(pre?.estimated_amount_out ?? pre?.estimatedAmountOut ?? 0);
            if (estOut <= 0n) throw new Error("Không ước lượng được amount out (preSwap trả về 0).");
            const minOut = minOutWithSlippage(estOut, slip);

            log(`🧮 Estimated out: ${estOut.toString()} (atomic)`);
            log(`🧷 Min out (@${slip}%): ${minOut.toString()} (atomic)`);

            /* 7) Build swap payload (SDK v2) */
            const params = {
                pool,
                pool_id: pid,
                coin_type_a: coinA,
                coin_type_b: coinB,
                a2b,
                by_amount_in: true,
                amount: amountIn.toString(),
                amount_limit: minOut.toString(),
            } as any;

            let payload: any;
            if (typeof sdk.Swap.createSwapPayload === "function") {
                payload = await sdk.Swap.createSwapPayload(params);
            } else if (typeof sdk.Swap.createSwapWithoutTransferCoinsPayload === "function") {
                payload = await sdk.Swap.createSwapWithoutTransferCoinsPayload(params);
            } else {
                throw new Error("SDK v2 thiếu createSwapPayload/createSwapWithoutTransferCoinsPayload");
            }

            /* 8) Send transaction */
            const sendViaSdk =
                (sdk as any).FullClient?.sendTransaction ||
                (sdk as any).fullClient?.sendTransaction;

            let digest = "";
            if (sendViaSdk) {
                const resp = await sendViaSdk.call((sdk as any).FullClient || (sdk as any).fullClient, kp, payload);
                digest =
                    (resp as any)?.digest ||
                    (resp as any)?.certificate?.transactionDigest ||
                    (typeof resp === "string" ? resp : "");
            } else {
                const resp = await client.signAndExecuteTransaction({
                    signer: kp,
                    transaction: (payload as any).tx ?? payload, // handle different shapes
                    options: { showEffects: true, showEvents: true },
                });
                digest =
                    (resp as any)?.digest ||
                    (resp as any)?.certificate?.transactionDigest ||
                    (typeof resp === "string" ? resp : "");
            }

            if (!digest) throw new Error("Không lấy được digest sau khi gửi.");

            // 🚩 FIX: fetch status explicitly with options (avoid undefined)
            const tx = await client.getTransactionBlock({
                digest,
                options: {
                    showEffects: true,
                    showEvents: true,
                    showObjectChanges: true,
                    showBalanceChanges: true,
                },
            });
            const statusStr =
                (tx as any)?.effects?.status?.status ??
                (tx as any)?.effects?.status ??
                "unknown";

            log(`✅ Submitted: ${digest}`);
            log(`🔎 Explorer: ${net.explorerTx(digest)}`);
            log(`📊 Status: ${statusStr}`);
        } catch (e: any) {
            log(`❌ ${e?.message || String(e)}`);
            console.error(e);
        }
    }

    return (
        <div className="bg-white rounded-2xl shadow-2xl w-full mx-auto overflow-hidden">
            <div className="bg-emerald-600 text-white text-center py-4">
                <h1 className="text-lg font-semibold">SUI → Token (Cetus · {network === "mainnet" ? "QuickNode" : "Testnet"})</h1>
            </div>

            <div className="p-6 space-y-6">
                <div>
                    <label className="block text-sm font-medium mb-2">Network</label>
                    <select
                        value={network}
                        onChange={(e) => setNetwork(e.target.value as SuiNetKey)}
                        className="w-full px-4 py-3 bg-gray-50 border rounded-lg"
                    >
                        <option value="mainnet">Mainnet (QuickNode)</option>
                        <option value="testnet">Testnet (public fullnode)</option>
                    </select>
                </div>

                <div>
                    <label className="block text-sm font-medium mb-2">Private Key (Sui)</label>
                    <div className="relative">
                        <input
                            type={show ? "text" : "password"}
                            value={priv}
                            onChange={(e) => setPriv(e.target.value)}
                            className="w-full px-4 py-3 bg-gray-50 border rounded-lg pr-12"
                            placeholder="suiprivkey-... hoặc base64 33-byte"
                            autoComplete="off"
                            spellCheck={false}
                        />
                        <button
                            type="button"
                            onClick={() => setShow((v) => !v)}
                            className="absolute right-3 top-1/2 -translate-y-1/2 text-emerald-600"
                        >
                            {show ? <EyeOff size={18} /> : <Eye size={18} />}
                        </button>
                    </div>
                </div>

                <div>
                    <label className="block text-sm font-medium mb-2">Coin Address (coin type đích)</label>
                    <input
                        type="text"
                        value={coinOut}
                        onChange={(e) => setCoinOut(e.target.value)}
                        className="w-full px-4 py-3 bg-gray-50 border rounded-lg"
                        placeholder={network === "testnet" ? "vd: 0xa1ec7f..::usdc::USDC" : "vd: 0xe14726..::usdb::USDB"}
                        autoComplete="off"
                        spellCheck={false}
                    />
                </div>

                <div>
                    <label className="block text-sm font-medium mb-2">Pool Address (tùy chọn)</label>
                    <input
                        type="text"
                        value={poolId}
                        onChange={(e) => setPoolId(e.target.value)}
                        className="w-full px-4 py-3 bg-gray-50 border rounded-lg"
                        placeholder="Nếu bỏ trống: tự tìm qua SDK"
                        autoComplete="off"
                        spellCheck={false}
                    />
                </div>

                <div className="grid grid-cols-2 gap-4">
                    <div>
                        <label className="block text-sm font-medium mb-2">Amount (SUI)</label>
                        <input
                            type="text"
                            value={amountSui}
                            onChange={(e) => setAmountSui(e.target.value)}
                            className="w-full px-4 py-3 bg-gray-50 border rounded-lg"
                            placeholder="0.1"
                        />
                    </div>
                    <div>
                        <label className="block text-sm font-medium mb-2">Slippage (%)</label>
                        <input
                            type="number"
                            min={0}
                            step={0.1}
                            value={slippagePct}
                            onChange={(e) => setSlippagePct(e.target.value)}
                            className="w-full px-4 py-3 bg-gray-50 border rounded-lg"
                            placeholder="0.5"
                        />
                    </div>
                </div>

                <pre className="text-xs bg-gray-50 p-3 rounded-lg whitespace-pre-wrap break-words h-64 overflow-auto">
                    {status}
                </pre>

                <div className="flex gap-4">
                    <button onClick={handleSwap} className="flex-1 bg-emerald-600 text-white py-3 rounded-lg">Swap</button>
                    <button onClick={() => setStatus("")} className="flex-1 bg-gray-600 text-white py-3 rounded-lg">Clear Logs</button>
                </div>
            </div>
        </div>
    );
}
