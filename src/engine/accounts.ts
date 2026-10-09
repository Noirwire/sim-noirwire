import type { MarketId, TokenBalance, TraderKey } from "./types.js";

export interface Position {
  size: bigint;
  entryPrice: bigint;
  fundingIndexSnapshot: bigint;
}

export const emptyPosition = (fundingIndex: bigint): Position => ({
  size: 0n,
  entryPrice: 0n,
  fundingIndexSnapshot: fundingIndex,
});

export class Account {
  readonly trader: TraderKey;
  readonly balances = new Map<string, TokenBalance>();
  readonly positions = new Map<MarketId, Position>();

  constructor(trader: TraderKey) {
    this.trader = trader;
  }

  balanceOf(token: string): TokenBalance {
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

  positionIn(market: MarketId, fundingIndex: bigint): Position {
    let position = this.positions.get(market);
    if (!position) {
      position = emptyPosition(fundingIndex);
      this.positions.set(market, position);
    }
    return position;
  }
}
