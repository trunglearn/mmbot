// FourMemeBuy.tsx
// FE-only buyer cho four.meme (06–09/2025).
// Chỉ BY_FUNDS (AMAP). Tự động chọn route: TM *AMAP (BNB/quote=0) hoặc
// - ERC20 pair: auto quyết định dùng Helper3.buyWithEth (nếu bạn chỉ có BNB / thiếu quote/allowance)
//   hoặc dùng ERC20 trực tiếp (approve nếu cần).
// npm i ethers lucide-react

import React, { useState } from "react";
import { Eye, EyeOff, Play } from "lucide-react";
import { ethers } from "ethers";

// ========= Chain config =========
const BSC = {
    chainId: 56,
    name: "BNB Smart Chain",
    rpc: "https://bsc-dataseed.binance.org",
    helper3: "0xF251F83e40a78868FcfA3FA4599Dad6494E46034", // docs 01/02/2025
};

// ========= Minimal ABIs =========
const HELPER3_ABI = [
    "function getTokenInfo(address token) view returns (uint256 version, address tokenManager, address quote, uint256 lastPrice, uint256 tradingFeeRate, uint256 minTradingFee, uint256 launchTime, uint256 offers, uint256 maxOffers, uint256 funds, uint256 maxFunds, bool liquidityAdded)",
    "function tryBuy(address token, uint256 amount, uint256 funds) view returns (address tokenManager, address quote, uint256 estimatedAmount, uint256 estimatedCost, uint256 estimatedFee, uint256 amountMsgValue, uint256 amountApproval, uint256 amountFunds)",
    "function buyWithEth(uint256 origin, address token, address to, uint256 funds, uint256 minAmount) payable",
];

const ERC20_ABI = [
    "function balanceOf(address owner) view returns (uint256)",
    "function allowance(address owner, address spender) view returns (uint256)",
    "function approve(address spender, uint256 amount) returns (bool)",
    "function decimals() view returns (uint8)",
    "function symbol() view returns (string)",
];

const TM_V1_ABI = [
    "function purchaseTokenAMAP(address token, uint256 funds, uint256 minAmount) payable",
];

const TM_V2_ABI = [
    "function buyTokenAMAP(address token, uint256 funds, uint256 minAmount) payable",
];

// ========= Utils =========
const GWEI = 1_000_000_000n;
const to18 = (s: string) => ethers.parseUnits((s || "0").trim(), 18);
const fmt18 = (x?: bigint) => ethers.formatUnits(x ?? 0n, 18);
const isZeroAddr = (a: string) => a?.toLowerCase?.() === ethers.ZeroAddress;

function stripInv(s: string) {
    return s.replace(/[\u200B-\u200D\uFEFF]/g, "").replace(/\u00A0/g, " ").replace(/[\r\n\t]/g, "").trim();
}
function sanitizePk(raw: string) {
    let s = raw.replace(/^"+|"+$/g, "").replace(/^'+|'+$/g, "");
    s = stripInv(s).replace(/\s+/g, "");
    if (!s.startsWith("0x")) s = "0x" + s;
    return s;
}
function validatePk(raw: string) {
    const s = sanitizePk(raw);
    const body = s.startsWith("0x") ? s.slice(2) : s;
    if (body.length !== 64) return { ok: false, reason: `Độ dài không đúng (${body.length}/64)` };
    const m = body.match(/[^0-9a-fA-F]/);
    if (m) return { ok: false, reason: `Có ký tự không phải hex: "${m[0]}"` };
    return { ok: true, reason: "" };
}
const floorToGwei = (x: bigint) => (x / GWEI) * GWEI;
const applySlippageDown = (amount: bigint, bps: number) => (amount * BigInt(10000 - bps)) / 10000n; // floor
function decodeErr(e: any): string {
    const raw = e?.data || e?.info?.error?.data || e?.error?.data;
    if (!raw || raw === "0x") return e?.shortMessage || e?.reason || e?.message || String(e);
    try {
        if (raw.startsWith("0x08c379a0")) {
            const iface = new ethers.Interface(["function Error(string)"]);
            const out = iface.decodeErrorResult("Error", raw);
            return `Error(string): ${out?.[0]}`;
        }
        if (raw.startsWith("0x4e487b71")) {
            const abi = ethers.AbiCoder.defaultAbiCoder();
            const code = abi.decode(["uint256"], ("0x" + raw.slice(10)))?.[0];
            return `Panic(uint256): ${code?.toString?.()}`;
        }
    } catch { }
    return `Unknown revert: ${raw}`;
}

