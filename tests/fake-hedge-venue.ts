import type {
  HedgeAccount,
  HedgeAck,
  HedgeFill,
  HedgeHealth,
  HedgeMarketRules,
  HedgeOrder,
  HedgeVenue,
} from "../src/hedge/hedge-venue.js";
import { dollars } from "./helpers.js";

/** What the fake does with the next order. Without a step it fills the whole order. */
export interface HedgeStep {
  /** How much of the order fills, or all of it. */
  fill?: bigint | "all";
  /** The venue refuses the order. */
  reject?: string;
  /** The answer never arrives: the call throws, whether or not the order filled. */
  lost?: boolean;
  /** The venue accepts the order but the fill shows in the position only after `deliverDelayed`. */
  delayed?: boolean;
}

/** A hedge venue that does what a test scripts: fills, partial fills, refusals, outages, lost and late answers. */
export class FakeHedgeVenue implements HedgeVenue {
  position = 0n;
  equity = dollars(1_000);
  rulesNow: HedgeMarketRules = {
    minOrderNotional: dollars(10),
    sizeIncrement: dollars(0.01),
    priceIncrement: dollars(0.01),
  };
  /** Every call throws while this is set. */
  down = false;
  unhealthyBecause: string | null = null;
  readonly placed: HedgeOrder[] = [];
  readonly cancelled: string[] = [];
  private readonly steps: HedgeStep[] = [];
  private readonly filled: HedgeFill[] = [];
  private delayedFills: HedgeOrder[] = [];

  script(...steps: HedgeStep[]): void {
    this.steps.push(...steps);
  }

  /** The delayed fills reach the position. */
  deliverDelayed(): void {
    for (const order of this.delayedFills) this.apply(order, order.size);
    this.delayedFills = [];
  }

  async rules(): Promise<HedgeMarketRules> {
    this.reachable();
    return this.rulesNow;
  }

  async account(): Promise<HedgeAccount> {
    this.reachable();
    return { position: this.position, equity: this.equity };
  }

  async placeIoc(order: HedgeOrder): Promise<HedgeAck> {
    this.reachable();
    this.placed.push(order);
    const step = this.steps.shift() ?? {};
    if (step.reject !== undefined) return { status: "rejected", reason: step.reject };
    const fill = step.fill === undefined || step.fill === "all" ? order.size : step.fill;
    if (step.delayed) {
      this.delayedFills.push({ ...order, size: fill });
    } else {
      this.apply(order, fill);
    }
    if (step.lost) throw new Error("the hedge venue did not answer in time");
    return { status: "accepted" };
  }

  async cancel(clientId: string): Promise<void> {
    this.reachable();
    this.cancelled.push(clientId);
  }

  async fills(sinceMs: number): Promise<HedgeFill[]> {
    this.reachable();
    return this.filled.filter((fill) => fill.atMs >= sinceMs);
  }

  async health(): Promise<HedgeHealth> {
    this.reachable();
    return this.unhealthyBecause === null
      ? { ok: true }
      : { ok: false, reason: this.unhealthyBecause };
  }

  private reachable(): void {
    if (this.down) throw new Error("the hedge venue is unreachable");
  }

  private apply(order: HedgeOrder, size: bigint): void {
    if (size <= 0n) return;
    this.position += order.side === "buy" ? size : -size;
    this.filled.push({
      clientId: order.clientId,
      side: order.side,
      size,
      price: order.limitPrice,
      atMs: 0,
    });
  }
}
