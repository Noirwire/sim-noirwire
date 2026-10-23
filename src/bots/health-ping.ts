import { type Clock, systemClock } from "../engine/clock.js";

/** Where a failed ping is reported: the service's problem log, which logs a state change, not a line per failure. */
export interface PingProblems {
  onError(what: string, error: unknown): void;
  onRecovered(what: string): void;
}

export type Send = (url: string, init: { signal: AbortSignal }) => Promise<{ status: number }>;

const WHAT = "health check ping";
const PING_TIMEOUT_MS = 3_000;

/** Why a ping failed, in words, or null when it went through. It never carries the address, which usually holds a secret. */
const failureOf = async (url: string, send: Send): Promise<string | null> => {
  try {
    const { status } = await send(url, { signal: AbortSignal.timeout(PING_TIMEOUT_MS) });
    return status >= 200 && status < 300
      ? null
      : `the monitor answered ${status}. Check HEALTHCHECK_URL.`;
  } catch {
    return "the monitor did not answer within 3 s or could not be reached. Quoting is not affected.";
  }
};

/**
 * The least time between two pings. The monitor takes five pings a minute per
 * check, and the maker requotes about every 10 s.
 */
export const MIN_PING_GAP_MS = 15_000;

/**
 * A ping to an outside monitor (a healthchecks.io style address), sent after
 * a good requote, at most one every 15 s. The monitor raises the alarm when
 * the pings stop, so a maker that is stuck, stopped or pulled is noticed by
 * something that does not run on this machine. It is never fatal and never
 * waits: a failure is logged without the address, and a ping still on its way
 * is not stacked under another.
 */
export const healthPing = (
  url: string,
  problems: PingProblems,
  send: Send = fetch,
  clock: Clock = systemClock,
): (() => void) => {
  let inFlight = false;
  let lastSentAtMs = -Infinity;
  const ping = async (): Promise<void> => {
    const failure = await failureOf(url, send);
    if (failure === null) problems.onRecovered(WHAT);
    else problems.onError(WHAT, new Error(failure));
  };
  return () => {
    const nowMs = clock.nowMs();
    if (inFlight || nowMs - lastSentAtMs < MIN_PING_GAP_MS) return;
    lastSentAtMs = nowMs;
    inFlight = true;
    ping()
      .catch(() => {})
      .finally(() => {
        inFlight = false;
      });
  };
};
