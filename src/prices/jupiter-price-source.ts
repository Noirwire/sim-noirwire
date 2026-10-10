import { SCALE } from "../engine/money.js";
import type { PricePoint, PriceSource } from "./price-source.js";

export interface JupiterPriceSourceOptions {
  ids: string[];
  baseUrl: string;
  pollIntervalMs: number;
  onError: (error: unknown) => void;
}

type JupiterPriceResponse = Record<string, { usdPrice?: number }>;

const MAX_BACKOFF_MULTIPLIER = 8;
const TOO_MANY_REQUESTS = 429;
/** A poll that is never answered is given up, or the next one would never be scheduled. */
const REQUEST_TIMEOUT_MS = 5_000;

const toScaledPrice = (usdPrice: number): bigint => BigInt(Math.round(usdPrice * Number(SCALE)));

/**
 * Polls Jupiter's price API v3 for every id in one request: a caller with no
 * key is allowed roughly one request every two seconds, however many markets
 * it prices. A 429 doubles the wait, up to eight times the interval. A failed
 * poll is reported through `onError` and the next one is still scheduled.
 */
export class JupiterPriceSource implements PriceSource {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private backoffMultiplier = 1;
  private stopped = true;

  constructor(private readonly options: JupiterPriceSourceOptions) {}

  start(onPrice: (point: PricePoint) => void): void {
    this.stopped = false;
    void this.pollAndScheduleNext(onPrice);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private async pollAndScheduleNext(onPrice: (point: PricePoint) => void): Promise<void> {
    if (this.stopped) return;
    try {
      await this.poll(onPrice);
    } catch (error) {
      this.options.onError(error);
    }
    if (this.stopped) return;
    this.timer = setTimeout(
      () => void this.pollAndScheduleNext(onPrice),
      this.options.pollIntervalMs * this.backoffMultiplier,
    );
  }

  private async poll(onPrice: (point: PricePoint) => void): Promise<void> {
    const { ids, baseUrl } = this.options;
    const response = await fetch(`${baseUrl}?ids=${ids.join(",")}`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (response.status === TOO_MANY_REQUESTS) {
      this.backoffMultiplier = Math.min(this.backoffMultiplier * 2, MAX_BACKOFF_MULTIPLIER);
      return;
    }
    if (!response.ok) throw new Error(`Jupiter price API responded ${response.status}`);
    const body = (await response.json()) as JupiterPriceResponse;
    const atMs = Date.now();
    for (const id of ids) {
      const usdPrice = body[id]?.usdPrice;
      if (typeof usdPrice === "number" && Number.isFinite(usdPrice)) {
        onPrice({ id, price: toScaledPrice(usdPrice), atMs });
      }
    }
    this.backoffMultiplier = 1;
  }
}
