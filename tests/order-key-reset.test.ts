import { Keypair, PublicKey, type Connection } from "@solana/web3.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** What the stand-in chain holds: the order keys of the view, and every call that tried to change them. */
const chain = vi.hoisted(() => ({
  viewKeys: [] as unknown[],
  sent: [] as unknown[],
}));

vi.mock("@noirwire/orderbook", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@noirwire/orderbook")>();
  return {
    ...actual,
    decodeView: () => ({ orderKeys: chain.viewKeys }),
    sendAndConfirm: async (_connection: unknown, instructions: unknown[]) => {
      chain.sent.push(instructions);
    },
  };
});

import { OrderKeyManager } from "@noirwire/orderbook";
import { makerTraderKey } from "../src/bots/bot-traders.js";
import { BotAccounts } from "../src/rollup/bot-accounts.js";
import type { KeyCheckpoint } from "../src/rollup/chain-types.js";
import { Session } from "../src/rollup/connections.js";
import {
  KeyCheckpointRequired,
  Program,
  SeatNotOpen,
  firstOrderKeys,
  type GateAccess,
} from "../src/rollup/program.js";
import type { RollupSettings } from "../src/rollup/settings.js";

const MAKER = makerTraderKey("NSOL-PERP");
const PROGRAM_ID = Keypair.generate().publicKey.toBase58();
const owner = Keypair.generate();

/** A program whose owner sign-in goes to a stand-in connection: the seat exists or not, with whatever view the chain holds. */
class StandInProgram extends Program {
  seatExists = true;
  signIns = 0;

  protected override async ownerConnection(): Promise<Connection> {
    this.signIns += 1;
    return {
      getAccountInfo: async () => (this.seatExists ? { data: Buffer.alloc(8) } : null),
    } as unknown as Connection;
  }
}

const FIRST_FOUR_CHECKPOINT: KeyCheckpoint = { indices: [0, 1, 2, 3], nextIndex: 4 };

const strangerKeys = (): PublicKey[] =>
  Array.from({ length: 4 }, () => Keypair.generate().publicKey);

beforeEach(() => {
  chain.viewKeys = strangerKeys();
  chain.sent = [];
});

describe("an order key checkpoint that is missing or does not fit, with the reset refused", () => {
  it("refuses to start with no checkpoint, names the owner and the way out, and sends nothing", async () => {
    const program = new StandInProgram(PROGRAM_ID);

    const refusal = await program
      .ownTrader("http://rollup.example", owner, undefined, undefined, "refuse")
      .catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(KeyCheckpointRequired);
    const message = (refusal as Error).message;
    expect(message).toContain(owner.publicKey.toBase58());
    expect(message).toContain("no saved order key checkpoint");
    expect(message).toContain("reset-order-keys");
    expect(chain.sent).toEqual([]);
  });

  it("refuses when the saved checkpoint no longer fits the keys on chain, and says so", async () => {
    const program = new StandInProgram(PROGRAM_ID);
    const farAway: KeyCheckpoint = { indices: [90_000, 90_001, 90_002, 90_003], nextIndex: 90_004 };

    const refusal = await program
      .ownTrader("http://rollup.example", owner, farAway, undefined, "refuse")
      .catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(KeyCheckpointRequired);
    expect((refusal as Error).message).toContain("no longer fits");
    expect(chain.sent).toEqual([]);
  });

  it("starts from a checkpoint that fits, sending nothing", async () => {
    chain.viewKeys = firstOrderKeys(owner);
    const program = new StandInProgram(PROGRAM_ID);

    const trader = await program.ownTrader(
      "http://rollup.example",
      owner,
      FIRST_FOUR_CHECKPOINT,
      undefined,
      "refuse",
    );

    expect(trader).not.toBeNull();
    expect(chain.sent).toEqual([]);
    trader?.close();
  });

  it("takes a view that still holds the first four keys as it finds it, sending nothing", async () => {
    chain.viewKeys = firstOrderKeys(owner);
    const program = new StandInProgram(PROGRAM_ID);

    const trader = await program.ownTrader(
      "http://rollup.example",
      owner,
      undefined,
      undefined,
      "refuse",
    );

    expect(trader).not.toBeNull();
    expect(chain.sent).toEqual([]);
    trader?.close();
  });

  it("answers null for an owner with no seat, without refusing", async () => {
    const program = new StandInProgram(PROGRAM_ID);
    program.seatExists = false;

    expect(
      await program.ownTrader("http://rollup.example", owner, undefined, undefined, "refuse"),
    ).toBeNull();
  });

  it("is what a bot's account does on the refusing setting, and a start that would reset replaces the keys as before", async () => {
    const program = new StandInProgram(PROGRAM_ID);

    await expect(
      program.ownTrader("http://rollup.example", owner, undefined, undefined, "replace"),
    ).resolves.not.toBeNull();
    expect(chain.sent).toHaveLength(1);
  });
});

