import {
  type Connection,
  type Keypair,
  Transaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import { firstLine } from "../logging/first-line.js";
import { waitFor } from "../scheduling/backoff.js";
import { within } from "./timeouts.js";

const DEPOSIT_CONFIRM_TIMEOUT_MS = 30_000;
const CONFIRM_POLL_MS = 100;
/** A transaction is rarely executed the moment it is sent: the first look waits this long. */
const CONFIRM_FIRST_LOOK_AFTER_MS = 150;

/** The endpoint did not take a transaction that moves tokens: the HTTP status and body it answered with. */
export class DepositRefused extends Error {
  constructor(endpoint: string, cause: unknown) {
    // Security: the origin only. A signed-in endpoint carries its token in the query string.
    super(`${new URL(endpoint).origin} refused the deposit transaction: ${firstLine(cause)}`);
    this.name = "DepositRefused";
  }
}

/** The transaction executed and the program refused it, with the program's error number when it gave one. */
export class ProgramRefused extends Error {
  readonly code: number | null;

  constructor(err: unknown) {
    super(`the program refused the transaction: ${JSON.stringify(err)}`);
    this.name = "ProgramRefused";
    const detail = (err as { InstructionError?: [number, { Custom?: number }] } | null)
      ?.InstructionError?.[1];
    this.code = typeof detail?.Custom === "number" ? detail.Custom : null;
  }
}

/** Waits until the rollup reports `signature` executed, for `timeoutMs` at most. */
export const confirmedWithin = async (
  connection: Connection,
  signature: string,
  timeoutMs: number,
): Promise<string> => {
  const deadline = Date.now() + timeoutMs;
  await waitFor(CONFIRM_FIRST_LOOK_AFTER_MS);
  while (Date.now() < deadline) {
    const { value } = await connection.getSignatureStatus(signature);
    if (value && value.confirmationStatus !== "processed") {
      if (value.err) throw new ProgramRefused(value.err);
      return signature;
    }
    await waitFor(CONFIRM_POLL_MS);
  }
  throw new Error(`transaction ${signature} was not confirmed in ${timeoutMs} ms`);
};

/**
 * Sends a fully signed transaction that carries a deposit and waits until the
 * rollup reports it executed. A refusal at the door is a `DepositRefused`, a
 * refusal by the program a `ProgramRefused`.
 */
export const sendDepositAndConfirm = async (
  connection: Connection,
  transaction: Transaction,
): Promise<string> => {
  const signature = await connection
    .sendRawTransaction(transaction.serialize(), { skipPreflight: true })
    .catch((error: unknown) => {
      throw new DepositRefused(connection.rpcEndpoint, error);
    });
  return confirmedWithin(connection, signature, DEPOSIT_CONFIRM_TIMEOUT_MS);
};

/** A rollup blockhash stays valid for about a minute: one is reused for this long. */
const BLOCKHASH_REUSED_FOR_MS = 20_000;

type Blockhash = Awaited<ReturnType<Connection["getLatestBlockhash"]>>;
const blockhashes = new WeakMap<Connection, { latest: Blockhash; at: number }>();

/**
 * The connection's latest blockhash. With `reuse`, the one held is used again
 * until it is a while old: only for a transaction that differs from every
 * other sent with it, as a price publish does by its time.
 */
const blockhashFor = async (connection: Connection, reuse: boolean): Promise<Blockhash> => {
  const held = blockhashes.get(connection);
  if (reuse && held && Date.now() - held.at < BLOCKHASH_REUSED_FOR_MS) return held.latest;
  const latest = await connection.getLatestBlockhash("confirmed");
  blockhashes.set(connection, { latest, at: Date.now() });
  return latest;
};

/** Signs, sends and confirms instructions paid by `payer` in one transaction, all inside `timeoutMs`. */
export const sendInstructionsWithin = (
  connection: Connection,
  instructions: TransactionInstruction[],
  payer: Keypair,
  timeoutMs: number,
  reuseBlockhash = false,
): Promise<string> =>
  within(
    (async () => {
      // The confirmation loop ends when the transaction is given up, not a send later.
      const deadline = Date.now() + timeoutMs;
      const latest = await blockhashFor(connection, reuseBlockhash);
      const transaction = new Transaction({ feePayer: payer.publicKey, ...latest }).add(
        ...instructions,
      );
      transaction.sign(payer);
      // The private endpoint refuses to simulate what it would refuse to send.
      const signature = await connection.sendRawTransaction(transaction.serialize(), {
        skipPreflight: true,
      });
      return confirmedWithin(connection, signature, deadline - Date.now());
    })(),
    timeoutMs,
    "the transaction",
  );
