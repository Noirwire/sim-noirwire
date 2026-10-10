import { type Keypair, Transaction } from "@solana/web3.js";
import { firstOrderKeys } from "../src/rollup/program.js";

/** The body of `POST /v1/fund/prepare` for a new owner key. */
export const prepareRequest = (owner: Keypair) => ({
  owner: owner.publicKey.toBase58(),
  orderKeys: firstOrderKeys(owner).map((key) => key.toBase58()),
});

/** The body of `POST /v1/fund/submit`: the prepared transaction, signed by its owner as a wallet would. */
export const submitRequest = (owner: Keypair, preparedTransaction: string) => {
  const transaction = Transaction.from(Buffer.from(preparedTransaction, "base64"));
  transaction.partialSign(owner);
  return {
    owner: owner.publicKey.toBase58(),
    transaction: transaction
      .serialize({ requireAllSignatures: false, verifySignatures: false })
      .toString("base64"),
  };
};
