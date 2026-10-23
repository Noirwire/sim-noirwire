/**
 * Limits of the hedge controller that are fixed in code, like the maker's
 * own: loosening one is a change that is reviewed, not a setting.
 */
export const HEDGE_LIMITS = {
  /** An order may fill at most this far through the reference price. */
  priceBandBps: 20,
  /** The maker quotes this much wider while the hedge lags. */
  laggingExtraSpreadBps: 10,
  /** After an order whose outcome is unknown, no new order is sent for this long. */
  settleAfterUnknownMs: 10_000,
  /** After a refused order, no new order is sent for this long. */
  retryAfterRefusalMs: 5_000,
} as const;

/** Every call to the hedge venue gets this long to answer before the controller stops waiting for it. */
export const VENUE_CALL_TIMEOUT_MS = 8_000;

/**
 * An order whose call timed out or failed may still be dispatched late: after one, the hold on new
 * orders lasts at least this long from the send, whatever the cancel and the fills show.
 */
export const LATE_DISPATCH_QUARANTINE_MS = 60_000;

/** The settings an operator chooses, already parsed. */
export interface HedgeSettings {
  /** Unhedged exposure in dollars from which the hedge counts as lagging. */
  softUnhedgedNotional: bigint;
  /** Unhedged exposure in dollars from which the hedge counts as blind. */
  hardUnhedgedNotional: bigint;
  /** Without a venue confirmation for this long, the hedge counts as lagging. */
  confirmTimeoutMs: number;
  /** The hedge position never grows past the account's margin times this. */
  maxLeverage: number;
}
