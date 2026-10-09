import { type Connection, type Keypair, PublicKey } from "@solana/web3.js";
import type { Clock } from "../engine/clock.js";
import { checkSubmitted } from "./open-request.js";
import { FIRST_TRADER_SEAT, SEAT_COUNT, type Program, sendSignedAndConfirm } from "./program.js";

const PREPARED_FOR_MS = 45_000;

export type Prepared =
  | { ok: true; transaction: string; expiresAtMs: number }
  | { ok: false; status: 400 | 503; reason: string };

export type Funded =
  { ok: true; signature: string } | { ok: false; status: 400 | 409 | 410; reason: string };

export interface FundingDeskOptions {
  program: Program;
  connection: Connection;
  gate: Keypair;
  faucet: Keypair;
  mint: string;
  amountAtoms: bigint;
  clock: Clock;
  /** Null when the question could not be answered right now. */
  seatIsOpen(seat: number): Promise<boolean | null>;
  knownOpenSeats(): Promise<number[]>;
}

interface PreparedRequest {
  message: Uint8Array;
  seat: number;
  expiresAtMs: number;
}

const publicKeyOf = (value: string): PublicKey | null => {
  try {
    return new PublicKey(value);
  } catch {
    return null;
  }
};

/**
 * Opens and funds a new user's account in one transaction, in two steps.
 *
 * `prepare` builds the transaction: open a seat for the user's owner key and
 * four order keys, and deposit the grant from the faucet. `submit` takes it
 * back with the user's signature, checks it is the very transaction that was
 * built, adds the gate's and the faucet's signatures and sends it.
 *
 * A deposit names a seat by number and the program does not say which seat a
 * new trader got. It does give out the lowest free seat, and this service is
 * the only holder of the gate key, so `prepare` finds that seat first and
 * the deposit names it. If anything else took the seat in between, the
 * deposit fails and with it the whole transaction: no account, no grant, and
 * the user prepares again. A grant can never land on somebody else's seat.
 */
export class FundingDesk {
  private readonly prepared = new Map<string, PreparedRequest>();
  private readonly knownOpen = new Set<number>();
  private seeded = false;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: FundingDeskOptions) {}

  private oneAtATime<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private reservedSeats(now: number): Set<number> {
    const seats = new Set<number>();
    for (const [owner, request] of this.prepared) {
      if (request.expiresAtMs <= now) this.prepared.delete(owner);
      else seats.add(request.seat);
    }
    return seats;
  }

  private async lowestFreeSeat(reserved: Set<number>): Promise<number | null> {
    if (!this.seeded) {
      for (const seat of await this.options.knownOpenSeats()) this.knownOpen.add(seat);
      this.seeded = true;
    }
    for (let seat = FIRST_TRADER_SEAT; seat < SEAT_COUNT; seat += 1) {
      if (this.knownOpen.has(seat)) continue;
      const open = await this.options.seatIsOpen(seat);
      if (open === null) return null;
      if (open) {
        this.knownOpen.add(seat);
        continue;
      }
      if (!reserved.has(seat)) return seat;
    }
    return null;
  }

  prepare(owner: string, orderKeys: string[]): Promise<Prepared> {
    const ownerKey = publicKeyOf(owner);
    const keys = orderKeys.map(publicKeyOf);
    if (!ownerKey || keys.some((key) => key === null)) {
      return Promise.resolve({ ok: false, status: 400, reason: "not a public key" });
    }
    const distinct = new Set([owner, ...orderKeys]);
    if (distinct.size !== orderKeys.length + 1) {
      return Promise.resolve({
        ok: false,
        status: 400,
        reason: "the order keys must differ from each other and from the owner",
      });
    }
    return this.oneAtATime(async () => {
      const now = this.options.clock.nowMs();
      this.prepared.delete(owner);
      const seat = await this.lowestFreeSeat(this.reservedSeats(now));
      if (seat === null) {
        return { ok: false, status: 503, reason: "no seat can be offered right now, try again" };
      }
      const transaction = await this.options.program.openAndFundTransaction(
        this.options.connection,
        {
          gate: this.options.gate.publicKey,
          faucet: this.options.faucet.publicKey,
          owner: ownerKey,
          orderKeys: keys as PublicKey[],
          seat,
          mint: this.options.mint,
          amount: this.options.amountAtoms,
        },
      );
      const expiresAtMs = now + PREPARED_FOR_MS;
      this.prepared.set(owner, { message: transaction.serializeMessage(), seat, expiresAtMs });
      return {
        ok: true,
        transaction: transaction
          .serialize({ requireAllSignatures: false, verifySignatures: false })
          .toString("base64"),
        expiresAtMs,
      };
    });
  }

  submit(owner: string, transactionBase64: string): Promise<Funded> {
    return this.oneAtATime(async () => {
      const request = this.prepared.get(owner);
      if (!request || request.expiresAtMs <= this.options.clock.nowMs()) {
        this.prepared.delete(owner);
        return {
          ok: false,
          status: 410,
          reason: "nothing is prepared for this owner: prepare again",
        };
      }
      const checked = checkSubmitted(
        request.message,
        Buffer.from(transactionBase64, "base64"),
        new PublicKey(owner),
      );
      if (!checked.ok) return { ok: false, status: 400, reason: checked.reason };

      this.prepared.delete(owner);
      checked.transaction.partialSign(this.options.gate, this.options.faucet);
      try {
        const signature = await sendSignedAndConfirm(this.options.connection, checked.transaction);
        this.knownOpen.add(request.seat);
        return { ok: true, signature };
      } catch {
        this.knownOpen.clear();
        this.seeded = false;
        return {
          ok: false,
          status: 409,
          reason:
            "the account was not opened: it exists already, or its seat was taken. Prepare again",
        };
      }
    });
  }
}
