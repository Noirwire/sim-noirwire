import { SCALE } from "../engine/money.js";
import type { PricePace, PricePoint, PriceSource } from "./price-source.js";

export interface JupiterPriceSourceOptions {
  ids: string[];
  baseUrl: string;
  /** The wait between two polls at the fast pace. */
  pollIntervalMs: number;
  /** The wait between two polls at the slow pace. */
  slowPollIntervalMs: number;
  onError: (error: unknown) => void;
  onRecovered?: () => void;
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
 * At the slow pace the same polls come far less often.
 */
export class JupiterPriceSource implements PriceSource {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private backoffMultiplier = 1;
  private stopped = true;
  private pace: PricePace = "fast";
  private inFlight: Promise<boolean> | null = null;
  private onPrice: ((point: PricePoint) => void) | null = null;
  private failing = false;

  constructor(private readonly options: JupiterPriceSourceOptions) {}

  start(onPrice: (point: PricePoint) => void): void {
    this.stopped = false;
    this.onPrice = onPrice;
    void this.pollAndScheduleNext();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  setPace(pace: PricePace): void {
    if (pace === this.pace) return;
    this.pace = pace;
    if (pace === "fast") void this.pollNow();
  }

  pollNow(): Promise<boolean> {
    if (this.inFlight) return this.inFlight;
    if (this.stopped) return Promise.resolve(false);
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    return this.pollAndScheduleNext();
  }

  private intervalMs(): number {
    const { pollIntervalMs, slowPollIntervalMs } = this.options;
    return this.pace === "fast" ? pollIntervalMs : slowPollIntervalMs;
  }

  private pollAndScheduleNext(): Promise<boolean> {
    this.inFlight ??= this.pollOnce().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async pollOnce(): Promise<boolean> {
    if (this.stopped || !this.onPrice) return false;
    let delivered = false;
    try {
      delivered = await this.poll(this.onPrice);
      if (this.failing) this.options.onRecovered?.();
      this.failing = false;
    } catch (error) {
      this.failing = true;
      this.options.onError(error);
    }
    if (this.stopped) return delivered;
    this.timer = setTimeout(
      () => void this.pollAndScheduleNext(),
      this.intervalMs() * this.backoffMultiplier,
    );
    return delivered;
  }

  /** True when the answer held a price for every id and each was delivered. */
  private async poll(onPrice: (point: PricePoint) => void): Promise<boolean> {
    const { ids, baseUrl } = this.options;
    const response = await fetch(`${baseUrl}?ids=${ids.join(",")}`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (response.status === TOO_MANY_REQUESTS) {
      this.backoffMultiplier = Math.min(this.backoffMultiplier * 2, MAX_BACKOFF_MULTIPLIER);
      return false;
    }
    if (!response.ok) throw new Error(`Jupiter price API responded ${response.status}`);
    const body = (await response.json()) as JupiterPriceResponse;
    const atMs = Date.now();
    let delivered = 0;
    for (const id of ids) {
      const usdPrice = body[id]?.usdPrice;
      if (typeof usdPrice === "number" && Number.isFinite(usdPrice)) {
        onPrice({ id, price: toScaledPrice(usdPrice), atMs });
        delivered += 1;
      }
    }
    this.backoffMultiplier = 1;
    return delivered === ids.length;
  }
}
