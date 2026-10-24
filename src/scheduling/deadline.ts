/** A call did not answer within its deadline. What it was doing may still happen. */
export class DeadlineExceeded extends Error {
  constructor(what: string, deadlineMs: number) {
    super(`${what} did not answer within ${Math.round(deadlineMs / 1_000)} s`);
    this.name = "DeadlineExceeded";
  }
}

/**
 * `work`, or a `DeadlineExceeded` once `deadlineMs` has passed without an
 * answer. The work itself is not stopped: an answer that comes after the
 * deadline is dropped, and so is its failure, and nobody should treat it as
 * the call's result.
 */
export const withinDeadline = <T>(work: Promise<T>, deadlineMs: number, what: string): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new DeadlineExceeded(what, deadlineMs)), deadlineMs);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
