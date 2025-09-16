import React, { useState } from "react";
import { Eye, EyeOff } from "lucide-react";
/* ================= SOLANA (giữ nguyên như bạn đã gửi) ================= */
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
import bs58 from "bs58";
import axios from "axios";
import { API_URLS } from "@raydium-io/raydium-sdk-v2";
import { Buffer } from "buffer";

/* ================= BSC (web3.js) — CHỈ THÊM, KHÔNG SỬA PHẦN SOL ================= */
import { Web3 } from "web3";

/* ================== NETWORK CONFIG (Mainnet + Devnet) ================== */
const NETWORKS = {
  mainnet: {
    rpc: "https://necessary-cool-waterfall.solana-mainnet.quiknode.pro/f965569b37ae159010d579b803fdbcb2042f4091",
    raydiumProgram: new PublicKey("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8"),
    solscanBase: "https://solscan.io",
    swapHost: "https://transaction-v1.raydium.io",           // Trade API (mainnet)
    feeEndpoint: `${API_URLS.BASE_HOST}${API_URLS.PRIORITY_FEE}`, // priority fee
    explorerClusterQS: "",
  },
  devnet: {
    rpc: "https://necessary-cool-waterfall.solana-devnet.quiknode.pro/f965569b37ae159010d579b803fdbcb2042f4091",
    raydiumProgram: new PublicKey("DRaya7Kj3aMWQSy19kSjvmuwq9docCHofyP9kanQGaav"),
    solscanBase: "https://solscan.io",
    swapHost: "https://transaction-v1-devnet.raydium.io",    // Trade API (devnet)
    feeEndpoint: `${API_URLS.BASE_HOST}${API_URLS.PRIORITY_FEE}`,
    explorerClusterQS: "?cluster=devnet",
  },
} as const;
type NetKey = keyof typeof NETWORKS;

/* ================== Raydium AMM v4 offsets (giữ nguyên) ================== */
const DATASIZE_V4 = 752;
const OFF_BASE = 400;
const OFF_QUOTE = 432;
const SOL_PSEUDO_MINT = "So11111111111111111111111111111111111111112";
const TOKEN_ACC_SIZE = 165;

/* ========================= BSC CONSTANTS (PancakeSwap V2) =========================
   ĐÃ XÁC NHẬN:
   - Router V2 mainnet: 0x10ED43C718714eb63d5aA57B78B54704E256024E
   - Router V2 testnet: 0xD99D1c33F9fC3444f8101754aBC46c52416550D1
   - Factory V2 mainnet: 0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73
   - Factory V2 testnet: 0x6725F303b657a9451d8BA641348b6761A6CC7a17
   - WBNB mainnet: 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c
   - WBNB testnet: 0xae13d989dac2f0debff460ac112a837c89baa7cd
*/
const BSC_ENDPOINTS = {
  mainnet: {
    rpc: "https://necessary-cool-waterfall.bsc.quiknode.pro/f965569b37ae159010d579b803fdbcb2042f4091",
    routerV2: "0x10ED43C718714eb63d5aA57B78B54704E256024E",
    factoryV2: "0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73",
    wbnb: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
    chainId: 56,
    explorer: "https://bscscan.com",
  },
  testnet: {
    rpc: "https://necessary-cool-waterfall.bsc-testnet.quiknode.pro/f965569b37ae159010d579b803fdbcb2042f4091",
    routerV2: "0xD99D1c33F9fC3444f8101754aBC46c52416550D1",
    factoryV2: "0x6725F303b657a9451d8BA641348b6761A6CC7a17",
    wbnb: "0xae13d989dac2f0debff460ac112a837c89baa7cd",
    chainId: 97,
    explorer: "https://testnet.bscscan.com",
  },
} as const;
type BscNet = keyof typeof BSC_ENDPOINTS;

