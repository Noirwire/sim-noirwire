/** The pieces of work an owner has started and not seen end, so it can tell when it is idle. */
export class InFlight {
  private readonly work = new Set<Promise<unknown>>();

  /** Returns `work` itself, remembered until it settles. */
  track<T>(work: Promise<T>): Promise<T> {
    this.work.add(work);
    const forget = (): void => void this.work.delete(work);
    work.then(forget, forget);
    return work;
  }

  /** Resolves once everything tracked so far has ended. */
  async idle(): Promise<void> {
    await Promise.allSettled([...this.work]);
  }
}
