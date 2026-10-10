export const REQUEST_TIMEOUT_MS = 8_000;

type Fetch = typeof fetch;

/**
 * A request that is never answered is given up after `timeoutMs`. Without
 * this one silent connection would hold a loop's turn forever: every request
 * this service makes to the rollup goes out through it.
 */
export const fetchWithin =
  (timeoutMs: number, transport: Fetch = fetch): Fetch =>
  (input, init) =>
    transport(input, { ...init, signal: AbortSignal.timeout(timeoutMs) });

/** Rejects when `work` has not settled after `timeoutMs`. */
export const within = <T>(work: Promise<T>, timeoutMs: number, what: string): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${what} got no answer in ${timeoutMs} ms`)),
      timeoutMs,
    );
    work.then(resolve, reject).finally(() => clearTimeout(timer));
  });
