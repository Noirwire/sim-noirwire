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

  /** A price source older than this, or dated this far ahead, is not believed. */
  maxSourceAgeMs: 10_000,
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

  /** Stop growing after losing this much of the day's starting equity, or of the peak. */
  dailyLossBps: 300,
  drawdownBps: 500,

  /** A resting quote lives at most the requote interval plus this long. */
  expiryMarginSeconds: 10,
  /** The longest the requote interval may be set to, so a quote never lives long. */
  maxRequoteIntervalMs: 30_000,
} as const;
