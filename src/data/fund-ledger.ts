import type { Clock } from "../engine/clock.js";

export interface FundLedgerOptions {
  perIpLimit: number;
  perIpWindowMs: number;
  clock: Clock;
}

export type FundDecision =
  | { ok: true }
  | { ok: false; status: 409; reason: string }
  | { ok: false; status: 429; reason: string };

/** One grant per address, forever; a separate, time-windowed cap per IP. */
export class FundLedger {
  private readonly grantedAddresses = new Set<string>();
  private readonly ipTimestampsMs = new Map<string, number[]>();

  constructor(private readonly options: FundLedgerOptions) {}

  check(address: string, ip: string): FundDecision {
    if (this.grantedAddresses.has(address)) {
      return { ok: false, status: 409, reason: "this address already received its fund grant" };
    }
    const recent = this.recentIpTimestamps(ip);
    if (recent.length >= this.options.perIpLimit) {
      return { ok: false, status: 429, reason: "too many fund grants from this address's IP" };
    }
    return { ok: true };
  }

  record(address: string, ip: string): void {
    this.grantedAddresses.add(address);
    const recent = this.recentIpTimestamps(ip);
    recent.push(this.options.clock.nowMs());
    this.ipTimestampsMs.set(ip, recent);
  }

  private recentIpTimestamps(ip: string): number[] {
    const now = this.options.clock.nowMs();
    const cutoff = now - this.options.perIpWindowMs;
    const filtered = (this.ipTimestampsMs.get(ip) ?? []).filter((t) => t >= cutoff);
    this.ipTimestampsMs.set(ip, filtered);
    return filtered;
  }

  exportSnapshot(): string[] {
    return [...this.grantedAddresses];
  }

  loadSnapshot(addresses: string[]): void {
    for (const address of addresses) this.grantedAddresses.add(address);
  }
}
