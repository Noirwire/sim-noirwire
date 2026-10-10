/**
 * How many orders users have placed on the program since this process
 * started. A user's order is private: only the chain's public order counter
 * is known. The user count is that counter's growth less the bots' own
 * orders, those executed and those still on their way.
 */
export class UserOrderCount {
  private chainOrdersAtStart: bigint | null = null;
  private botOrdersExecuted = 0;
  private botOrdersInFlight = 0;

  botOrderSent(): void {
    this.botOrdersInFlight += 1;
  }

  botOrderAnswered(): void {
    this.botOrdersInFlight -= 1;
  }

  botOrderExecuted(): void {
    this.botOrdersExecuted += 1;
  }

  /** Takes the chain's order counter and returns the user count it implies. */
  afterChainOrders(total: bigint): number {
    this.chainOrdersAtStart ??= total;
    const sinceStart = Number(total - this.chainOrdersAtStart);
    return sinceStart - this.botOrdersExecuted - this.botOrdersInFlight;
  }
}
