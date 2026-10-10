export const DAY_MS = 24 * 60 * 60 * 1000;

const PERCENT = 100;

/** The notional traded in the last 24 hours, from fills added in time order. */
export class DayVolume {
  private readonly fills: { atMs: number; notional: bigint }[] = [];

  add(atMs: number, notional: bigint): void {
    this.fills.push({ atMs, notional });
    while (this.fills.length > 0 && this.fills[0].atMs < atMs - DAY_MS) this.fills.shift();
  }

  total(nowMs: number): bigint {
    return this.fills
      .filter((fill) => fill.atMs >= nowMs - DAY_MS)
      .reduce((sum, fill) => sum + fill.notional, 0n);
  }
}

/** Past prices in time order, kept for `retentionMs` behind the newest one. */
export class PriceHistory {
  private readonly samples: { atMs: number; price: bigint }[] = [];

  constructor(private readonly retentionMs: number) {}

  add(atMs: number, price: bigint): void {
    this.samples.push({ atMs, price });
    while (this.samples.length > 0 && this.samples[0].atMs < atMs - this.retentionMs) {
      this.samples.shift();
    }
  }

  /** The oldest price at or after `sinceMs`. */
  firstSince(sinceMs: number): bigint | undefined {
    return this.samples.find((sample) => sample.atMs >= sinceMs)?.price;
  }

  latest(): bigint | undefined {
    return this.samples.at(-1)?.price;
  }
}

/** Null when there is no reference price to compare with. */
export const percentChange = (from: bigint | undefined, to: bigint): number | null =>
  from === undefined || from === 0n ? null : (Number(to - from) / Number(from)) * PERCENT;