describe("the explicit reset of the order keys", () => {
  it("replaces all four keys once and says where they now stand", async () => {
    const program = new StandInProgram(PROGRAM_ID);

    const checkpoint = await program.resetOrderKeys("http://rollup.example", owner);

    expect(chain.sent).toHaveLength(1);
    expect(checkpoint).toEqual(
      OrderKeyManager.fresh(Uint8Array.from(Array(32).fill(0))).checkpoint,
    );
  });

  it("does nothing for an owner with no seat", async () => {
    const program = new StandInProgram(PROGRAM_ID);
    program.seatExists = false;

    expect(await program.resetOrderKeys("http://rollup.example", owner)).toBeNull();
    expect(chain.sent).toEqual([]);
  });
});

describe("a bot's seat with no gate key in the process", () => {
  const settings = (gate: Keypair | null) =>
    ({
      rollupRpcUrl: "http://rollup.example",
      gate,
      faucet: null,
      deployment: { tokens: [] },
    }) as unknown as RollupSettings;
  const accounts = (program: Program, gate: Session | null, gateKey: Keypair | null) =>
    new BotAccounts({
      program,
      settings: settings(gateKey),
      bots: [{ key: MAKER, owner, tradesPerps: true, tradesSpot: false }],
      gate,
      faucet: null,
      keyCheckpoints: {},
      keyReset: "refuse",
      syncMarketId: 0,
      life: () => undefined,
    });

  it("finds an open seat without ever signing the gate in", async () => {
    chain.viewKeys = firstOrderKeys(owner);
    const program = new StandInProgram(PROGRAM_ID);
    const gate = new Session(() => Promise.reject(new Error("the gate must not be signed in")));
    const use = vi.spyOn(gate, "use");

    const trader = await accounts(program, gate, Keypair.generate()).trader(MAKER);

    expect(trader).toBeDefined();
    expect(use).not.toHaveBeenCalled();
    trader.close();
  });

  it("finds an open seat with no gate at all", async () => {
    chain.viewKeys = firstOrderKeys(owner);
    const program = new StandInProgram(PROGRAM_ID);

    const trader = await accounts(program, null, null).trader(MAKER);

    expect(trader).toBeDefined();
    trader.close();
  });

  it("says the seat is not open, and opens nothing, when it is not", async () => {
    const program = new StandInProgram(PROGRAM_ID);
    program.seatExists = false;

    const refusal = await accounts(program, null, null)
      .trader(MAKER)
      .catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(SeatNotOpen);
    expect((refusal as Error).message).toContain(owner.publicKey.toBase58());
    expect(chain.sent).toEqual([]);
  });

  it("uses the gate only to open a seat that is missing", async () => {
    const program = new StandInProgram(PROGRAM_ID);
    program.seatExists = false;
    const gateKey = Keypair.generate();
    const used: string[] = [];
    const gate: GateAccess = {
      key: gateKey,
      use: async () => {
        used.push("gate");
        throw new Error("stop after the gate was reached");
      },
    };

    await expect(
      program.openOwnTrader("http://rollup.example", owner, gate, undefined, undefined, "refuse"),
    ).rejects.toThrow("stop after the gate was reached");
    expect(used).toEqual(["gate"]);
  });
});
