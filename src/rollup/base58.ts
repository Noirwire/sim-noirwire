const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Bitcoin-style base58, the form in which Solana writes a signature. */
export const base58Of = (bytes: Uint8Array): string => {
  let rest = bytes.reduce((total, byte) => (total << 8n) | BigInt(byte), 0n);
  let text = "";
  while (rest > 0n) {
    text = ALPHABET[Number(rest % 58n)] + text;
    rest /= 58n;
  }
  const leadingZeros = bytes.findIndex((byte) => byte !== 0);
  return "1".repeat(leadingZeros === -1 ? bytes.length : leadingZeros) + text;
};
