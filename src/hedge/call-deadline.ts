/** Starts a timer and returns what stops it. Injected so a test can fire a deadline without waiting. */
export type Schedule = (fire: () => void, afterMs: number) => () => void;

export const realSchedule: Schedule = (fire, afterMs) => {
  const timer = setTimeout(fire, afterMs);
  return () => clearTimeout(timer);
};

/** A venue call that did not answer in time. Whatever it was doing may still happen. */
export class VenueCallTimeout extends Error {
  constructor(what: string, afterMs: number) {
    super(`the hedge venue did not answer ${what} within ${afterMs} ms`);
    this.name = "VenueCallTimeout";
  }
}

/**
 * `call`'s answer, or a `VenueCallTimeout` once `afterMs` has passed. An answer
 * that arrives after the timeout is dropped, whether it is a result or an error.
 */
export const withinDeadline = <T>(
  what: string,
  afterMs: number,
  schedule: Schedule,
  call: () => Promise<T>,
): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    let over = false;
    const stop = schedule(() => {
      over = true;
      reject(new VenueCallTimeout(what, afterMs));
    }, afterMs);
    Promise.resolve()
      .then(call)
      .then(
        (value) => {
          if (over) return;
          stop();
          resolve(value);
        },
        (error: unknown) => {
          if (over) return;
          stop();
          reject(error);
        },
      );
  });

/** What may be logged of a failure whose message another party wrote: its class, never its text. */
export const errorClass = (error: unknown): string =>
  error instanceof Error ? error.name : "non-error";
