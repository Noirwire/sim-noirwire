import { type Keypair, PublicKey, type Transaction } from "@solana/web3.js";
import type { Clock } from "../engine/clock.js";
import type { Admission } from "../gate/admission.js";
import type { Session } from "./connections.js";
import { refusalOf } from "./fund-desk.js";
import type { ChainExchange } from "./chain-types.js";
import type { Program } from "./program.js";
import { ACCOUNT_EXISTS_ERROR, SEAT_ALREADY_OPEN_ERROR } from "./program-errors.js";
import { checkSubmitted } from "./submitted-transaction.js";
import { DepositRefused, ProgramRefused, sendDepositAndConfirm } from "./transactions.js";

const PREPARED_FOR_MS = 45_000;

type Refusal<Status extends number> = { ok: false; status: Status; reason: string };

export type OpenPrepared =
  { ok: true; transaction: string; expiresAtMs: number } | Refusal<400 | 403 | 409 | 429 | 503>;

export type Opened =
  { ok: true; signature: string } | Refusal<400 | 403 | 409 | 410 | 429 | 502 | 503>;

/** What a request to open an account carries, with the address it came from. */
export interface OpenRequest {
  owner: string;
  orderKeys: string[];
  /** The invite code, when the person was given one. */
  invite?: string;
  ip: string;
}

/** What the routes ask of an open desk. */
export interface OpenRequests {
  prepare(request: OpenRequest): Promise<OpenPrepared>;
  submit(owner: string, transactionBase64: string, ip: string): Promise<Opened>;
}

export interface OpenDeskOptions {
  program: Program;
  /** The gate's connection, opened again after a failure on the wire. */
  session: Session;
  gate: Keypair;
  admission: Admission;
  /** The exchange as last read from the chain, or null before the first read. */
  exchange(): ChainExchange | null;
  clock: Clock;
  /** One line per decision, with the owner's public key and nothing else about the person. */
  log(line: string): void;
  onError(what: string, error: unknown): void;
}

interface PreparedRequest {
  message: Uint8Array;
  invite: string | undefined;
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

/** The gate signed this transaction at prepare: its signature must be on it still, and every signature on it must verify. */
const hasValidGateSignature = (transaction: Transaction, gate: PublicKey): boolean =>
  transaction.signatures.some((entry) => entry.publicKey.equals(gate) && entry.signature) &&
  transaction.verifySignatures(true);

/** The program answered that the owner's seat or account is there already. */
const accountIsThere = (error: unknown): boolean =>
  error instanceof ProgramRefused &&
  (error.code === SEAT_ALREADY_OPEN_ERROR || error.code === ACCOUNT_EXISTS_ERROR);

/**
 * Opens a new user's account on mainnet, in two steps, for invited people only.
 *
 * `prepare` asks the admission rules first and, if they say yes, builds one
 * transaction that opens a seat for the user's owner key and four order keys,
 * and signs it with the gate's key. It is signed here, and not in `submit`,
 * because wallets add their own instructions only to a transaction that
 * carries no signature yet, and the terminal refuses a changed message.
 * `submit` takes the transaction back with the owner's signature, checks that
 * the message is byte for byte the prepared one and that every signature on it,
 * the gate's included, is valid, asks the admission rules again, writes the
 * seat down, and only then sends it. The user deposits in a transaction of
 * their own. Every decision is logged with the owner's public key alone.
 *
 * Because the gate has signed at `prepare`, whoever holds the transaction and
 * the owner's signature could send it to the rollup without calling `submit`.
 * That can only open a seat for this same invited owner, for at most the
 * validity of its blockhash, and the program's own daily seat limit still
 * counts it. The gate's seat record and per-address counts would not see it.
 */
export class OpenDesk implements OpenRequests {
  private readonly prepared = new Map<string, PreparedRequest>();

  constructor(private readonly options: OpenDeskOptions) {}

  private forgetExpired(nowMs: number): void {
    for (const [owner, request] of this.prepared) {
      if (request.expiresAtMs <= nowMs) this.prepared.delete(owner);
    }
  }

  private programSeatsPerDay(): number | null {
    return this.options.exchange()?.maxSeatsPerDay ?? null;
  }

  async prepare(request: OpenRequest): Promise<OpenPrepared> {
    const { program, session, gate, admission, clock, log } = this.options;
    const { owner, orderKeys, invite, ip } = request;
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
    const decision = admission.check(owner, invite, ip, this.programSeatsPerDay());
    if (!decision.ok) {
      log(`gate: ${owner} prepare refused: ${decision.reason}`);
      return decision;
    }
    log(`gate: ${owner} prepare admitted`);

    const now = clock.nowMs();
    this.forgetExpired(now);
    const transaction = await session.use((connection) =>
      program.openTransaction(connection, {
        gate: gate.publicKey,
        owner: ownerKey,
        orderKeys: keys,
      }),
    );
    transaction.partialSign(gate);
    const expiresAtMs = now + PREPARED_FOR_MS;
    this.prepared.set(owner, { message: transaction.serializeMessage(), invite, expiresAtMs });
    return {
      ok: true,
      transaction: transaction
        .serialize({ requireAllSignatures: false, verifySignatures: false })
        .toString("base64"),
      expiresAtMs,
    };
  }

  async submit(owner: string, transactionBase64: string, ip: string): Promise<Opened> {
    const { session, gate, admission, clock, log, onError } = this.options;
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
    if (!checked.ok) {
      log(`gate: ${owner} submit refused: ${checked.reason}`);
      return { ok: false, status: 400, reason: checked.reason };
    }
    if (!hasValidGateSignature(checked.transaction, gate.publicKey)) {
      log(`gate: ${owner} submit refused: the gate's signature is missing or does not match`);
      return {
        ok: false,
        status: 400,
        reason: "the gate's signature is missing or does not match: prepare again",
      };
    }

    const decision = await admission.admit(owner, request.invite, ip, this.programSeatsPerDay());
    if (!decision.ok) {
      log(`gate: ${owner} submit refused: ${decision.reason}`);
      return decision;
    }
    log(`gate: ${owner} submit admitted, sending`);

    this.prepared.delete(owner);
    try {
      const signature = await session.use((connection) =>
        sendDepositAndConfirm(connection, checked.transaction),
      );
      await this.settle(() => admission.confirm(decision.invite));
      log(`gate: ${owner} account opened`);
      return { ok: true, signature };
    } catch (error) {
      onError("opening a user's account failed", error);
      // Refused at the door or by the program: it did not open. Anything else may have.
      const notOpened = error instanceof DepositRefused || error instanceof ProgramRefused;
      // An answer that the account is there, after a try that was never confirmed, means that try worked.
      const openedBefore = decision.afterUnconfirmed && accountIsThere(error);
      if (openedBefore) await this.settle(() => admission.confirm(decision.invite));
      else if (notOpened) await this.settle(() => admission.release(decision.invite));
      const refusal = refusalOf(error);
      log(
        `gate: ${owner} account ${
          openedBefore
            ? "was opened by an earlier try, now recorded"
            : notOpened
              ? "not opened"
              : "may or may not be open"
        }: ${refusal.reason}`,
      );
      return notOpened
        ? refusal
        : {
            ok: false,
            status: 502,
            reason:
              "the rollup did not confirm in time. The account may have been opened: check before you try again",
          };
    }
  }

  /** The seat record is already right in memory: a failure to save it is for the operator, not the user. */
  private async settle(write: () => Promise<void>): Promise<void> {
    try {
      await write();
    } catch (error) {
      this.options.onError("saving the gate's seat record", error);
    }
  }
}
