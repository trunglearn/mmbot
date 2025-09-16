import React, { useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { Web3 } from "web3";
import { BSC_ENDPOINTS, BscNet, ERC20_ABI, FACTORY_V2_ABI, ROUTER_V2_ABI } from "./constants";

function BscSwap() {
    const [net, setNet] = useState<BscNet>("testnet");
    const [pk, setPk] = useState<string>("");
    const [showPk, setShowPk] = useState<boolean>(false);
    const [baseAddr] = useState<string>("BNB");
    const [tokenOut, setTokenOut] = useState<string>("");
    const [amountBnb, setAmountBnb] = useState<string>("0.001");
    const [slippage, setSlippage] = useState<string>("1.0");
    const [status, setStatus] = useState<string>("");

    const log = (s: string) => setStatus((p) => (p ? p + "\n" + s : s));

    const sanitizePk = (raw: string) => {
        const t = raw.trim();
        const hex = t.startsWith("0x") ? t : `0x${t}`;
        if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) {
            throw new Error("Private key phải là hex 64 ký tự (OKX/MetaMask), có/không '0x' đều được.");
        }
        return hex as `0x${string}`;
    };

    const handleSwap = async () => {
        setStatus("");
        try {
            const cfg = BSC_ENDPOINTS[net];
            if (!Web3.utils.isAddress(tokenOut)) throw new Error("Token address không hợp lệ (BEP-20).");

            const web3 = new Web3(cfg.rpc);
            const priv = sanitizePk(pk);
            const acc = web3.eth.accounts.privateKeyToAccount(priv);
            web3.eth.accounts.wallet.clear();
            web3.eth.accounts.wallet.add(acc);
            web3.eth.defaultAccount = acc.address;

            log(`🔗 Network: ${net.toUpperCase()} @ ${cfg.rpc}`);
            log(`👤 From: ${acc.address}`);
            log(`🪙 Base: BNB | Token out: ${Web3.utils.toChecksumAddress(tokenOut)}`);

            const router = new web3.eth.Contract(ROUTER_V2_ABI as any, cfg.routerV2);
            const factory = new web3.eth.Contract(FACTORY_V2_ABI as any, cfg.factoryV2);
            const wbnb = cfg.wbnb;

            // kiểm tra cặp trực tiếp WBNB↔TOKEN có tồn tại
            const pair = await factory.methods.getPair(wbnb, tokenOut).call();
            if (pair === "0x0000000000000000000000000000000000000000") {
                throw new Error("Cặp WBNB/token chưa tồn tại trên PancakeSwap V2 (trực tiếp). Hãy chọn token có pool WBNB.");
            }

            // đọc symbol/decimals để log đẹp (không bắt buộc)
            let sym = "TOKEN", dec = 18;
            try {
                const erc20 = new web3.eth.Contract(ERC20_ABI as any, tokenOut);
                sym = await erc20.methods.symbol().call();
                dec = parseInt(await erc20.methods.decimals().call(), 10);
            } catch { /* ignore */ }

            // tính amountOutMin với slippage %
            const amtInWei = web3.utils.toWei(String(parseFloat(String(amountBnb).replace(",", "."))), "ether");
            const path = [wbnb, tokenOut];
            const amounts = await router.methods.getAmountsOut(amtInWei, path).call();
            const out = BigInt(amounts[1]);
            const slip = Math.max(0, Math.min(100, Number(slippage)));
            const outMin = (out * BigInt(Math.floor((100 - slip) * 100))) / BigInt(10000);

            log(`📈 Quote V2: out=${out.toString()} (≈ ${Number(out) / 10 ** dec} ${sym})`);
            log(`🎯 outMin (slippage ${slip}%): ${outMin.toString()} (${Number(outMin) / 10 ** dec} ${sym})`);

            const gasPrice = await web3.eth.getGasPrice();
            const deadline = Math.floor(Date.now() / 1000) + 60 * 5;

            // build tx
            const tx = router.methods.swapExactETHForTokensSupportingFeeOnTransferTokens(
                outMin.toString(),
                path,
                acc.address,
                deadline
            );

            // estimate gas an toàn
            let gas: bigint;
            try {
                const g = await tx.estimateGas({ from: acc.address, value: amtInWei });
                gas = BigInt(g);
            } catch (e: any) {
                log(`⚠️ estimateGas lỗi, dùng fallback 300000. Message: ${e?.message || e}`);
                gas = 300000n;
            }

            const nonce = await web3.eth.getTransactionCount(acc.address, "pending");
            log(`⛽ gas=${gas.toString()} | gasPrice=${gasPrice} wei | nonce=${nonce}`);

            const sent = await tx.send({
                from: acc.address,
                value: amtInWei,
                gas: Number(gas),
                gasPrice,
                nonce,
            });

            const txHash = sent?.transactionHash || sent;
            log(`✅ Swap thành công: ${txHash}`);
            log(`🔍 ${cfg.explorer}/tx/${txHash}`);
        } catch (err: any) {
            log(`❌ ${err?.reason || err?.message || String(err)}`);
        }
    };

    return (
        <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg mx-auto overflow-hidden">
            <div className="bg-amber-500 text-white text-center py-4">
                <h2 className="text-xl font-semibold">BNB → Token (PancakeSwap V2 · QuickNode)</h2>
            </div>
            <div className="p-6 space-y-6">
                {/* ...existing code for UI... */}
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
                    <label className="block text-sm font-medium mb-2">Private Key (OKX/MetaMask — hex 64, có/không “0x”)</label>
                    <div className="relative">
                        <input
                            type={showPk ? "text" : "password"}
                            value={pk}
                            onChange={(e) => setPk(e.target.value)}
                            className="w-full px-4 py-3 bg-gray-50 border rounded-lg pr-12"
                            placeholder="0x..."
                            autoComplete="off"
                            spellCheck={false}
                        />
                        <button
                            type="button"
                            onClick={() => setShowPk(!showPk)}
                            className="absolute right-3 top-1/2 -translate-y-1/2 text-amber-600"
                            aria-label="toggle"
                        >
                            {showPk ? <EyeOff size={18} /> : <Eye size={18} />}
                        </button>
                    </div>
                </div>
                <div>
                    <label className="block text-sm font-medium mb-2">Base Token Address (bắt buộc là BNB)</label>
                    <input
                        type="text"
                        value={baseAddr}
                        disabled
                        className="w-full px-4 py-3 bg-gray-100 border rounded-lg"
                    />
                    <p className="text-xs text-gray-500 mt-1">Input native BNB, router sẽ wrap thành WBNB trên chain.</p>
                </div>
                <div>
                    <label className="block text-sm font-medium mb-2">Token Address (BEP-20)</label>
                    <input
                        type="text"
                        value={tokenOut}
                        onChange={(e) => setTokenOut(e.target.value.trim())}
                        className="w-full px-4 py-3 bg-gray-50 border rounded-lg"
                        placeholder="Ví dụ: 0x55d398326f99059fF775485246999027B3197955 (USDT mainnet)"
                        autoComplete="off"
                        spellCheck={false}
                    />
                </div>
                <div className="grid grid-cols-2 gap-4">
                    <div>
                        <label className="block text-sm font-medium mb-2">BNB Amount</label>
                        <input
                            type="text"
                            value={amountBnb}
                            onChange={(e) => setAmountBnb(e.target.value)}
                            className="w-full px-4 py-3 bg-gray-50 border rounded-lg"
                            placeholder="0.001"
                        />
                    </div>
                    <div>
                        <label className="block text-sm font-medium mb-2">Slippage (%)</label>
                        <input
                            type="text"
                            value={slippage}
                            onChange={(e) => setSlippage(e.target.value)}
                            className="w-full px-4 py-3 bg-gray-50 border rounded-lg"
                            placeholder="1.0"
                        />
                    </div>
                </div>
                <div>
                    <label className="block text-sm font-medium mb-2">Swap Version</label>
                    <select className="w-full px-4 py-3 bg-gray-100 border rounded-lg" value="v2" disabled>
                        <option value="v2">V2 (PancakeSwap)</option>
                    </select>
                </div>
                <pre className="text-xs bg-gray-50 p-3 rounded-lg whitespace-pre-wrap break-words h-64 overflow-auto">
                    {status}
                </pre>
                <div className="flex gap-4">
                    <button onClick={handleSwap} className="flex-1 bg-amber-500 text-white py-3 rounded-lg">
                        Swap
                    </button>
                    <button onClick={() => setStatus("")} className="flex-1 bg-gray-600 text-white py-3 rounded-lg">
                        Clear Logs
                    </button>
                </div>
            </div>
        </div>
    );
}

export default BscSwap;
