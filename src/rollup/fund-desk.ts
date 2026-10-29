import { type Keypair, PublicKey } from "@solana/web3.js";
import type { Clock } from "../engine/clock.js";
import type { Session } from "./connections.js";
import { type CustodyTokenRef, DAILY_SEAT_LIMIT_ERROR, type Program } from "./program.js";
import {
  ACCOUNT_EXISTS_ERROR,
  BELOW_RENT_ERROR,
  EXCHANGE_PAUSED_ERROR,
  GATE_MISSING_ERROR,
  SEAT_ALREADY_OPEN_ERROR,
  SEAT_DEPOSIT_TOO_SMALL_ERROR,
  SEAT_TABLE_FULL_ERROR,
  programErrorName,
} from "./program-errors.js";
import { checkSubmitted } from "./submitted-transaction.js";
import { DepositRefused, ProgramRefused, sendDepositAndConfirm } from "./transactions.js";

const PREPARED_FOR_MS = 45_000;

type Refusal<Status extends number> = { ok: false; status: Status; reason: string };

export type Prepared = { ok: true; transaction: string; expiresAtMs: number } | Refusal<400 | 503>;

export type Funded = { ok: true; signature: string } | Refusal<400 | 409 | 410 | 502 | 503>;

/** What the routes ask of a fund desk. */
export interface FundRequests {
  prepare(owner: string, orderKeys: string[]): Promise<Prepared>;
  submit(owner: string, transactionBase64: string): Promise<Funded>;
}

export interface FundDeskOptions {
  program: Program;
  /** The faucet's connection, opened again after a failure on the wire. */
  session: Session;
  gate: Keypair;
  faucet: Keypair;
  /** The collateral token the grant is paid in. */
  token: CustodyTokenRef;
  amountAtoms: bigint;
  clock: Clock;
  onError(what: string, error: unknown): void;
}

interface PreparedRequest {
  message: Uint8Array;
  expiresAtMs: number;
}

const publicKeyOf = (value: string): PublicKey | null => {
  try {
    return new PublicKey(value);
  } catch {
    return null;
  }
};

const isPublicKey = (key: PublicKey | null): key is PublicKey => key !== null;

/** The causes of a refused opening that a person can be told in plain words. */
const OPENING_REFUSED_BECAUSE: Record<number, string> = {
  [EXCHANGE_PAUSED_ERROR]: "the exchange is paused",
  [SEAT_TABLE_FULL_ERROR]: "the exchange has no free seat left",
  [SEAT_DEPOSIT_TOO_SMALL_ERROR]:
    "the deposit is below what the exchange asks for the first deposit of an account",
  [GATE_MISSING_ERROR]: "the exchange does not list this gate",
  [BELOW_RENT_ERROR]: "the payment for the new account is below the rent it needs",
};

export const refusalOf = (error: unknown): Refusal<409 | 502 | 503> => {
  if (error instanceof ProgramRefused && error.code === DAILY_SEAT_LIMIT_ERROR) {
    return {
      ok: false,
      status: 503,
      reason: "daily limit reached: no more new accounts can be opened today, try again tomorrow",
    };
  }
  if (
    error instanceof ProgramRefused &&
    (error.code === SEAT_ALREADY_OPEN_ERROR || error.code === ACCOUNT_EXISTS_ERROR)
  ) {
    return {
      ok: false,
      status: 409,
      reason: "the account was not opened: it exists already. Nothing changed",
    };
  }
  if (error instanceof ProgramRefused) {
    const cause = error.code === null ? undefined : OPENING_REFUSED_BECAUSE[error.code];
    const named = error.code === null ? "unnamed program error" : programErrorName(error.code);
    return {
      ok: false,
      status: 503,
      reason: cause
        ? `${cause}: no account can be opened right now. Nothing was opened.`
        : `the exchange refused the opening: ${named}. Nothing was opened.`,
    };
  }
  return {
    ok: false,
    status: 502,
    reason: error instanceof DepositRefused ? error.message : "the rollup did not confirm in time",
  };
};

/**
 * Opens and funds a new user's account in one transaction, in two steps.
 *
 * `prepare` builds the transaction: open a seat for the user's owner key and
 * four order keys, and deposit the grant from the faucet to that owner.
 * `submit` takes it back with the user's signature, checks it is the very
 * transaction that was built, adds the gate's and the faucet's signatures
 * and sends it. The account is opened and funded together or not at all.
 */
export class FundDesk implements FundRequests {
  private readonly prepared = new Map<string, PreparedRequest>();

  constructor(private readonly options: FundDeskOptions) {}

  private forgetExpired(nowMs: number): void {
    for (const [owner, request] of this.prepared) {
      if (request.expiresAtMs <= nowMs) this.prepared.delete(owner);
    }
  }

  async prepare(owner: string, orderKeys: string[]): Promise<Prepared> {
    const { program, session, gate, faucet, token, amountAtoms, clock } = this.options;
    const ownerKey = publicKeyOf(owner);
    const keys = orderKeys.map(publicKeyOf).filter(isPublicKey);
    if (!ownerKey || keys.length !== orderKeys.length) {
      return { ok: false, status: 400, reason: "not a public key" };
    }
    if (new Set([owner, ...orderKeys]).size !== orderKeys.length + 1) {
      return {
        ok: false,
        status: 400,
        reason: "the order keys must differ from each other and from the owner",
      };
    }
    const now = clock.nowMs();
    this.forgetExpired(now);
    const transaction = await session.use((connection) =>
      program.openAndFundTransaction(connection, {
        gate: gate.publicKey,
        faucet: faucet.publicKey,
        owner: ownerKey,
        orderKeys: keys,
        token,
        amount: amountAtoms,
      }),
    );
    const expiresAtMs = now + PREPARED_FOR_MS;
    this.prepared.set(owner, { message: transaction.serializeMessage(), expiresAtMs });
    return {
      ok: true,
      transaction: transaction
        .serialize({ requireAllSignatures: false, verifySignatures: false })
        .toString("base64"),
      expiresAtMs,
    };
  }

  async submit(owner: string, transactionBase64: string): Promise<Funded> {
    const { session, gate, faucet, clock, onError } = this.options;
    const request = this.prepared.get(owner);
    if (!request || request.expiresAtMs <= clock.nowMs()) {
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
    checked.transaction.partialSign(gate, faucet);
    try {
      const signature = await session.use((connection) =>
        sendDepositAndConfirm(connection, checked.transaction),
      );
      return { ok: true, signature };
    } catch (error) {
      onError("opening and funding a user failed", error);
      return refusalOf(error);
    }
  }
}
