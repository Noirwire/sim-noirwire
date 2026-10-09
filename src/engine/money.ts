export const SCALE = 1_000_000n;
export const SCALE_DECIMALS = 6;

export const bpsOf = (amount: bigint, bps: number): bigint => (amount * BigInt(bps)) / 10_000n;

export const mulDivScale = (a: bigint, b: bigint): bigint => (a * b) / SCALE;

export const divScale = (a: bigint, b: bigint): bigint => (a * SCALE) / b;

export const absBigInt = (value: bigint): bigint => (value < 0n ? -value : value);

export const signOf = (value: bigint): bigint => (value > 0n ? 1n : value < 0n ? -1n : 0n);

export const roundUpToTick = (price: bigint, tickSize: bigint): bigint => {
  const remainder = price % tickSize;
  return remainder === 0n ? price : price - remainder + tickSize;
};

export const roundDownToTick = (price: bigint, tickSize: bigint): bigint =>
  price - (price % tickSize);

export const toDecimalString = (scaled: bigint): string => {
  const negative = scaled < 0n;
  const magnitude = absBigInt(scaled);
  const whole = magnitude / SCALE;
  const fraction = (magnitude % SCALE).toString().padStart(SCALE_DECIMALS, "0");
  const sign = negative ? "-" : "";
  return `${sign}${whole}.${fraction}`;
};

export const fromDecimalString = (value: string): bigint => {
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [wholePart, fractionPart = ""] = unsigned.split(".");
  const fraction = fractionPart.padEnd(SCALE_DECIMALS, "0").slice(0, SCALE_DECIMALS);
  const magnitude = BigInt(wholePart || "0") * SCALE + BigInt(fraction || "0");
  return negative ? -magnitude : magnitude;
};
