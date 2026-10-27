import type { Clock } from "../engine/clock.js";
import type { Invitations } from "./invite-list.js";
import type { SeatLedger, SeatRecord } from "./seat-ledger.js";

export interface AdmissionLimits {
  /** Seats the gate signs for in a UTC day, before the program's own limit is taken into account. */
  perDay: number;
  /** Seats the gate signs for in a UTC day for one asker address. */
  perAskerPerDay: number;
}

export type Admitted = {
  ok: true;
  invite: string;
  /** An earlier try for this invite was sent and never confirmed, so its account may exist. */
  afterUnconfirmed: boolean;
};
export type NotAdmitted = { ok: false; status: 403 | 409 | 429 | 503; reason: string };

const NEXT_DAY = "it resets at 00:00 UTC";

export const RECORD_NOT_WRITTEN: NotAdmitted = {
  ok: false,
  status: 503,
  reason:
    "the gate could not write its seat record, so it signed nothing. Nothing changed: try again, and tell the operator if it keeps happening",
};

/**
 * Whether the gate may sign `open_trader` for a person: on the invite list,
 * the invite not used, and the day's limits not reached. The daily limit is
 * the smaller of the configured one and one under the program's
 * `max_seats_per_day`, so the program's own limit is never the first to say no.
 */
export class Admission {
  constructor(
    private readonly invites: Invitations,
    private readonly ledger: SeatLedger,
    private readonly limits: AdmissionLimits,
    private readonly clock: Clock,
  ) {}

  /** Looks without changing anything: for the first answer, before a transaction is built. */
  check(
    owner: string,
    code: string | undefined,
    asker: string,
    programSeatsPerDay: number | null,
  ): Admitted | NotAdmitted {
    const invitation = this.invites.check(owner, code);
    if (!invitation.ok) return { ok: false, status: 403, reason: invitation.reason };
    const { id } = invitation;

    if (!this.invites.open && this.ledger.forInvite(id)?.state === "opened") {
      return {
        ok: false,
        status: 409,
        reason: "this invite has been used already: it opens one account",
      };
    }
    if (this.ledger.openedFor(owner)) {
      return {
        ok: false,
        status: 409,
        reason: "this address has an account already. Nothing changed",
      };
    }
    if (programSeatsPerDay === null) {
      return {
        ok: false,
        status: 503,
        reason: "the service is still starting, try again in a few seconds",
      };
    }
    const perDay = Math.min(this.limits.perDay, programSeatsPerDay - 1);
    const now = this.clock.nowMs();
    if (this.ledger.seatsToday(now, id) >= perDay) {
      return {
        ok: false,
        status: 503,
        reason: `today's new accounts are all given out: try again tomorrow, ${NEXT_DAY}`,
      };
    }
    if (this.ledger.seatsTodayFor(asker, now, id) >= this.limits.perAskerPerDay) {
      return {
        ok: false,
        status: 429,
        reason: `this network address has opened its account for today: try again tomorrow, ${NEXT_DAY}`,
      };
    }
    return {
      ok: true,
      invite: id,
      afterUnconfirmed: this.ledger.forInvite(id)?.state === "unconfirmed",
    };
  }

  /** Checks again and writes the seat down before anything is signed. A seat that cannot be written down is refused. */
  async admit(
    owner: string,
    code: string | undefined,
    asker: string,
    programSeatsPerDay: number | null,
  ): Promise<Admitted | NotAdmitted> {
    try {
      await this.ledger.ready();
    } catch {
      return RECORD_NOT_WRITTEN;
    }
    // Nothing waits between this decision and the record being in memory, so two
    // askers cannot both be admitted on the same count.
    const decision = this.check(owner, code, asker, programSeatsPerDay);
    if (!decision.ok) return decision;
    try {
      await this.ledger.reserve(decision.invite, owner, asker, this.clock.nowMs());
    } catch {
      return RECORD_NOT_WRITTEN;
    }
    return decision;
  }

  /** Writes down a transaction handed out for a reserved seat. False if it could not be saved. */
  async track(invite: string, signature: string, lastValidBlockHeight: number): Promise<boolean> {
    try {
      await this.ledger.track(invite, signature, lastValidBlockHeight);
      return true;
    } catch {
      return false;
    }
  }

  /** Seats sent and not confirmed that have signatures to look up. */
  awaitingSettlement(): SeatRecord[] {
    return this.ledger.awaitingSettlement();
  }

  /** The rollup confirmed the seat. */
  confirm(invite: string): Promise<void> {
    return this.ledger.confirm(invite);
  }

  /** The seat was not opened. */
  release(invite: string): Promise<void> {
    return this.ledger.release(invite);
  }
}
