import { type PublicKey, Transaction } from "@solana/web3.js";

export type SubmittedTransaction =
  { ok: true; transaction: Transaction } | { ok: false; reason: string };

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((byte, at) => byte === b[at]);

/**
 * Checks what a user sent back against the transaction this service built
 * for them. The gate and the faucet sign only when the message is, byte for
 * byte, the one that was prepared, and the owner's own signature over it is
 * valid. Anything else is refused before a key of ours touches it.
 */
export const checkSubmitted = (
  preparedMessage: Uint8Array,
  submitted: Uint8Array,
  owner: PublicKey,
): SubmittedTransaction => {
  let transaction: Transaction;
  let message: Uint8Array;
  try {
    transaction = Transaction.from(submitted);
    message = transaction.serializeMessage();
  } catch {
    return { ok: false, reason: "not a transaction" };
  }
  if (!sameBytes(message, preparedMessage)) {
    return { ok: false, reason: "not the transaction that was prepared" };
  }
  const ownerSignature = transaction.signatures.find((entry) => entry.publicKey.equals(owner));
  if (!ownerSignature?.signature) {
    return { ok: false, reason: "the owner has not signed" };
  }
  if (!transaction.verifySignatures(false)) {
    return { ok: false, reason: "a signature does not match" };
  }
  return { ok: true, transaction };
};
