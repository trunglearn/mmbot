import { Web3 } from "web3";
import {
  BSC_ENDPOINTS,
  ERC20_ABI,
  type BscNet,
} from "../constants";
import {
  type TokenEntry,
  type WalletCandidate,
  type WalletInfo,
} from "../type/multiSend";
import { formatTokenAmount, shortAddress } from "../utils/token";

const normalizeEvmPrivateKey = (raw: string) => {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("Private key trống");
  const prefixed = trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(prefixed)) {
    throw new Error("Private key BSC phải là hex 64 ký tự (có/không '0x').");
  }
  return prefixed as `0x${string}`;
};

export const hydrateBscWallet = async (
  candidate: WalletCandidate,
  appendLog: (msg: string) => void
): Promise<WalletInfo> => {
  const netKey = candidate.bscNet ?? "mainnet";
  const cfg = BSC_ENDPOINTS[netKey];
  const priv = normalizeEvmPrivateKey(candidate.privateKey);
  const web3 = new Web3(cfg.rpc);
  const account = web3.eth.accounts.privateKeyToAccount(priv);
  const address = Web3.utils.toChecksumAddress(account.address);
  const balanceWei = BigInt(await web3.eth.getBalance(address));

  const tokens: TokenEntry[] = [];
  if (balanceWei > 0n) {
    tokens.push({
      id: `${candidate.id}-BNB`,
      kind: "native",
      symbol: "BNB",
      rawAmount: balanceWei,
      decimals: 18,
      formatted: formatTokenAmount(balanceWei, 18),
      selected: true,
    });
  } else {
    appendLog(`Ví ${shortAddress(address)} không có BNB khả dụng.`);
  }

  for (const token of candidate.tokens) {
    try {
      if (!Web3.utils.isAddress(token)) {
        appendLog(`Token ${token} không phải địa chỉ BEP-20 hợp lệ.`);
        continue;
      }
      const checksum = Web3.utils.toChecksumAddress(token);
      const contract = new web3.eth.Contract(ERC20_ABI as any, checksum);
      const [symbol, decimalsStr, balanceStr] = await Promise.all([
        contract.methods.symbol().call().catch(() => shortAddress(checksum, 4, 4)),
        contract.methods.decimals().call().catch(() => "18"),
        contract.methods.balanceOf(address).call().catch(() => "0"),
      ]);
      const decimals = Number(decimalsStr) || 0;
      const balanceBig = BigInt(balanceStr);
      if (balanceBig > 0n) {
        tokens.push({
          id: `${candidate.id}-${checksum}`,
          kind: "bep20",
          symbol,
          tokenAddress: checksum,
          rawAmount: balanceBig,
          decimals,
          formatted: formatTokenAmount(balanceBig, decimals),
          selected: true,
        });
      } else {
        appendLog(`Token ${checksum} trong ví ${shortAddress(address)} có số dư 0 — bỏ qua.`);
      }
    } catch (err: any) {
      appendLog(`Không thể đọc token ${token} trên BSC: ${err?.message || String(err)}`);
    }
  }

  return {
    id: candidate.id,
    chain: "bsc",
    bscNet: netKey,
    privateKey: candidate.privateKey,
    rawNetwork: candidate.rawNetwork,
    address,
    displayAddress: shortAddress(address, 6, 4),
    tokens,
    loading: false,
  };
};

const sendBnb = async (
  web3: Web3,
  account: any,
  destination: string,
  chainId: number,
  walletId: string,
  tokenId: string,
  rawAmount: bigint,
  appendLog: (msg: string) => void,
  updateBalance: (walletId: string, tokenId: string, rawAmount: bigint, decimals: number) => void
) => {
  const gasPrice = BigInt(await web3.eth.getGasPrice());
  const gasLimit = 21000n;
  const fee = gasPrice * gasLimit;
  if (rawAmount <= fee) {
    appendLog(`Ví ${account.address} không đủ BNB để trả phí gas.`);
    return;
  }
  const value = rawAmount - fee;
  const nonce = await web3.eth.getTransactionCount(account.address, "pending");

  const tx = {
    to: destination,
    value: `0x${value.toString(16)}`,
    gas: `0x${gasLimit.toString(16)}`,
    gasPrice: `0x${gasPrice.toString(16)}`,
    nonce: `0x${nonce.toString(16)}`,
    chainId,
  } as const;

  appendLog(`Gửi ${formatTokenAmount(value, 18)} BNB từ ${shortAddress(account.address)}…`);
  const signed = await account.signTransaction(tx);
  if (!signed.rawTransaction) throw new Error("Không ký được giao dịch BNB.");
  const receipt = await web3.eth.sendSignedTransaction(signed.rawTransaction);
  appendLog(`✅ Tx BNB: ${receipt.transactionHash}`);
  updateBalance(walletId, tokenId, 0n, 18);
};

