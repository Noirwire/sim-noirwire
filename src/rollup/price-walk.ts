import { BPS_PER_WHOLE, roundDownToStep, roundUpToStep } from "../engine/money.js";

export interface PriceStep {
  current: bigint;
  target: bigint;
  maxMoveBps: number;
  tick: bigint;
}

/**
 * The next price to publish on the way from `current` to `target`. The
 * program refuses a price further than `maxMoveBps` from the one before it,
 * so a larger real move is walked there one allowed step at a time. A feed
 * that has no price yet takes the target at once.
 */
export const nextPublishPrice = ({ current, target, maxMoveBps, tick }: PriceStep): bigint => {
  const wanted = roundDownToStep(target, tick);
  if (wanted <= 0n) return current;
  if (current === 0n) return wanted;
  const allowed = (current * BigInt(maxMoveBps)) / BPS_PER_WHOLE;
  if (wanted > current + allowed) {
    const stepped = roundDownToStep(current + allowed, tick);
    return stepped > current ? stepped : current;
  }
  if (wanted < current - allowed) {
    const stepped = roundUpToStep(current - allowed, tick);
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
  const wanted = roundDownToStep(step.target, step.tick);
  return wanted > 0n && nextPublishPrice(step) === wanted;
};

/**
 * Whether a publish stamped `clockSeconds` can be accepted. The program
 * refuses a publish time that is not after the feed's last one, so two
 * publishes of one market never share a second of the rollup's clock.
 */
export const publishTimeIsNew = (clockSeconds: number, lastAcceptedSeconds: number): boolean =>
  clockSeconds > lastAcceptedSeconds;
