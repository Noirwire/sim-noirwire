import type { SeatRange } from "./chain-types.js";

/** The most seats one range liquidation takes: the program counts them in 16 bits. */
const MOST_SEATS_PER_RANGE = 0xffff;

/**
 * Which seats the liquidator tries next. Nobody can read the ledger, and an
 * attempt on an empty seat reads the same as one on a healthy trader, so
 * liquidation is tried blind, a range of consecutive seats per call. A seat
 * can sit anywhere below the exchange's seat capacity (an emptied seat goes
 * back to the exchange and the next one to deposit may take it), so the sweep
 * walks the whole capacity and starts over.
 */
export class SeatSweep {
  private cursor: number;

  constructor(
    private readonly firstSeat: number,
    /** The exchange's seat capacity; null while it is not known, when there is nothing to sweep. */
    private readonly seatBound: () => number | null,
  ) {
    this.cursor = firstSeat;
  }

  next(count: number): SeatRange | null {
    const end = this.seatBound();
    if (end === null || end <= this.firstSeat) return null;
    if (this.cursor >= end) this.cursor = this.firstSeat;
    const size = Math.min(Math.max(1, count), MOST_SEATS_PER_RANGE, end - this.cursor);
    const range = { start: this.cursor, count: size };
    this.cursor += size;
    return range;
  }

  /** Carries on from `seat`, where a sweep that ended early stopped. */
  resumeAt(seat: number): void {
    this.cursor = Math.max(this.firstSeat, seat);
  }
}

const RANGE_PREFIX = "seats:";

/** A range of seats as a liquidation target, where the in-memory venue names a trader. */
export const seatRangeTarget = ({ start, count }: SeatRange): string =>
  `${RANGE_PREFIX}${start}:${count}`;

export const seatRangeOfTarget = (target: string): SeatRange | null => {
  if (!target.startsWith(RANGE_PREFIX)) return null;
  const [start, count, ...rest] = target.slice(RANGE_PREFIX.length).split(":").map(Number);
  if (rest.length > 0 || start === undefined || count === undefined) return null;
  const valid = Number.isInteger(start) && start >= 0 && Number.isInteger(count) && count >= 1;
  return valid ? { start, count } : null;
};
