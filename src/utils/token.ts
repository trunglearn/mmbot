export const formatTokenAmount = (amount: bigint, decimals: number, precision = 6) => {
  if (amount === 0n) return "0";
  if (decimals === 0) return amount.toString();
  const negative = amount < 0n;
  const absAmount = negative ? -amount : amount;
  const base = 10n ** BigInt(decimals);
  const integerPart = absAmount / base;
  const fractionPart = absAmount % base;
  if (fractionPart === 0n) {
    return `${negative ? "-" : ""}${integerPart.toString()}`;
  }
  const fractionStrRaw = fractionPart.toString().padStart(decimals, "0");
  const fractionStr = fractionStrRaw.slice(0, precision).replace(/0+$/, "");
  return `${negative ? "-" : ""}${integerPart.toString()}${fractionStr ? "." + fractionStr : ""}`;
};

export const shortAddress = (addr: string, head = 6, tail = 4) => {
  if (!addr) return "";
  if (addr.length <= head + tail + 3) return addr;
  return `${addr.slice(0, head)}...${addr.slice(-tail)}`;
};

export const uniqueTokens = (tokens: string[]) => {
  const set = new Set(tokens.map((t) => t.trim()).filter(Boolean));
  return Array.from(set);
};
