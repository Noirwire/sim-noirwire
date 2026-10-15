import type { Generation } from "./generation.js";

export const REQUEST_TIMEOUT_MS = 8_000;

type Fetch = typeof fetch;

/**
 * A request that is never answered is given up after `timeoutMs`. Without
 * this one silent connection would hold a loop's turn forever: every request
 * this service makes to the rollup goes out through it.
 *
 * A request is also given up, and a later one refused without being sent,
 * once `life` ends. With `hangWhenEnded` a later request is not even
 * answered with a refusal: it never settles, which ends a caller that retries
 * on every failure (an order client waiting on a result) instead of leaving
 * it to spin on refusals.
 */
export const fetchWithin =
  (timeoutMs: number, transport: Fetch = fetch, life?: Generation, hangWhenEnded = false): Fetch =>
  (input, init) => {
    if (life?.ended && hangWhenEnded) return new Promise<Response>(() => {});
    const timeout = AbortSignal.timeout(timeoutMs);
    return transport(input, {
      ...init,
      signal: life ? AbortSignal.any([timeout, life.signal]) : timeout,
    });
  };

/** Rejects when `work` has not settled after `timeoutMs`. */
export const within = <T>(work: Promise<T>, timeoutMs: number, what: string): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${what} got no answer in ${timeoutMs} ms`)),
      timeoutMs,
    );
    work.then(resolve, reject).finally(() => clearTimeout(timer));
  });
