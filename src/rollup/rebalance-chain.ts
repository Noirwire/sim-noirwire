import {
  type Connection,
  type Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { associatedTokenAddress } from "@noirwire/orderbook";
import { StepRefused } from "../rebalance/out-flow.js";
import type { RebalanceChain, SeatReading } from "../rebalance/rebalancer.js";
import { Session, connectionTo } from "./connections.js";
import { type CustodyTokenRef, type Program, signedInConnection } from "./program.js";
import { DepositRefused, ProgramRefused } from "./transactions.js";

const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TRANSFER_CHECKED = 12;

export interface RebalanceChainOptions {
  program: Program;
  rollupRpcUrl: string;
  solanaRpcUrl: string;
  owner: Keypair;
  token: CustodyTokenRef & { decimals: number };
  bridgeAta: string;
  validator: string;
  /** The seat as the margin rules count it, with the requirement the bands are measured against. */
  readSeat(): Promise<SeatReading | null>;
  /** The markets the seat holds something on, for the withdrawal's margin check. */
  riskMarkets(): number[];
}

const atomsOf = async (connection: Connection, account: PublicKey): Promise<bigint> => {
  try {
    return BigInt((await connection.getTokenAccountBalance(account)).value.amount);
  } catch (error) {
    if (/could not find account|invalid param/i.test(String(error))) return 0n;
    throw error;
  }
};

const transferChecked = (
  source: PublicKey,
  mint: PublicKey,
  destination: PublicKey,
  owner: PublicKey,
  amount: bigint,
  decimals: number,
): TransactionInstruction => {
  const data = Buffer.alloc(10);
  data.writeUInt8(TRANSFER_CHECKED, 0);
  data.writeBigUInt64LE(amount, 1);
  data.writeUInt8(decimals, 9);
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM,
    keys: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data,
  });
};

const sendOnSolana = async (
  connection: Connection,
  owner: Keypair,
  instructions: TransactionInstruction[],
): Promise<string> => {
  const latest = await connection.getLatestBlockhash("confirmed");
  const transaction = new Transaction({ feePayer: owner.publicKey, ...latest }).add(
    ...instructions,
  );
  transaction.sign(owner);
  const signature = await connection.sendRawTransaction(transaction.serialize());
  const confirmed = await connection.confirmTransaction({ signature, ...latest }, "confirmed");
  if (confirmed.value.err) throw new StepRefused("Solana refused the transaction");
  return signature;
};

/**
 * The maker's chain side of a transfer out, on the live networks. The owner key signs every step;
 * the bridge's account is the one configured, never one a request names.
 */
export const rebalanceChain = (options: RebalanceChainOptions): RebalanceChain => {
  const { program, owner, token } = options;
  const mint = new PublicKey(token.mint);
  const ownerAccount = associatedTokenAddress(owner.publicKey, mint);
  const bridgeAccount = new PublicKey(options.bridgeAta);
  const solana = connectionTo(options.solanaRpcUrl);
  const rollup = new Session(() => signedInConnection(options.rollupRpcUrl, owner));
  const refusedOrFailed = (error: unknown): never => {
    if (error instanceof ProgramRefused || error instanceof DepositRefused) {
      throw new StepRefused(error.message);
    }
    throw error;
  };

  return {
    read: () => options.readSeat(),
    rollupBalance: () =>
      rollup.use((connection) =>
        atomsOf(connection, program.ownerTokenAccount(owner.publicKey, token)),
      ),
    solanaBalance: () => atomsOf(solana, ownerAccount),
    withdrawFromBook: (amount) =>
      rollup
        .use((connection) =>
          program.withdrawCollateral(connection, owner, token, amount, options.riskMarkets()),
        )
        .catch(refusedOrFailed),
    shuttleToSolana: async (amount) => {
      const { withdrawSpl } = await import("@magicblock-labs/ephemeral-rollups-sdk");
      const instructions = await withdrawSpl(owner.publicKey, mint, amount, {
        validator: new PublicKey(options.validator),
        payer: owner.publicKey,
        initAtasIfMissing: true,
      });
      return sendOnSolana(solana, owner, instructions);
    },
    shuttleToRollup: async (amount) => {
      const { delegateSpl } = await import("@magicblock-labs/ephemeral-rollups-sdk");
      const instructions = await delegateSpl(owner.publicKey, mint, amount, {
        validator: new PublicKey(options.validator),
        payer: owner.publicKey,
        initIfMissing: true,
        initVaultIfMissing: true,
        initAtasIfMissing: true,
      });
      return sendOnSolana(solana, owner, instructions);
    },
    depositToBook: (amount) =>
      rollup
        .use((connection) =>
          program.deposit(
            connection,
            owner,
            token,
            owner.publicKey.toBase58(),
            "collateral",
            amount,
          ),
        )
        .catch(refusedOrFailed),
    transferToBridge: (amount) =>
      sendOnSolana(solana, owner, [
        transferChecked(ownerAccount, mint, bridgeAccount, owner.publicKey, amount, token.decimals),
      ]),
  };
};
