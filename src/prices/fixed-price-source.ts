import type { PricePoint, PriceSource } from "./price-source.js";

/**
 * A price source a test drives by hand: `push` delivers one point to
 * whatever listener `start` registered, synchronously, on no timer at all.
 */
export class FixedPriceSource implements PriceSource {
  private onPrice: ((point: PricePoint) => void) | null = null;

  start(onPrice: (point: PricePoint) => void): void {
    this.onPrice = onPrice;
  }

  stop(): void {
    this.onPrice = null;
  }

  push(point: PricePoint): void {
    this.onPrice?.(point);
  }
}
