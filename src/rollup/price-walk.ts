export interface PriceStep {
  current: bigint;
  target: bigint;
  maxMoveBps: number;
  tick: bigint;
}

const roundDownToTick = (price: bigint, tick: bigint): bigint => price - (price % tick);

const roundUpToTick = (price: bigint, tick: bigint): bigint => {
  const remainder = price % tick;
  return remainder === 0n ? price : price - remainder + tick;
};

/**
 * The next price to publish on the way from `current` to `target`. The
 * program refuses a price further than `maxMoveBps` from the one before it,
 * so a larger real move is walked there one allowed step at a time. A feed
 * that has no price yet takes the target at once.
 */
export const nextPublishPrice = ({ current, target, maxMoveBps, tick }: PriceStep): bigint => {
  const wanted = roundDownToTick(target, tick);
  if (wanted <= 0n) return current;
  if (current === 0n) return wanted;
  const allowed = (current * BigInt(maxMoveBps)) / 10_000n;
  if (wanted > current + allowed) {
    const stepped = roundDownToTick(current + allowed, tick);
    return stepped > current ? stepped : current;
  }
  if (wanted < current - allowed) {
    const stepped = roundUpToTick(current - allowed, tick);
    return stepped < current ? stepped : current;
  }
  return wanted;
};

/**
 * Whether the next publish lands on the target: the walk from a set-up price
 * to the real one is over, or there never was one.
 */
export const withinOneStep = (step: PriceStep): boolean => {
  if (step.current === 0n) return false;
  const wanted = roundDownToTick(step.target, step.tick);
  return wanted > 0n && nextPublishPrice(step) === wanted;
};
