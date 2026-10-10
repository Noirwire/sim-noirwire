import { type Keypair, PublicKey } from "@solana/web3.js";
import type { Clock } from "../engine/clock.js";
import { checkSubmitted } from "./open-request.js";
import {
  DAILY_SEAT_LIMIT_ERROR,
  DepositRefused,
  type Program,
  ProgramRefused,
  type Session,
  sendDepositAndConfirm,
} from "./program.js";

const PREPARED_FOR_MS = 45_000;

export type Prepared =
  | { ok: true; transaction: string; expiresAtMs: number }
  | { ok: false; status: 400; reason: string };

export type Funded =
  | { ok: true; signature: string }
  | { ok: false; status: 400 | 409 | 410 | 502 | 503; reason: string };

export interface FundingDeskOptions {
  program: Program;
  /** The faucet's signed-in connection, renewed after a failure on the wire. */
  session: Session;
  gate: Keypair;
  faucet: Keypair;
  mint: string;
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

/**
 * Opens and funds a new user's account in one transaction, in two steps.
 *
 * `prepare` builds the transaction: open a seat for the user's owner key and
 * four order keys, and deposit the grant from the faucet to that owner.
 * `submit` takes it back with the user's signature, checks it is the very
 * transaction that was built, adds the gate's and the faucet's signatures
 * and sends it. The account is opened and funded together or not at all.
 */
export class FundingDesk {
  private readonly prepared = new Map<string, PreparedRequest>();

  constructor(private readonly options: FundingDeskOptions) {}

  async prepare(owner: string, orderKeys: string[]): Promise<Prepared> {
    const ownerKey = publicKeyOf(owner);
    const keys = orderKeys.map(publicKeyOf);
    if (!ownerKey || keys.some((key) => key === null)) {
      return { ok: false, status: 400, reason: "not a public key" };
    }
    if (new Set([owner, ...orderKeys]).size !== orderKeys.length + 1) {
      return {
        ok: false,
        status: 400,
        reason: "the order keys must differ from each other and from the owner",
      };
    }
    const now = this.options.clock.nowMs();
    for (const [other, request] of this.prepared) {
      if (request.expiresAtMs <= now) this.prepared.delete(other);
    }
    const transaction = await this.options.session.use((connection) =>
      this.options.program.openAndFundTransaction(connection, {
        gate: this.options.gate.publicKey,
        faucet: this.options.faucet.publicKey,
        owner: ownerKey,
        orderKeys: keys as PublicKey[],
        mint: this.options.mint,
        amount: this.options.amountAtoms,
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
      const signature = await this.options.session.use((connection) =>
        sendDepositAndConfirm(connection, checked.transaction),
      );
      return { ok: true, signature };
    } catch (error) {
      this.options.onError("opening and funding a user failed", error);
      if (error instanceof ProgramRefused && error.code === DAILY_SEAT_LIMIT_ERROR) {
        return {
          ok: false,
          status: 503,
          reason:
            "daily limit reached: no more new accounts can be opened today, try again tomorrow",
        };
      }
      if (error instanceof ProgramRefused) {
        return {
          ok: false,
          status: 409,
          reason: "the account was not opened: it exists already. Nothing changed",
        };
      }
      const reason =
        error instanceof DepositRefused ? error.message : "the rollup did not confirm in time";
      return { ok: false, status: 502, reason };
    }
  }
}