const sendBep20Token = async (
  web3: Web3,
  account: any,
  destination: string,
  chainId: number,
  walletId: string,
  token: TokenEntry,
  appendLog: (msg: string) => void,
  updateBalance: (walletId: string, tokenId: string, rawAmount: bigint, decimals: number) => void
) => {
  if (!token.tokenAddress) return;
  const contract = new web3.eth.Contract(ERC20_ABI as any, token.tokenAddress);
  const data = contract.methods.transfer(destination, token.rawAmount.toString()).encodeABI();
  let gas: bigint;
  try {
    const estimated = await contract.methods
      .transfer(destination, token.rawAmount.toString())
      .estimateGas({ from: account.address });
    gas = BigInt(estimated) + 10000n;
  } catch {
    gas = 150000n;
  }
  const gasPrice = BigInt(await web3.eth.getGasPrice());
  const nonce = await web3.eth.getTransactionCount(account.address, "pending");
  const tx = {
    to: token.tokenAddress,
    data,
    value: "0x0",
    gas: `0x${gas.toString(16)}`,
    gasPrice: `0x${gasPrice.toString(16)}`,
    nonce: `0x${nonce.toString(16)}`,
    chainId,
  } as const;
  appendLog(`Gửi ${token.formatted} ${token.symbol} từ ${shortAddress(account.address)}…`);
  const signed = await account.signTransaction(tx);
  if (!signed.rawTransaction) throw new Error("Không ký được giao dịch token.");
  const receipt = await web3.eth.sendSignedTransaction(signed.rawTransaction);
  appendLog(`✅ Tx ${token.symbol}: ${receipt.transactionHash}`);
  updateBalance(walletId, token.id, 0n, token.decimals);
};

export const sendBscTokens = async ({
  wallet,
  tokens,
  destination,
  appendLog,
  updateBalance,
}: {
  wallet: WalletInfo;
  tokens: TokenEntry[];
  destination: string;
  appendLog: (msg: string) => void;
  updateBalance: (walletId: string, tokenId: string, rawAmount: bigint, decimals: number) => void;
}) => {
  if (!wallet.bscNet) throw new Error("Thiếu thông tin network BSC.");
  if (!Web3.utils.isAddress(destination)) {
    appendLog(`Địa chỉ nhận không hợp lệ cho BSC: ${destination}`);
    return;
  }
  const cfg = BSC_ENDPOINTS[wallet.bscNet as BscNet];
  const priv = normalizeEvmPrivateKey(wallet.privateKey);
  const web3 = new Web3(cfg.rpc);
  const account = web3.eth.accounts.privateKeyToAccount(priv);

  for (const token of tokens) {
    try {
      if (token.kind === "native") {
        await sendBnb(
          web3,
          account,
          destination,
          cfg.chainId,
          wallet.id,
          token.id,
          token.rawAmount,
          appendLog,
          updateBalance
        );
      } else if (token.kind === "bep20" && token.tokenAddress) {
        await sendBep20Token(
          web3,
          account,
          destination,
          cfg.chainId,
          wallet.id,
          token,
          appendLog,
          updateBalance
        );
      } else {
        appendLog(`Token ${token.symbol} không hỗ trợ gửi trên BSC.`);
      }
    } catch (err: any) {
      appendLog(
        `❌ Lỗi gửi token ${token.symbol} từ ${
          wallet.displayAddress ?? wallet.address
        }: ${err?.message || String(err)}`
      );
    }
  }
};
