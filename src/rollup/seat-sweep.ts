/**
 * Which seats the liquidator tries next. Nobody can read the ledger, and an
 * attempt on an empty seat reads the same as one on a healthy trader, so
 * liquidation is tried blind by seat number, a few seats per tick. The
 * program fills seats from the lowest number up and every new seat needs the
 * gate's signature, so no seat lies beyond the number of accounts the gate
 * ever opened: the sweep walks that far and starts over.
 */
export class SeatSweep {
  private cursor: number;

  constructor(
    private readonly firstSeat: number,
    private readonly seatCount: number,
    private readonly seatsEverOpened: () => number,
  ) {
    this.cursor = firstSeat;
  }

  next(count: number): number[] {
    const end = Math.min(this.seatCount, this.firstSeat + Math.max(1, this.seatsEverOpened()));
    const seats: number[] = [];
    for (let taken = 0; taken < count; taken += 1) {
      if (this.cursor >= end) this.cursor = this.firstSeat;
      seats.push(this.cursor);
      this.cursor += 1;
    }
    return seats;
  }
}

export const SEAT_PREFIX = "seat:";

export const seatTarget = (seat: number): string => `${SEAT_PREFIX}${seat}`;

export const seatOfTarget = (target: string): number | null => {
  if (!target.startsWith(SEAT_PREFIX)) return null;
  const seat = Number(target.slice(SEAT_PREFIX.length));
  return Number.isInteger(seat) && seat >= 0 ? seat : null;
};
