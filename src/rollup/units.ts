import { SCALE, SCALE_DECIMALS } from "../engine/money.js";

/**
 * Converts between this service's numbers (a price per whole base unit and a
 * size in base units, both scaled by 1e6) and the program's (a price in
 * quote atoms per lot and a size in lots). The quote token has six decimals
 * on both sides, so quote amounts are the same number.
 */
export interface MarketUnits {
  lotsPerUnit: bigint;
  sizePerLot: bigint;
}

export const marketUnits = (baseLot: bigint, baseDecimals: number): MarketUnits => {
  const atomsPerUnit = 10n ** BigInt(baseDecimals);
  if (baseLot <= 0n || atomsPerUnit % baseLot !== 0n) {
    throw new Error(`a lot of ${baseLot} base atoms does not divide one base unit`);
  }
  const lotsPerUnit = atomsPerUnit / baseLot;
  if (SCALE % lotsPerUnit !== 0n) {
    throw new Error(`a lot of ${baseLot} base atoms is finer than six decimals`);
  }
  return { lotsPerUnit, sizePerLot: SCALE / lotsPerUnit };
};

export const toSimPrice = (units: MarketUnits, chainPrice: bigint): bigint =>
  chainPrice * units.lotsPerUnit;

export const toSimSize = (units: MarketUnits, lots: bigint): bigint => lots * units.sizePerLot;

/** Null when the price is not a whole number of quote atoms per lot. */
export const toChainPrice = (units: MarketUnits, simPrice: bigint): bigint | null =>
  simPrice % units.lotsPerUnit === 0n ? simPrice / units.lotsPerUnit : null;

/** Null when the size is not a whole number of lots. */
export const toChainSize = (units: MarketUnits, simSize: bigint): bigint | null =>
  simSize % units.sizePerLot === 0n ? simSize / units.sizePerLot : null;

export const roundDownToChainPrice = (
  units: MarketUnits,
  simPrice: bigint,
  tick: bigint,
): bigint => {
  const price = simPrice / units.lotsPerUnit;
  return price - (price % tick);
};

export const toSimAmount = (atoms: bigint, decimals: number): bigint =>
  decimals >= SCALE_DECIMALS
    ? atoms / 10n ** BigInt(decimals - SCALE_DECIMALS)
    : atoms * 10n ** BigInt(SCALE_DECIMALS - decimals);

export const toChainAmount = (simAmount: bigint, decimals: number): bigint =>
  decimals >= SCALE_DECIMALS
    ? simAmount * 10n ** BigInt(decimals - SCALE_DECIMALS)
    : simAmount / 10n ** BigInt(SCALE_DECIMALS - decimals);
