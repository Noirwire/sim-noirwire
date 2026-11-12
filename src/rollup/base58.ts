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

/** The bytes a base58 text stands for, or null when it holds a character outside the alphabet. */
export const bytesOfBase58 = (text: string): Uint8Array | null => {
  let value = 0n;
  for (const character of text) {
    const digit = ALPHABET.indexOf(character);
    if (digit === -1) return null;
    value = value * 58n + BigInt(digit);
  }
  const leadingOnes = text.length - text.replace(/^1+/, "").length;
  const hex = value === 0n ? "" : value.toString(16);
  const body = Buffer.from(hex.length % 2 === 0 ? hex : `0${hex}`, "hex");
  return Uint8Array.from([...new Uint8Array(leadingOnes), ...body]);
};
