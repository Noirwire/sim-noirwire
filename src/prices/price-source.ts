export interface PricePoint {
  id: string;
  price: bigint;
  atMs: number;
}

export type PricePace = "fast" | "slow";

export interface PriceSource {
  start(onPrice: (point: PricePoint) => void): void;
  stop(): void;
  /** How often prices are fetched. Going from slow to fast fetches at once. */
  setPace(pace: PricePace): void;
  /**
   * Fetches prices now, whatever the pace. Resolves once the answer has been
   * delivered: true when it delivered prices, false when the fetch failed or
   * was turned away (a rate limit), in which case nothing new was delivered.
   */
  pollNow(): Promise<boolean>;
}
