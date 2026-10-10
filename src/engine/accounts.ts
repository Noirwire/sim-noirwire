import type { MarketId, TokenBalance } from "./types.js";

export interface Position {
  size: bigint;
  entryPrice: bigint;
  fundingIndexSnapshot: bigint;
}

/** One trader's balances per token and perpetual positions per market. */
export class Account {
  readonly balances = new Map<string, TokenBalance>();
  readonly positions = new Map<MarketId, Position>();

  private balanceOf(token: string): TokenBalance {
    let entry = this.balances.get(token);
    if (!entry) {
      entry = { balance: 0n, locked: 0n };
      this.balances.set(token, entry);
    }
    return entry;
  }

  freeBalance(token: string): bigint {
    return this.balanceOf(token).balance;
  }

  credit(token: string, amount: bigint): void {
    this.balanceOf(token).balance += amount;
  }

  debit(token: string, amount: bigint): void {
    this.balanceOf(token).balance -= amount;
  }

  lock(token: string, amount: bigint): void {
    const entry = this.balanceOf(token);
    entry.balance -= amount;
    entry.locked += amount;
  }

  unlock(token: string, amount: bigint): void {
    const entry = this.balanceOf(token);
    entry.locked -= amount;
    entry.balance += amount;
  }

  consumeLocked(token: string, amount: bigint): void {
    this.balanceOf(token).locked -= amount;
  }

  /** The position in `market`, opened flat at the current funding index when there is none. */
  positionIn(market: MarketId, fundingIndex: bigint): Position {
    let position = this.positions.get(market);
    if (!position) {
      position = { size: 0n, entryPrice: 0n, fundingIndexSnapshot: fundingIndex };
      this.positions.set(market, position);
    }
    return position;
  }
}