// ========= Component =========
export default function FourMemeBuy() {
    // Inputs
    const [pk, setPk] = useState("");
    const [showPk, setShowPk] = useState(false);
    const [token, setToken] = useState("");

    // BY_FUNDS only
    const [fundsStr, setFundsStr] = useState("0.002"); // nên >= 0.002 cho phí + precision
    const [slipBps, setSlipBps] = useState("100"); // 1%

    // State
    const [busy, setBusy] = useState(false);
    const [logs, setLogs] = useState("");
    const [info, setInfo] = useState<any | null>(null);
    const [est, setEst] = useState<any | null>(null);

    const log = (s: string) => setLogs((p) => (p ? p + "\n" + s : s));
    const clearLog = () => setLogs("");

    function getWallet() {
        const v = validatePk(pk);
        if (!v.ok) throw new Error(`Private key không hợp lệ: ${v.reason}`);
        if (!ethers.isAddress(token)) throw new Error("Địa chỉ token không hợp lệ");
        const provider = new ethers.JsonRpcProvider(BSC.rpc, { chainId: BSC.chainId, name: BSC.name });
        return new ethers.Wallet(sanitizePk(pk), provider);
    }

    // ---- Quote ----
    async function handleQuote() {
        try {
            setBusy(true);
            clearLog();
            log("Đang lấy báo giá…");

            const w = getWallet();
            const helper = new ethers.Contract(BSC.helper3, HELPER3_ABI, w);

            const bps = Math.max(0, Math.min(5000, parseInt(slipBps || "0", 10) || 0));
            const funds = floorToGwei(to18(fundsStr)); // GW - GWEI

            const _info = await helper.getTokenInfo(token);
            const [
                version,
                tokenManager,
                quote,
                , // lastPrice
                feeRate,
                minFee,
                launchTime,
                offers,
                maxOffers,
                fundsCur,
                maxFundsCap,
                liquidityAdded
            ] = _info as any;

            const res = await helper.tryBuy(token, 0n, funds);
            const [
                tmFromTry,
                quoteFromTry,
                estimatedAmount,
                estimatedCost,
                estimatedFee,
                amountMsgValue,
                amountApproval,
                amountFunds
            ] = res as any;

            setInfo({
                version, tokenManager, quote, feeRate, minFee, launchTime,
                offers, maxOffers, fundsCur, maxFundsCap, liquidityAdded
            });
            setEst({
                tokenManager: tmFromTry,
                quote: quoteFromTry,
                estimatedAmount,
                estimatedCost,
                estimatedFee,
                amountMsgValue,
                amountApproval,
                amountFunds,
                slipBps: bps
            });

            const launchDate = new Date(Number(launchTime) * 1000);
            log([
                "Quote xong:",
                `- version: ${version.toString()}`,
                `- manager: ${tmFromTry}`,
                `- quote:   ${quoteFromTry}`,
                `- estimatedAmount: ${fmt18(estimatedAmount)}`,
                `- estimatedCost:   ${fmt18(estimatedCost)}`,
                `- estimatedFee:    ${fmt18(estimatedFee)}`,
                `- amountMsgValue:  ${fmt18(amountMsgValue)}`,
                `- amountApproval:  ${fmt18(amountApproval)}`,
                `- amountFunds:     ${fmt18(amountFunds)}`,
                `- liquidityAdded:  ${liquidityAdded ? "true" : "false"}`,
                `- offers/max:      ${offers.toString()} / ${maxOffers.toString()}`,
                `- funds/max:       ${fmt18(fundsCur)} / ${fmt18(maxFundsCap)}`,
                `- launchTime:      ${launchTime.toString()} (UTC ${launchDate.toISOString()})`,
                `- fee:             rate=${fmt18(feeRate)} min=${fmt18(minFee)}`,
                `- slippage(bps):   ${bps}`,
            ].join("\n"));
        } catch (e: any) {
            log(`Lỗi quote: ${decodeErr(e)}`);
        } finally {
            setBusy(false);
        }
    }

    // ---- Buy (BY_FUNDS only, auto route) ----
    async function handleBuy() {
        try {
            setBusy(true);
            if (!est || !info) throw new Error("Hãy Quote trước");

            const w = getWallet();
            const helper = new ethers.Contract(BSC.helper3, HELPER3_ABI, w);

            // Kiểm tra rule protocol
            const _info = await helper.getTokenInfo(token);
            const [
                version,
                , // tokenManager
                quote,
                , , ,
                launchTime,
                offers,
                maxOffers,
                fundsCur,
                maxFundsCap,
                liquidityAdded
            ] = _info as any;

            const now = Math.floor(Date.now() / 1000);
            if (Number(launchTime) > now) throw new Error("Token đang pre-launch (chưa tới launchTime)");
            if (liquidityAdded) throw new Error("Token đã add LP → mua qua AMM");
            if (offers >= maxOffers) throw new Error("Offers đã đầy");
            if (fundsCur >= maxFundsCap) throw new Error("Funds đã đạt trần");

            // Re-quote theo input hiện tại
            const fundsIn = floorToGwei(to18(fundsStr));
            const _est = await helper.tryBuy(token, 0n, fundsIn);
            const [
                tmFromTry,
                quoteFromTry,
                estimatedAmount,
                estimatedCost,
                , // estimatedFee
                amountMsgValue,
                amountApproval,
                amountFunds
            ] = _est as any;

            const bps = Math.max(0, Math.min(5000, parseInt(String(est.slipBps) || "0", 10) || 0));
            const minAmount = applySlippageDown(estimatedAmount, bps);
            const isV2 = (version.toString() === "2");
            const me = await w.getAddress();
            const payInBNB = isZeroAddr(quoteFromTry);

            if (payInBNB) {
                // ===== BNB pair → TM.*AMAP với value =====
                const tm = new ethers.Contract(tmFromTry, isV2 ? TM_V2_ABI : TM_V1_ABI, w);
                const value = floorToGwei(amountMsgValue);
                const fundsParam = floorToGwei(amountFunds);
                const label = isV2 ? "V2 buyTokenAMAP" : "V1 purchaseTokenAMAP";
                log(`Auto route: BNB pair → ${label}`);

                const tx = isV2
                    ? await tm.buyTokenAMAP(token, fundsParam, minAmount, { value })
                    : await tm.purchaseTokenAMAP(token, fundsParam, minAmount, { value });

                log(`Tx sent (${label}): ${tx.hash}`);
                const rc = await tx.wait();
                log(`→ Thành công (${label}), gasUsed=${rc?.gasUsed?.toString?.()}`);
                return;
            }

            // ===== ERC20 pair → auto quyết định =====
            const erc = new ethers.Contract(quoteFromTry, ERC20_ABI, w);
            const [balanceQuote, allowance] = await Promise.all([
                erc.balanceOf(me) as Promise<bigint>,
                erc.allowance(me, tmFromTry) as Promise<bigint>,
            ]);

            const needQuote = amountFunds;     // số quote cần chi nếu trả bằng ERC20
            const needApprove = amountApproval;

            const haveEnoughQuote = balanceQuote >= needQuote;
            const haveEnoughAllowance = allowance >= needApprove;

            if (!haveEnoughQuote || !haveEnoughAllowance) {
                // → dùng BNB qua Helper3.buyWithEth
                log(
                    `Auto route: ERC20 pair → Helper3.buyWithEth (haveQuote=${fmt18(balanceQuote)} < needQuote=${fmt18(needQuote)} || allowance=${fmt18(allowance)} < needApprove=${fmt18(needApprove)})`
                );

                const fundsParam = floorToGwei(amountFunds);
                const tx = await helper.buyWithEth(0, token, ethers.ZeroAddress, fundsParam, minAmount, { value: fundsParam });
                log(`Tx sent (Helper3.buyWithEth): ${tx.hash}`);
                const rc = await tx.wait();
                log(`→ Thành công (Helper3.buyWithEth), gasUsed=${rc?.gasUsed?.toString?.()}`);
                return;
            }

            // Đủ quote & allowance → dùng ERC20 trực tiếp (approve nếu thiếu – nhưng tới đây đã đủ)
            log("Auto route: ERC20 pair → TokenManager.*AMAP (trả bằng ERC20)");
            const tm = new ethers.Contract(tmFromTry, isV2 ? TM_V2_ABI : TM_V1_ABI, w);
            const tx = isV2
                ? await tm.buyTokenAMAP(token, needQuote, minAmount)
                : await tm.purchaseTokenAMAP(token, needQuote, minAmount);

            log(`Tx sent (${isV2 ? "V2 buyTokenAMAP (ERC20)" : "V1 purchaseTokenAMAP (ERC20)"}): ${tx.hash}`);
            const rc = await tx.wait();
            log(`→ Thành công, gasUsed=${rc?.gasUsed?.toString?.()}`);
        } catch (e: any) {
            log(`Lỗi mua: ${decodeErr(e)}`);
        } finally {
            setBusy(false);
        }
    }

    const pkLen = (() => {
        const s = sanitizePk(pk);
        const body = s.startsWith("0x") ? s.slice(2) : s;
        return body.length;
    })();

    return (
        <div className="bg-white rounded-2xl shadow-2xl w-full mx-auto overflow-hidden max-w-2xl">
            <div className="bg-amber-500 text-white text-center py-4">
                <h2 className="text-xl font-semibold">Buy on four.meme (BY_FUNDS · auto route)</h2>
                <p className="text-sm opacity-90">Helper3.getTokenInfo/tryBuy → auto chọn: TM *AMAP (BNB) hoặc Helper3.buyWithEth / ERC20 *AMAP</p>
            </div>

            <div className="p-6 space-y-6">
                {/* Private key */}
                <div>
                    <label className="block text-sm font-medium mb-2">Private Key (BSC) – dùng ví burner/test</label>
                    <div className="flex gap-2 items-center">
                        <input
                            type={showPk ? "text" : "password"}
                            value={pk}
                            onChange={(e) => setPk(e.target.value)}
                            className="w-full px-4 py-3 bg-gray-50 border rounded-lg font-mono"
                            placeholder="0x... / 64-hex"
                            autoComplete="off"
                            spellCheck={false}
                        />
                        <button onClick={() => setShowPk(!showPk)} className="text-amber-700 flex items-center gap-1 px-2 py-1 rounded border" type="button">
                            {showPk ? <EyeOff size={16} /> : <Eye size={16} />} {showPk ? "Ẩn" : "Hiện"}
                        </button>
                    </div>
                    <div className="text-xs text-gray-500 mt-1">Length sau chuẩn hoá: {pkLen} / 64</div>
                    <div className="text-xs text-red-600 mt-1">Đừng dùng khoá chính trên app công khai.</div>
                </div>

                {/* Token */}
                <div>
                    <label className="block text-sm font-medium mb-2">Token address (BSC)</label>
                    <input
                        type="text"
                        value={token}
                        onChange={(e) => setToken(e.target.value.trim())}
                        className="w-full px-4 py-3 bg-gray-50 border rounded-lg font-mono"
                        placeholder="0x..."
                        autoComplete="off"
                        spellCheck={false}
                    />
                </div>

                {/* Funds + Slippage */}
                <div className="grid md:grid-cols-3 gap-4">
                    <div>
                        <label className="block text-sm font-medium mb-2">BNB muốn chi</label>
                        <input
                            type="text"
                            value={fundsStr}
                            onChange={(e) => setFundsStr(e.target.value)}
                            className="w-full px-4 py-3 bg-white border rounded-lg"
                            placeholder="0.002"
                        />
                        <div className="text-xs text-gray-500 mt-1">Sẽ căn theo GWEI (1e9 wei).</div>
                    </div>

                    <div>
                        <label className="block text-sm font-medium mb-2">Slippage (bps)</label>
                        <input
                            type="number"
                            min={0}
                            max={5000}
                            value={slipBps}
                            onChange={(e) => setSlipBps(e.target.value)}
                            className="w-full px-4 py-3 bg-white border rounded-lg"
                            placeholder="100 = 1%"
                        />
                    </div>

                    <div>
                        <label className="block text-sm font-medium mb-2">Route được chọn</label>
                        <div className="text-xs text-gray-600">
                            Ẩn trong UI – hệ thống tự chọn dựa vào <code>quote</code>, số dư quote &amp; allowance. Xem log bên dưới để biết route.
                        </div>
                    </div>
                </div>

                {/* Actions */}
                <div className="flex gap-4">
                    <button disabled={busy} onClick={handleQuote} className="flex-1 bg-amber-500 text-white py-3 rounded-lg flex items-center justify-center gap-2">
                        <Play size={16} /> 1) Quote (Helper3.tryBuy)
                    </button>
                    <button disabled={busy || !est} onClick={handleBuy} className={`flex-1 py-3 rounded-lg flex items-center justify-center gap-2 border ${busy || !est ? "bg-gray-200 text-gray-500" : "bg-amber-500 text-white"}`}>
                        <Play size={16} /> 2) Buy (Auto route)
                    </button>
                </div>

                {/* Logs */}
                <pre className="text-xs bg-gray-50 p-3 rounded-lg whitespace-pre-wrap break-words h-72 overflow-auto">
                    {logs}
                </pre>

                {/* Boxes */}
                {(est || info) && (
                    <div className="border rounded-xl p-4 bg-gray-50 mt-2">
                        <div className="grid md:grid-cols-2 gap-3 text-sm">
                            {est && (
                                <>
                                    <div><b>Manager:</b> <span className="font-mono break-all">{est.tokenManager}</span></div>
                                    <div><b>Quote:</b> <span className="font-mono break-all">{est.quote}</span></div>
                                    <div><b>estimatedAmount:</b> {fmt18(est.estimatedAmount)}</div>
                                    <div><b>estimatedCost:</b> {fmt18(est.estimatedCost)}</div>
                                    <div><b>amountMsgValue:</b> {fmt18(est.amountMsgValue)}</div>
                                    <div><b>amountApproval:</b> {fmt18(est.amountApproval)}</div>
                                    <div><b>amountFunds:</b> {fmt18(est.amountFunds)}</div>
                                </>
                            )}
                            {info && (
                                <>
                                    <div><b>version:</b> {info.version?.toString?.()}</div>
                                    <div><b>liquidityAdded:</b> {info.liquidityAdded ? "true" : "false"}</div>
                                    <div><b>offers/max:</b> {info.offers?.toString?.()} / {info.maxOffers?.toString?.()}</div>
                                    <div><b>funds/max:</b> {fmt18(info.fundsCur)} / {fmt18(info.maxFundsCap)}</div>
                                    <div><b>launchTime:</b> {info.launchTime?.toString?.()}</div>
                                </>
                            )}
                        </div>
                    </div>
                )}

                <div className="mt-1 text-xs text-gray-500">
                    Nếu <b>liquidityAdded = true</b>, bạn phải mua qua AMM (theo rule protocol).
                </div>
            </div>
        </div>
    );
}
