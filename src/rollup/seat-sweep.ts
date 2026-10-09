const WRAP_AFTER_EMPTY_SEATS = 16;

/**
 * Which seats the liquidator tries next. Nobody can read the ledger, so
 * liquidation is tried blind by seat number, a few seats per tick. The
 * program fills seats from the lowest number up, so a long run of seats that
 * are not open means the end of the occupied range, and the sweep starts
 * over instead of walking the whole empty table.
 */
export class SeatSweep {
  private cursor: number;
  private emptyRun = 0;

  constructor(
    private readonly firstSeat: number,
    private readonly seatCount: number,
  ) {
    this.cursor = firstSeat;
  }

  next(count: number): number[] {
    const seats: number[] = [];
    for (let taken = 0; taken < count; taken += 1) {
      seats.push(this.cursor);
      this.cursor = this.cursor + 1 >= this.seatCount ? this.firstSeat : this.cursor + 1;
    }
    return seats;
  }

  report(seatOpen: boolean): void {
    if (seatOpen) {
      this.emptyRun = 0;
      return;
    }
    this.emptyRun += 1;
    if (this.emptyRun >= WRAP_AFTER_EMPTY_SEATS) {
      this.cursor = this.firstSeat;
      this.emptyRun = 0;
    }
  }
}

export const SEAT_PREFIX = "seat:";

export const seatTarget = (seat: number): string => `${SEAT_PREFIX}${seat}`;

export const seatOfTarget = (target: string): number | null => {
  if (!target.startsWith(SEAT_PREFIX)) return null;
  const seat = Number(target.slice(SEAT_PREFIX.length));
  return Number.isInteger(seat) && seat >= 0 ? seat : null;
};
