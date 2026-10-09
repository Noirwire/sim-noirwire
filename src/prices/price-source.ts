export interface PricePoint {
  id: string;
  price: bigint;
  atMs: number;
}

export interface PriceSource {
  start(onPrice: (point: PricePoint) => void): void;
  stop(): void;
}