/* ====== Minimal ABIs ====== */
const ERC20_ABI = [
  { constant: true, inputs: [], name: "decimals", outputs: [{ name: "", type: "uint8" }], stateMutability: "view", type: "function" },
  { constant: true, inputs: [], name: "symbol", outputs: [{ name: "", type: "string" }], stateMutability: "view", type: "function" },
  { constant: true, inputs: [{ name: "owner", type: "address" }], name: "balanceOf", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" },
] as const;

const FACTORY_V2_ABI = [
  { constant: true, inputs: [{ name: "tokenA", type: "address" }, { name: "tokenB", type: "address" }], name: "getPair", outputs: [{ name: "pair", type: "address" }], stateMutability: "view", type: "function" },
] as const;

const ROUTER_V2_ABI = [
  { constant: true, inputs: [{ name: "amountIn", type: "uint256" }, { name: "path", type: "address[]" }], name: "getAmountsOut", outputs: [{ name: "amounts", type: "uint256[]" }], stateMutability: "view", type: "function" },
  { constant: false, inputs: [{ name: "amountOutMin", type: "uint256" }, { name: "path", type: "address[]" }, { name: "to", type: "address" }, { name: "deadline", type: "uint256" }], name: "swapExactETHForTokensSupportingFeeOnTransferTokens", outputs: [], stateMutability: "payable", type: "function" },
] as const;

/* ========================= COMPONENT: BSC SWAP (PancakeSwap V2) ========================= */
function BscSwap() {
  const [net, setNet] = useState<BscNet>("testnet"); // testnet & mainnet
  const [pk, setPk] = useState<string>("");
  const [showPk, setShowPk] = useState<boolean>(false);
  const [baseAddr] = useState<string>("BNB"); // bắt buộc BNB
  const [tokenOut, setTokenOut] = useState<string>(""); // BEP-20 address (đích)
  const [amountBnb, setAmountBnb] = useState<string>("0.001");
  const [slippage, setSlippage] = useState<string>("1.0"); // %
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
      const outMin = (out * BigInt(Math.floor((100 - slip) * 100))) / BigInt(10000); // (100 - slip)%

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
        gasPrice,            // BSC dùng legacy gasPrice là chuẩn
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
        {/* Network */}
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

        {/* Private Key */}
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

        {/* Base Token (BNB) */}
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

        {/* Token Out */}
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

        {/* Amount + Slippage */}
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

        {/* Version (chỉ V2) */}
        <div>
          <label className="block text-sm font-medium mb-2">Swap Version</label>
          <select className="w-full px-4 py-3 bg-gray-100 border rounded-lg" value="v2" disabled>
            <option value="v2">V2 (PancakeSwap)</option>
          </select>
        </div>

        {/* Logs */}
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

/* ========================= APP: 2 TAB (SOL · RAYDIUM / BNB · PANCAKE) ========================= */
type TabKey = "sol" | "bsc";

function App() {
  const [activeTab, setActiveTab] = useState<TabKey>("sol");

  // ==== NGUYÊN BẢN: SOL SWAP — giữ nguyên logic/state/flow ====
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
      if (!Array.isArray(txList) || !Array.isArray(txList) || !txList.length) throw new Error("Trade API không trả về giao dịch");

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
    <div className="min-h-screen bg-gradient-to-br from-green-600 to-green-700 flex items-start justify-center p-4">
      <div className="w-full max-w-4xl">
        {/* Tabs header */}
        <div className="flex mb-4 rounded-xl overflow-hidden">
          <button
            onClick={() => setActiveTab("sol")}
            className={`flex-1 py-3 text-center font-medium ${activeTab === "sol" ? "bg-white text-green-700" : "bg-green-800/30 text-white hover:bg-green-800/50"}`}
          >
            SOL · Raydium
          </button>
          <button
            onClick={() => setActiveTab("bsc")}
            className={`flex-1 py-3 text-center font-medium ${activeTab === "bsc" ? "bg-white text-amber-700" : "bg-green-800/30 text-white hover:bg-green-800/50"}`}
          >
            BNB · Pancake V2
          </button>
        </div>

        {/* Tab content */}
        {activeTab === "sol" ? (
          <div className="bg-white rounded-2xl shadow-2xl w-full mx-auto overflow-hidden">
            <div className="bg-green-600 text-white text-center py-4">
              <h1 className="text-xl font-semibold">SOL → Token (Raydium · QuickNode)</h1>
            </div>
            <div className="p-6 space-y-6">
              {/* Private Key */}
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

              {/* Token Mint */}
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

              {/* SOL Amount */}
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

              {/* Network */}
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

              {/* Status / Logs */}
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
        ) : (
          <BscSwap />
        )}
      </div>
    </div>
  );
}

export default App;
