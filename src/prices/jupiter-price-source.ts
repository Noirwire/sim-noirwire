import { SCALE } from "../engine/money.js";
import type { PricePoint, PriceSource } from "./price-source.js";

export interface JupiterPriceSourceOptions {
  ids: string[];
  baseUrl?: string;
  pollIntervalMs?: number;
  maxBackoffMultiplier?: number;
  onError?: (error: unknown) => void;
}

interface JupiterPriceEntry {
  usdPrice?: number;
}

type JupiterPriceResponse = Record<string, JupiterPriceEntry>;

const DEFAULT_BASE_URL = "https://lite-api.jup.ag/price/v3";
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_MAX_BACKOFF_MULTIPLIER = 8;
/** A poll that is never answered is given up, or the next one would never be scheduled. */
const REQUEST_TIMEOUT_MS = 5_000;

const toScaledPrice = (usdPrice: number): bigint => BigInt(Math.round(usdPrice * Number(SCALE)));

/**
 * Polls Jupiter's price API v3 for every configured id in one request, so a
 * keyless caller stays under its roughly one-request-per-two-seconds limit
 * no matter how many markets this service tracks. Backs off on HTTP 429 and
 * never throws out of the polling loop: a failed poll is reported through
 * `onError` and the next poll is still scheduled.
 */
export class JupiterPriceSource implements PriceSource {
  private readonly ids: string[];
  private readonly baseUrl: string;
  private readonly pollIntervalMs: number;
  private readonly maxBackoffMultiplier: number;
  private readonly onError: (error: unknown) => void;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private backoffMultiplier = 1;
  private stopped = true;

  constructor(options: JupiterPriceSourceOptions) {
    this.ids = options.ids;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.maxBackoffMultiplier = options.maxBackoffMultiplier ?? DEFAULT_MAX_BACKOFF_MULTIPLIER;
    this.onError = options.onError ?? (() => {});
  }

  start(onPrice: (point: PricePoint) => void): void {
    this.stopped = false;
    const poll = async (): Promise<void> => {
      if (this.stopped) return;
      try {
        const response = await fetch(`${this.baseUrl}?ids=${this.ids.join(",")}`, {
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (response.status === 429) {
          this.backoffMultiplier = Math.min(this.backoffMultiplier * 2, this.maxBackoffMultiplier);
        } else if (!response.ok) {
          this.onError(new Error(`Jupiter price API responded ${response.status}`));
        } else {
          const body = (await response.json()) as JupiterPriceResponse;
          const atMs = Date.now();
          for (const id of this.ids) {
            const usdPrice = body[id]?.usdPrice;
            if (typeof usdPrice === "number" && Number.isFinite(usdPrice)) {
              onPrice({ id, price: toScaledPrice(usdPrice), atMs });
            }
          }
          this.backoffMultiplier = 1;
        }
      } catch (error) {
        this.onError(error);
      } finally {
        if (!this.stopped) {
          this.timer = setTimeout(() => void poll(), this.pollIntervalMs * this.backoffMultiplier);
        }
      }
    };
    void poll();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
