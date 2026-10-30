import { SCALE } from "../engine/money.js";

/**
 * The limits the house maker keeps when it follows the risk rules. They are
 * fixed in code on purpose: loosening one is a change that is reviewed, not
 * a setting that is typed into a file.
 */
export const MAKER_LIMITS = {
  /** The least a quote may sit away from the reference price, on each side. */
  minHalfSpreadBps: 15,
  /** The most one quote level may hold, in nUSD of notional. */
  maxQuoteSizeNusd: 500n * SCALE,
  /** The most the position limit may be set to, in nUSD of notional. */
  maxPositionLimitNusd: 250n * SCALE,

  /** An exchange price older than this, or dated this far ahead, is not believed. */
  maxSourceAgeMs: 10_000,
  /** The oracle price, pushed on chain every few seconds, gets longer: it is 3 to 12 s old when read. */
  maxOracleAgeMs: 30_000,
  /** Sources further apart than this (highest to lowest, against the median) pull the quotes. */
  maxSourceDisagreementBps: 30,
  /** Large exchanges that must answer, besides the oracle. */
  minExchanges: 2,

  /** The NoirWire mark behind the reference by more than this widens the quotes by the gap. */
  markLagWidenBps: 10,
  /** The NoirWire mark behind the reference by more than this pulls the quotes. */
  markLagPullBps: 100,

  /** A move of more than moveBps inside moveWindowMs pulls the quotes until it settles. */
  moveWindowMs: 10_000,
  moveBps: 50,
  /** The half-spread grows by this share of the price range seen over volatilityWindowMs. */
  volatilityWindowMs: 60_000,
  volatilityShare: 0.5,

  /** Past this loss of the day's starting equity, or of the peak, the maker starts reducing its position to flat. */
  dailyLossBps: 300,
  drawdownBps: 500,
  /** Past these, while it is still reducing, the maker stops quoting altogether. */
  dailyLossStopBps: 600,
  drawdownStopBps: 1_000,
  /**
   * How far through the reference price a reducing order may sit: the most the
   * maker pays, per unit, to get out. It never chases beyond it.
   */
  flattenGiveBps: 25,
  /** A maker still holding a position this long after it began to reduce it stops quoting altogether. */
  flattenDeadlineMs: 600_000,
  /**
   * While the reference price is down and none was good in the last
   * referenceMemoryMs, the maker is blind, and a flattening gets this long
   * instead of flattenDeadlineMs.
   */
  blindFlattenDeadlineMs: 180_000,
  referenceMemoryMs: 3_600_000,
  /** Unknown errors in a row, while the maker is at the soft stop, that make it stop quoting altogether. */
  unknownErrorsBeforeHardStop: 5,
  /** Ladders in a row abandoned because an order provably never ran (its window passed) that raise one alert; the maker keeps quoting. */
  unrunLaddersBeforeAlert: 5,

  /**
   * While a requote keeps the old orders standing until the new ladder is up, the maker's resting
   * orders on a market together stay within this many (the program caps a seat's open orders per
   * market, at 32 at most), and the worst case they could grow its position to stays within this
   * share of its equity times the market's leverage.
   */
  overlapMaxOpenOrders: 16,
  overlapMarginShareBps: 8_000,

  /** The least time between two status lines that say what the maker holds. */
  statusEveryMs: 300_000,
  /** A resting quote lives at most the requote interval plus this long. */
  expiryMarginSeconds: 10,
  /** How far the host clock may run ahead of the chain's: 30 s is far above the drift of a synced host, and costs only a longer hold. */
  chainClockSkewMs: 30_000,
  /** The least time between two reads of the seat that look for a consumed side of the ladder. */
  sideReadEveryMs: 2_000,
  /** The longest the requote interval may be set to, so a quote never lives long. */
  maxRequoteIntervalMs: 30_000,
} as const;
