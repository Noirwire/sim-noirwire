import type { PricePoint, PriceSource } from "../../src/prices/price-source.js";

const REPEATS_EVERY_MS = 1_000;

/**
 * A price source a test drives by hand: `push` delivers one point to
 * whatever listener `start` registered, synchronously. Like a source that is
 * polled, it says the last thing it was told again every second, as of then:
 * the service publishes no price whose source has gone quiet.
 */
export class FixedPriceSource implements PriceSource {
  private onPrice: ((point: PricePoint) => void) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly latest = new Map<string, PricePoint>();

  start(onPrice: (point: PricePoint) => void): void {
    this.onPrice = onPrice;
    this.timer = setInterval(() => void this.pollNow(), REPEATS_EVERY_MS);
    this.timer.unref();
  }

  stop(): void {
    this.onPrice = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  setPace(): void {}

  /** Delivers the last point of each id again, as of now: a fetch that answered. */
  async pollNow(): Promise<boolean> {
    for (const point of this.latest.values()) this.onPrice?.({ ...point, atMs: Date.now() });
    return this.onPrice !== null;
  }

  push(point: PricePoint): void {
    this.latest.set(point.id, point);
    this.onPrice?.(point);
  }
}
