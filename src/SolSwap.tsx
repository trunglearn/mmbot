import React, { useState } from "react";
import { Eye, EyeOff } from "lucide-react";
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
import {
    NETWORKS,
    NetKey,
    DATASIZE_V4,
    OFF_BASE,
    OFF_QUOTE,
    SOL_PSEUDO_MINT,
    TOKEN_ACC_SIZE,
} from "./constants";

function SolSwap() {
    const [privateKey, setPrivateKey] = useState("");
    const [showPrivateKey, setShowPrivateKey] = useState(false);
    const [network, setNetwork] = useState<NetKey>("devnet");
    const [contractAddress, setContractAddress] = useState(
        "Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr"
    );
    const [amountSol, setAmountSol] = useState("0.001");
    const [status, setStatus] = useState("");

    const log = (s: string) => setStatus((p) => (p ? p + "\n" + s : s));

    const onChangeNetwork = (value: NetKey) => {
        setNetwork(value);
        setContractAddress(
            value === "mainnet"
                ? "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R"
                : "Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr"
        );
    };

    const handleSwap = async () => {
        setStatus("");
        let lastSig = "";
        try {
            const net = NETWORKS[network];
            const conn = new Connection(net.rpc, "confirmed");
            const secret = bs58.decode(privateKey.trim());
            const owner = Keypair.fromSecretKey(secret);
            const destMint = new PublicKey(contractAddress.trim());
            const ui = parseFloat(String(amountSol).replace(",", "."));
            if (!isFinite(ui) || ui <= 0) throw new Error("Số lượng SOL không hợp lệ");
            const amountLamports = BigInt(Math.floor(ui * LAMPORTS_PER_SOL));

            log("Start swap (QuickNode-only).");
            log(`Owner: ${owner.publicKey.toBase58()}`);
            log(`Dest mint: ${destMint.toBase58()}`);
            log(`Amount in (lamports): ${amountLamports}`);

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
                `💰 Balance: ${(Number(balance) / LAMPORTS_PER_SOL).toFixed(6)} SOL | Need ≈ ${(Number(totalNeed) / LAMPORTS_PER_SOL).toFixed(6)} SOL`
            );
            if (balance < totalNeed) {
                throw new Error(
                    `Không đủ SOL: cần ~${(Number(totalNeed) / LAMPORTS_PER_SOL).toFixed(
                        6
                    )} SOL (gồm amount + rent + phí), đang có ${(Number(balance) / LAMPORTS_PER_SOL).toFixed(6)} SOL`
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
                log("⚠️ Không thấy pool (base=token, quote=wSOL). Có thể route CLMM/khác, vẫn tiếp tục.");
            } else {
                log(`🔎 Found pool: ${gpa[0].pubkey.toBase58()}`);
            }

            log("🧮 Lấy priority fee …");
            const feeRes = await axios.get(net.feeEndpoint);
            const priorityMicroLamports: string = String(feeRes.data?.data?.default?.h ?? 15000);

            const txVersion = "V0";
            const slippageBps = 100; // 1%

            log("💬 Lấy quote (swap-base-in) …");
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
                log(`🧱 Tạo ATA cho mint đích: ${outAta.toBase58()}`);
                const ix = createAssociatedTokenAccountInstruction(
                    owner.publicKey,
                    outAta,
                    owner.publicKey,
                    destMint
                );
                const preTx = new Transaction().add(ix);
                preTx.feePayer = owner.publicKey;
                preTx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
                preTx.sign(owner);
                await sendAndConfirmTransaction(conn, preTx, [owner], { skipPreflight: false });
                log("✅ ATA created");
            } else {
                log(`ℹ️ ATA đã tồn tại: ${outAta.toBase58()}`);
            }

            log("🧱 Lấy serialized transactions …");
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

            log(`📦 Nhận ${txList.length} transaction(s). Deserialize & ký …`);

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
                    log(`✅ TX ${i + 1}/${txList.length} confirmed: ${sig}`);
                    log(`🔍 ${NETWORKS[network].solscanBase}/tx/${sig}${NETWORKS[network].explorerClusterQS}`);
                } catch (err: any) {
                    const logs =
                        err?.logs ||
                        err?.value?.logs ||
                        err?.data?.logs ||
                        (typeof err?.getLogs === "function" ? await err.getLogs() : null);
                    log(
                        `❌ Simulation/Send failed.\nMessage: ${err?.message}\nLogs:\n${Array.isArray(logs) ? logs.join("\n") : JSON.stringify(logs) || "[]"}`
                    );
                    throw err;
                }
            }

            const parsed = await conn.getParsedAccountInfo(await getAssociatedTokenAddress(destMint, Keypair.fromSecretKey(bs58.decode(privateKey.trim())).publicKey), "confirmed");
            const parsedInfo: any = parsed.value?.data?.parsed?.info;
            if (parsedInfo?.tokenAmount) {
                log(`🎯 Nhận vào ATA amount: ${parsedInfo.tokenAmount.uiAmountString}`);
            } else {
                log("🔎 Parsed: chưa đọc được số dư mới.");
            }

            log("🎉 Done.");
        } catch (e: any) {
            const fromAxios = e?.response?.data ? `\nAPI: ${JSON.stringify(e.response.data)}` : "";
            log(`❌ ${e?.message || String(e)}${fromAxios}`);
            console.error(e);
        }
    };

    return (
        <div className="bg-white rounded-2xl shadow-2xl w-full mx-auto overflow-hidden">
            <div className="bg-green-600 text-white text-center py-4">
                <h1 className="text-xl font-semibold">SOL → Token (Raydium · QuickNode)</h1>
            </div>
            <div className="p-6 space-y-6">
                {/* ...existing code for UI... */}
                <div>
                    <label className="block text-sm font-medium mb-2">Private Key (bs58)</label>
                    <div className="relative">
                        <input
                            type={showPrivateKey ? "text" : "password"}
                            value={privateKey}
                            onChange={(e) => setPrivateKey(e.target.value)}
                            className="w-full px-4 py-3 bg-gray-50 border rounded-lg pr-12"
                            placeholder="secret từ Phantom (bs58)"
                        />
                        <button
                            type="button"
                            onClick={() => setShowPrivateKey(!showPrivateKey)}
                            className="absolute right-3 top-1/2 -translate-y-1/2 text-green-600"
                        >
                            {showPrivateKey ? <EyeOff size={18} /> : <Eye size={18} />}
                        </button>
                    </div>
                </div>
                <div>
                    <label className="block text-sm font-medium mb-2">Token Mint</label>
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
                <div>
                    <label className="block text-sm font-medium mb-2">SOL Amount</label>
                    <input
                        type="text"
                        value={amountSol}
                        onChange={(e) => setAmountSol(e.target.value)}
                        className="w-full px-4 py-3 bg-gray-50 border rounded-lg"
                        placeholder="0.1"
                    />
                </div>
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
                <pre className="text-xs bg-gray-50 p-3 rounded-lg whitespace-pre-wrap break-words h-64 overflow-auto">
                    {status}
                </pre>
                <div className="flex gap-4">
                    <button onClick={handleSwap} className="flex-1 bg-green-600 text-white py-3 rounded-lg">
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

export default SolSwap;
