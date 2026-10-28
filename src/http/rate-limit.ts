import type { Clock } from "../engine/clock.js";
import { clientAddressOf } from "./client-address.js";

const WINDOW_MS = 60_000;

interface Window {
  startedAtMs: number;
  requests: number;
}

/** At most `perMinute` requests from one address in a fixed minute. Held in memory: a restart forgets it. */
export class RateLimiter {
  private readonly windows = new Map<string, Window>();
  private sweptAtMs: number;

  constructor(
    private readonly perMinute: number,
    private readonly clock: Clock,
  ) {
    this.sweptAtMs = clock.nowMs();
  }

  /**
   * Counts a request, and returns 0 if it may go ahead or else the seconds until the address may try again.
   * An IPv4-mapped address counts as its IPv4 address, and an IPv6 one as its /64 network.
   */
  hit(caller: string): number {
    const address = clientAddressOf(caller);
    const now = this.clock.nowMs();
    this.sweepIfDue(now);
    const window = this.windows.get(address);
    if (!window || now - window.startedAtMs >= WINDOW_MS) {
      this.windows.set(address, { startedAtMs: now, requests: 1 });
      return 0;
    }
    window.requests += 1;
    if (window.requests <= this.perMinute) return 0;
    return Math.max(1, Math.ceil((window.startedAtMs + WINDOW_MS - now) / 1_000));
  }

  /** Drops the windows that have ended, so addresses seen once do not pile up. */
  private sweepIfDue(now: number): void {
    if (now - this.sweptAtMs < WINDOW_MS) return;
    this.sweptAtMs = now;
    for (const [address, window] of this.windows) {
      if (now - window.startedAtMs >= WINDOW_MS) this.windows.delete(address);
    }
  }
}

/** At most `perAddress` stream sockets open from one address at a time. */
export class SocketLimiter {
  private readonly open = new Map<string, number>();

  constructor(private readonly perAddress: number) {}

  /** Returns the function to call when the socket closes, or null if the address already holds its share. */
  acquire(caller: string): (() => void) | null {
    const address = clientAddressOf(caller);
    const held = this.open.get(address) ?? 0;
    if (held >= this.perAddress) return null;
    this.open.set(address, held + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.open.get(address) ?? 1) - 1;
      if (left <= 0) this.open.delete(address);
      else this.open.set(address, left);
    };
  }
}
