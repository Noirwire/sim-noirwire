import { type Keypair, PublicKey, type Transaction } from "@solana/web3.js";
import type { Clock } from "../engine/clock.js";
import { base58Of } from "./base58.js";
import { type Admission, RECORD_NOT_WRITTEN } from "../gate/admission.js";
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
  /** The gate-signed transaction as handed out, base64. */
  transaction: string;
  orderKeys: string;
  invite: string | undefined;
  /** The invite's id in the seat record, where this transaction's seat is reserved. */
  reservation: string;
  /** An earlier try for this invite was sent and never confirmed, so its account may exist. */
  afterUnconfirmed: boolean;
  expiresAtMs: number;
  /** A submit is sending it now. */
  sending: boolean;
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
 * `prepare` asks the admission rules and writes the seat down in the seat
 * record, and only if both say yes builds one transaction that opens a seat
 * for the user's owner key and four order keys and signs it with the gate's
 * key. It is signed here, and not in `submit`, because wallets add their own
 * instructions only to a transaction that carries no signature yet, and the
 * terminal refuses a changed message. Since a gate-signed transaction could be
 * sent to the rollup without calling `submit`, no signature leaves this class
 * before its seat is on record, so the day's and the address's limits and the
 * invite's single use hold either way. A second `prepare` for an owner who
 * holds a reservation reuses it, since the program opens one seat per owner:
 * the same transaction comes back while it is valid for the same order keys,
 * and a fresh one for the same keys replaces it once it has expired. For other
 * order keys nothing is signed until the earlier transactions can no longer
 * land (the chain's block height is past their last valid one), because one of
 * them could still open the account with its own keys; until then the answer
 * is a 409, also when the block height cannot be read.
 *
 * `submit` takes the transaction back with the owner's signature, checks that
 * the message is byte for byte the prepared one and that every signature on it,
 * the gate's included, is valid, asks the invite list and limits again, and
 * sends it, once: a second submit while it is being sent is refused. The seat
 * is confirmed when the rollup executes it. A refusal frees nothing at once,
 * whether at the door (whoever holds the signed bytes can still send them) or
 * by the program (a failure seen at confirmed can be on an abandoned fork).
 * Those, and a transaction that is never submitted, may still land until
 * its blockhash expires; afterwards the chain is asked for its signatures:
 * executed at confirmed or finalized means the seat is confirmed; every
 * signature not found, or failed at finalized, means it is freed. Anything else
 * (processed, a failure only at confirmed, a chain that cannot be read) keeps
 * the seat reserved until the next sweep. The signatures and the last valid block
 * height are written in the seat record when the transaction is handed out, so
 * this also settles seats after a restart. Prepares and the sweep run one at a
 * time, so no decision is made on a count another is about to change. The user
 * deposits in a transaction of their own. Every decision is logged with the
 * owner's public key alone.
 */
export class OpenDesk implements OpenRequests {
  private readonly prepared = new Map<string, PreparedRequest>();
  private lock: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: OpenDeskOptions) {}

  private programSeatsPerDay(): number | null {
    return this.options.exchange()?.maxSeatsPerDay ?? null;
  }

  async prepare(request: OpenRequest): Promise<OpenPrepared> {
    const { owner, orderKeys } = request;
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
    return this.locked(() => this.prepareLocked(request, ownerKey, keys));
  }

  /** One at a time, so that no decision is made on a count another prepare is about to change. */
  private locked<T>(work: () => Promise<T>): Promise<T> {
    const result = this.lock.then(work);
    this.lock = result.catch(() => {});
    return result;
  }

  private async prepareLocked(
    request: OpenRequest,
    ownerKey: PublicKey,
    keys: PublicKey[],
  ): Promise<OpenPrepared> {
    const { program, session, gate, admission, clock, log } = this.options;
    const { owner, orderKeys, invite, ip } = request;
    const now = clock.nowMs();
    await this.settleExpired(now, owner);
    const outstanding = this.prepared.get(owner);
    const asked = admission.check(owner, invite, ip, this.programSeatsPerDay());
    if (!asked.ok) {
      log(`gate: ${owner} prepare refused: ${asked.reason}`);
      return asked;
    }
    if (
      outstanding &&
      !outstanding.sending &&
      outstanding.expiresAtMs > now &&
      outstanding.orderKeys === orderKeys.join(",")
    ) {
      log(`gate: ${owner} prepare repeated, same transaction`);
      return {
        ok: true,
        transaction: outstanding.transaction,
        expiresAtMs: outstanding.expiresAtMs,
      };
    }

    // Other order keys than an earlier transaction that can still land: that one could open the
    // account with its own keys, so the new one waits until the earlier ones can no longer land.
    const earlier = admission.awaitingSettlement().find((seat) => seat.invite === asked.invite);
    if (earlier && outstanding?.orderKeys !== orderKeys.join(",")) {
      const lastValid = earlier.lastValidBlockHeight ?? 0;
      const past = await session
        .use((connection) => connection.getBlockHeight("confirmed"))
        .then((height) => height > lastValid)
        .catch(() => false);
      if (!past) {
        log(
          `gate: ${owner} prepare refused: an earlier opening with other order keys can still land`,
        );
        return {
          ok: false,
          status: 409,
          reason:
            "an earlier account opening for this wallet can still land: try again in about a minute",
        };
      }
    }

    // The program opens one seat per owner, so a new transaction for an owner who
    // holds a reservation cannot widen any limit: the reservation is reused.
    const decision = outstanding
      ? { ...asked, afterUnconfirmed: true }
      : await admission.admit(owner, invite, ip, this.programSeatsPerDay());
    if (!decision.ok) {
      log(`gate: ${owner} prepare refused: ${decision.reason}`);
      return decision;
    }
    log(`gate: ${owner} prepare admitted`);

    let transaction: Transaction;
    try {
      transaction = await session.use((connection) =>
        program.openTransaction(connection, {
          gate: gate.publicKey,
          owner: ownerKey,
          orderKeys: keys,
        }),
      );
    } catch (error) {
      // Nothing was signed, so nothing can have opened, unless an earlier try for this invite did.
      if (!outstanding && !decision.afterUnconfirmed)
        await this.settle(() => admission.release(decision.invite));
      throw error;
    }
    transaction.partialSign(gate);
    const gateSignature = transaction.signatures.find((entry) =>
      entry.publicKey.equals(gate.publicKey),
    );
    const expiresAtMs = now + PREPARED_FOR_MS;
    const wire = transaction
      .serialize({ requireAllSignatures: false, verifySignatures: false })
      .toString("base64");
    const written = await admission.track(
      decision.invite,
      base58Of(gateSignature?.signature ?? new Uint8Array(64)),
      transaction.lastValidBlockHeight ?? 0,
    );
    if (!written) {
      if (!outstanding && !decision.afterUnconfirmed) {
        await this.settle(() => admission.release(decision.invite));
      }
      log(`gate: ${owner} prepare refused: the seat record could not be written`);
      return RECORD_NOT_WRITTEN;
    }
    this.prepared.set(owner, {
      message: transaction.serializeMessage(),
      transaction: wire,
      orderKeys: orderKeys.join(","),
      invite,
      reservation: decision.invite,
      afterUnconfirmed: decision.afterUnconfirmed,
      expiresAtMs,
      sending: false,
    });
    return { ok: true, transaction: wire, expiresAtMs };
  }

  /**
   * A prepared transaction that was not submitted in time may still land
   * until its blockhash expires, so its reservation stays until then. After
   * that the chain says whether it landed: confirmed if so, released if not.
   * When the chain cannot be read, the reservation is kept and the operator
   * is told, so the quotas stay safe. A failure here only ever keeps that one
   * owner's seat reserved; it never blocks the owner from preparing again,
   * because a new transaction for an owner reuses the reservation, and the
   * program opens one seat per owner. The owner asking is not swept.
   */
  private async settleExpired(nowMs: number, except: string): Promise<void> {
    const { session, admission, log, onError } = this.options;
    for (const seat of [...admission.awaitingSettlement()]) {
      const { owner, invite: reservation } = seat;
      const request = this.prepared.get(owner);
      if (owner === except || request?.sending || (request && request.expiresAtMs > nowMs)) {
        continue;
      }
      const signatures = [...(seat.signatures ?? [])];
      const lastValid = seat.lastValidBlockHeight ?? 0;
      try {
        const landed = await session.use(async (connection) => {
          const height = await connection.getBlockHeight("confirmed");
          if (height <= lastValid) return null;
          let unresolved = false;
          for (const signature of signatures) {
            const { value } = await connection.getSignatureStatus(signature, {
              searchTransactionHistory: true,
            });
            if (value === null) continue;
            const { confirmationStatus: level, err } = value;
            if (!err && (level === "confirmed" || level === "finalized")) return true;
            // Failed for good only at finalized. Processed, or failed at confirmed, can still be undone.
            if (!(err && level === "finalized")) unresolved = true;
          }
          return unresolved ? null : false;
        });
        if (landed === null) continue;
        // Something moved while the chain was asked: a newer transaction, a send, or a settled seat.
        const current = this.prepared.get(owner);
        const unchanged =
          current === request &&
          !current?.sending &&
          admission
            .awaitingSettlement()
            .some(
              (entry) =>
                entry.invite === reservation && entry.signatures?.length === signatures.length,
            );
        if (!unchanged) continue;
        this.prepared.delete(owner);
        if (landed) await this.settle(() => admission.confirm(reservation));
        else await this.settle(() => admission.release(reservation));
        log(
          `gate: ${owner} unsubmitted transaction ${landed ? "had landed, recorded" : "never landed, freed"}`,
        );
      } catch (error) {
        onError("settling an unsubmitted account opening failed, its seat stays reserved", error);
      }
    }
  }

  async submit(owner: string, transactionBase64: string, ip: string): Promise<Opened> {
    const { session, gate, admission, clock, log, onError } = this.options;
    const request = this.prepared.get(owner);
    if (!request || request.expiresAtMs <= clock.nowMs()) {
      return {
        ok: false,
        status: 410,
        reason: "nothing is prepared for this owner: prepare again",
      };
    }
    if (request.sending) {
      return {
        ok: false,
        status: 409,
        reason: "this account opening is already being sent, wait for it",
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

    const decision = admission.check(owner, request.invite, ip, this.programSeatsPerDay());
    if (!decision.ok) {
      log(`gate: ${owner} submit refused: ${decision.reason}`);
      return decision;
    }
    log(`gate: ${owner} submit admitted, sending`);

    request.sending = true;
    try {
      const signature = await session.use((connection) =>
        sendDepositAndConfirm(connection, checked.transaction),
      );
      if (this.prepared.get(owner) === request) this.prepared.delete(owner);
      // The account is open whichever transaction opened it, so the seat is confirmed.
      await this.settle(() => admission.confirm(request.reservation));
      log(`gate: ${owner} account opened`);
      return { ok: true, signature };
    } catch (error) {
      onError("opening a user's account failed", error);
      // A refusal proves nothing final: at the door, whoever holds the signed bytes can still send them, and a
      // failure seen at confirmed can still be on an abandoned fork. Only the sweep frees the seat.
      const programRefused = error instanceof ProgramRefused;
      const doorRefused = error instanceof DepositRefused;
      // An answer that the account is there, after a try that was never confirmed, means that try worked.
      const openedBefore = request.afterUnconfirmed && accountIsThere(error);
      // A newer transaction for this owner depends on the same reservation: a refusal of this older one must not free it.
      const replaced = this.prepared.get(owner) !== request;
      if (!replaced) {
        if (openedBefore) this.prepared.delete(owner);
        else {
          request.sending = false;
          request.afterUnconfirmed = true;
        }
      }
      if (openedBefore) await this.settle(() => admission.confirm(request.reservation));
      const refusal = refusalOf(error);
      log(
        `gate: ${owner} account ${
          openedBefore
            ? "was opened by an earlier try, now recorded"
            : programRefused || doorRefused
              ? "refused, its seat stays reserved until it can no longer land"
              : "may or may not be open"
        }: ${refusal.reason}`,
      );
      return programRefused || doorRefused
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
