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

  /** Only whether the address has its grant: for a request the IP cap was already paid for. */
  checkAddress(address: string): FundDecision {
    if (this.grantedAddresses.has(address)) {
      return { ok: false, status: 409, reason: "this address already received its fund grant" };
    }
    return { ok: true };
  }

  check(address: string, ip: string): FundDecision {
    const addressDecision = this.checkAddress(address);
    if (!addressDecision.ok) return addressDecision;
    const recent = this.recentIpTimestamps(ip);
    if (recent.length >= this.options.perIpLimit) {
      return { ok: false, status: 429, reason: "too many fund grants from this address's IP" };
    }
    return { ok: true };
  }

  record(address: string, ip: string): void {
    this.recordGrant(address);
    this.countAgainstIp(ip);
  }

  /** The address has its grant. Counting the IP is the caller's: the rollup flow counted it at `prepare`. */
  recordGrant(address: string): void {
    this.grantedAddresses.add(address);
  }

  /** Counts one request against `ip`'s window: a grant does, and so does an attempt that cost the rollup a call and ended in none. */
  countAgainstIp(ip: string): void {
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

  get grantCount(): number {
    return this.grantedAddresses.size;
  }

  exportSnapshot(): string[] {
    return [...this.grantedAddresses];
  }

  loadSnapshot(addresses: string[]): void {
    for (const address of addresses) this.grantedAddresses.add(address);
  }
}
