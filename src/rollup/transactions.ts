import {
  type Connection,
  type Keypair,
  Transaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import { within } from "./timeouts.js";

const DEPOSIT_CONFIRM_TIMEOUT_MS = 30_000;
const CONFIRM_POLL_MS = 100;

const firstLine = (error: unknown): string =>
  error instanceof Error ? error.message.split("\n")[0] : String(error);

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
  while (Date.now() < deadline) {
    const { value } = await connection.getSignatureStatus(signature);
    if (value && value.confirmationStatus !== "processed") {
      if (value.err) throw new ProgramRefused(value.err);
      return signature;
    }
    await new Promise((resolve) => setTimeout(resolve, CONFIRM_POLL_MS));
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

/** Signs, sends and confirms one instruction paid by `payer`, all inside `timeoutMs`. */
export const sendInstructionWithin = (
  connection: Connection,
  instruction: TransactionInstruction,
  payer: Keypair,
  timeoutMs: number,
): Promise<string> =>
  within(
    (async () => {
      const latest = await connection.getLatestBlockhash("confirmed");
      const transaction = new Transaction({ feePayer: payer.publicKey, ...latest }).add(
        instruction,
      );
      transaction.sign(payer);
      // The private endpoint refuses to simulate what it would refuse to send.
      const signature = await connection.sendRawTransaction(transaction.serialize(), {
        skipPreflight: true,
      });
      return confirmedWithin(connection, signature, timeoutMs);
    })(),
    timeoutMs,
    "the transaction",
  );
