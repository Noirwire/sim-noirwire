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

/** Prepares that nobody has submitted yet which one network address may hold at once. */
export const HELD_RESERVATIONS_PER_ADDRESS = 1;

/** The day is full, but some of its seats are prepares that have not been submitted and may be freed. */
export const RESERVATIONS_HELD: NotAdmitted = {
  ok: false,
  status: 503,
  reason: "new accounts are being opened right now: try again in a minute",
};

const ADDRESS_HOLDS_ONE: NotAdmitted = {
  ok: false,
  status: 429,
  reason:
    "this network address has an account opening in progress: finish it, or try again in a minute",
};

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
 *
 * A prepare hands out a gate-signed transaction that its owner can send without
 * asking the gate, so it counts toward the day's limits like any seat until the
 * chain shows it cannot land. What a refusal says tells the two apart: "all
 * given out" only when seats that were submitted or landed fill the day, and
 * "try again in a minute" while some of the counted seats are prepares that
 * may yet be freed. One network address holds one prepare at a time.
 */
export class Admission {
  constructor(
    private readonly invites: Invitations,
    private readonly ledger: SeatLedger,
    private readonly limits: AdmissionLimits,
    private readonly clock: Clock,
  ) {}

  /**
   * Looks without changing anything: for the first answer, before a transaction is built. With
   * `holding`, for a prepare that will only hold a reservation, it also refuses when the
   * reservations allowed at once are taken.
   */
  check(
    owner: string,
    code: string | undefined,
    asker: string,
    programSeatsPerDay: number | null,
    holding = false,
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
    // A prepare counts like any seat: its gate-signed transaction can be sent without asking the gate.
    if (this.ledger.seatsToday(now, id, owner) >= perDay) {
      // Sold out only when seats that were submitted or landed fill the day; else some may yet be freed.
      if (this.ledger.submittedToday(now, id, owner) >= perDay) {
        return {
          ok: false,
          status: 503,
          reason: `today's new accounts are all given out: try again tomorrow, ${NEXT_DAY}`,
        };
      }
      return RESERVATIONS_HELD;
    }
    if (this.ledger.seatsTodayFor(asker, now, id, owner) >= this.limits.perAskerPerDay) {
      if (this.ledger.submittedTodayFor(asker, now, id, owner) >= this.limits.perAskerPerDay) {
        return {
          ok: false,
          status: 429,
          reason: `this network address has opened its account for today: try again tomorrow, ${NEXT_DAY}`,
        };
      }
      return ADDRESS_HOLDS_ONE;
    }
    if (
      holding &&
      this.ledger.heldReservationsFor(asker, id, owner) >= HELD_RESERVATIONS_PER_ADDRESS
    ) {
      return ADDRESS_HOLDS_ONE;
    }
    return {
      ok: true,
      invite: id,
      afterUnconfirmed: this.ledger.forInvite(id)?.state === "unconfirmed",
    };
  }

  /**
   * Checks again and writes the seat down before anything is signed. A seat that cannot be written
   * down is refused. A `held` seat is a prepare nobody has submitted: it counts like any seat, and
   * is told apart from a submitted one until `commit`.
   */
  async admit(
    owner: string,
    code: string | undefined,
    asker: string,
    programSeatsPerDay: number | null,
    held = false,
  ): Promise<Admitted | NotAdmitted> {
    try {
      await this.ledger.ready();
    } catch {
      return RECORD_NOT_WRITTEN;
    }
    // Nothing waits between this decision and the record being in memory, so two
    // askers cannot both be admitted on the same count.
    const decision = this.check(owner, code, asker, programSeatsPerDay, held);
    if (!decision.ok) return decision;
    try {
      await this.ledger.reserve(decision.invite, owner, asker, this.clock.nowMs(), held);
    } catch {
      return RECORD_NOT_WRITTEN;
    }
    return decision;
  }

  /**
   * The owner submitted from `asker`: the seat is charged to that address, the one `check` just
   * judged. Call it in the same turn as the `check` that allowed the submit, before anything waits,
   * so two submits cannot pass the same count. False if the record could not be saved, and then
   * nothing may be sent.
   */
  async commit(invite: string, asker: string): Promise<boolean> {
    try {
      await this.ledger.commit(invite, asker);
      return true;
    } catch {
      return false;
    }
  }

  /** The seat of this owner that was sent and is not confirmed, whichever invite it was reserved under. */
  unconfirmedFor(owner: string): SeatRecord | undefined {
    return this.ledger.unconfirmedFor(owner);
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

  /** The last block height at which a transaction handed out for this invite can still land. */
  lastValidBlockHeightOf(invite: string): number | undefined {
    return this.ledger.forInvite(invite)?.lastValidBlockHeight;
  }

  /** Takes back a transaction written down by `track` that was never handed out. */
  untrack(invite: string, signature: string, lastValidBlockHeight: number | undefined) {
    return this.ledger.untrack(invite, signature, lastValidBlockHeight);
  }

  /** Seats sent and not confirmed that have signatures to look up. */
  awaitingSettlement(): SeatRecord[] {
    return this.ledger.awaitingSettlement();
  }

  /** Seats reserved at or before `cutoffMs` for which no transaction was ever signed. */
  reservedWithoutTransaction(cutoffMs: number): SeatRecord[] {
    return this.ledger.reservedWithoutTransaction(cutoffMs);
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
