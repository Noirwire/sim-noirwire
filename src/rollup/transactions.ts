import type { Connection, Transaction } from "@solana/web3.js";
import { firstLine } from "../logging/first-line.js";
import { waitFor } from "../scheduling/backoff.js";

const DEPOSIT_CONFIRM_TIMEOUT_MS = 30_000;

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

/**
 * The rollup's websocket tells when a transaction executes. Only when it has said nothing for
 * this long is the transaction asked after by hand, every `FALLBACK_POLL_MS`.
 */
const SOCKET_GRACE_MS = 1_000;
const FALLBACK_POLL_MS = 500;

/** The websocket's word on `signature`: a promise that settles once, with the transaction's error or null. */
const watchSignature = (
  connection: Connection,
  signature: string,
): { executed: Promise<{ err: unknown }>; stop(): void } => {
  let subscription: number | undefined;
  const executed = new Promise<{ err: unknown }>((resolve) => {
    try {
      subscription = connection.onSignature(signature, ({ err }) => resolve({ err }), "confirmed");
    } catch {
      // No socket to ask: `executed` stays silent and the polling answers.
    }
  });
  return {
    executed,
    stop: () => {
      if (subscription === undefined) return;
      try {
        connection.removeSignatureListener(subscription).catch(() => {});
      } catch {
        // The connection is going away; its subscriptions go with it.
      }
    },
  };
};

/**
 * Waits until the rollup reports `signature` executed, for `timeoutMs` at most. The websocket
 * answers; if it has not within `SOCKET_GRACE_MS` (or cannot be opened) the status is read
 * every `FALLBACK_POLL_MS`, and once more at the deadline before the transaction is given up.
 */
export const confirmedWithin = async (
  connection: Connection,
  signature: string,
  timeoutMs: number,
): Promise<string> => {
  const deadline = Date.now() + timeoutMs;
  const verdict = (err: unknown): string => {
    if (err) throw new ProgramRefused(err);
    return signature;
  };
  const executedByRpc = async (): Promise<{ err: unknown } | null> => {
    const { value } = await connection.getSignatureStatus(signature);
    return value && value.confirmationStatus !== "processed" ? value : null;
  };
  const watch = watchSignature(connection, signature);
  try {
    let nextReadAt = Date.now() + SOCKET_GRACE_MS;
    for (;;) {
      const wakeAt = Math.min(nextReadAt, deadline);
      const pushed = await Promise.race([
        watch.executed,
        waitFor(wakeAt - Date.now()).then(() => null),
      ]);
      if (pushed) return verdict(pushed.err);
      const expiring = Date.now() >= deadline;
      if (!expiring && Date.now() < nextReadAt) continue;
      const read = await executedByRpc();
      if (read) return verdict(read.err);
      if (expiring) {
        throw new Error(`transaction ${signature} was not confirmed in ${timeoutMs} ms`);
      }
      nextReadAt = Date.now() + FALLBACK_POLL_MS;
    }
  } finally {
    watch.stop();
  }
};

/**
 * Sends a fully signed transaction that carries a deposit and waits until the
 * rollup reports it executed. A refusal at the door is a `DepositRefused`, a
 * refusal by the program a `ProgramRefused`.
 */
export const sendDepositAndConfirm = (
  connection: Connection,
  transaction: Transaction,
): Promise<string> => sendRawAndConfirm(connection, transaction.serialize());

/** As `sendDepositAndConfirm`, for a transaction already serialized with every signature on it. */
export const sendRawAndConfirm = async (connection: Connection, raw: Buffer): Promise<string> => {
  const signature = await connection
    .sendRawTransaction(raw, { skipPreflight: true })
    .catch((error: unknown) => {
      throw new DepositRefused(connection.rpcEndpoint, error);
    });
  return confirmedWithin(connection, signature, DEPOSIT_CONFIRM_TIMEOUT_MS);
};
