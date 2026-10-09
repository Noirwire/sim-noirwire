import { ROLE, receipt } from "@noirwire/orderbook";
import { type Connection, Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { ManualClock } from "../src/engine/clock.js";
import { BotOrderSecrets, originOf } from "../src/rollup/bot-orders.js";
import { type Funded, FundingDesk } from "../src/rollup/funding-desk.js";
import { checkSubmitted } from "../src/rollup/open-request.js";
import { nextPublishPrice } from "../src/rollup/price-walk.js";
import {
  type ChainFill,
  type ChainMarket,
  type ChainTape,
  Program,
  fillRoles,
  firstOrderKeys,
} from "../src/rollup/program.js";
import { publicDeployment } from "../src/rollup/public-deployment.js";
import { requireAllowedRpc } from "../src/rollup/rpc-allow-list.js";
import { SeatSweep } from "../src/rollup/seat-sweep.js";
import { loadRollupSettings } from "../src/rollup/settings.js";
import { TapeTracker } from "../src/rollup/tape-tracker.js";
import { marketUnits, toChainPrice, toChainSize, toSimPrice } from "../src/rollup/units.js";

const fill = (sequence: number, over: Partial<ChainFill> = {}): ChainFill => ({
  sequence: BigInt(sequence),
  price: 150_000n,
  size: 10n,
  timeSeconds: 1_000 + sequence,
  takerSide: "buy",
  makerReceipt: new Uint8Array(8),
  takerReceipt: new Uint8Array(8),
  ...over,
});

const tapeOf = (...sequences: number[]): ChainTape => ({
  lastSequence: BigInt(Math.max(0, ...sequences)),
  fills: sequences.sort((a, b) => b - a).map((sequence) => fill(sequence)),
});

describe("walking the price under the move limit", () => {
  const step = (current: bigint, target: bigint) =>
    nextPublishPrice({ current, target, maxMoveBps: 250, tick: 100n });

  it("publishes a target inside the limit as it is, on the tick", () => {
    expect(step(150_000n, 151_234n)).toBe(151_200n);
  });

  it("stops at the limit on the way up and on the way down, never past it", () => {
    expect(step(150_000n, 220_000n)).toBe(153_700n);
    expect(step(150_000n, 100_000n)).toBe(146_300n);
  });

  it("reaches a far target in steps the program accepts one by one", () => {
    let price = 150_000n;
    let steps = 0;
    while (price !== 220_000n) {
      const next = step(price, 220_000n);
      expect((next - price) * 10_000n).toBeLessThanOrEqual(price * 250n);
      expect(next).toBeGreaterThan(price);
      price = next;
      steps += 1;
    }
    expect(steps).toBe(16);
  });

  it("gives an empty feed the target at once", () => {
    expect(step(0n, 220_050n)).toBe(220_000n);
  });
});

describe("the prepared transaction coming back", () => {
  const gate = Keypair.generate();
  const owner = Keypair.generate();
  const build = (lamports: number): Transaction =>
    new Transaction({
      feePayer: gate.publicKey,
      blockhash: PublicKey.default.toBase58(),
      lastValidBlockHeight: 1,
    }).add(
      SystemProgram.transfer({ fromPubkey: gate.publicKey, toPubkey: owner.publicKey, lamports }),
      SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: gate.publicKey, lamports }),
    );
  const wire = (transaction: Transaction): Uint8Array =>
    transaction.serialize({ requireAllSignatures: false, verifySignatures: false });
  const prepared = build(5).serializeMessage();
  const signedByOwner = (transaction: Transaction): Transaction => {
    transaction.partialSign(owner);
    return transaction;
  };

  it("is accepted when it is the same bytes with the owner's signature", () => {
    const checked = checkSubmitted(prepared, wire(signedByOwner(build(5))), owner.publicKey);
    expect(checked.ok).toBe(true);
  });

  it("is refused when anything in it was changed, even with a valid signature over the change", () => {
    const checked = checkSubmitted(prepared, wire(signedByOwner(build(6))), owner.publicKey);
    expect(checked).toEqual({ ok: false, reason: "not the transaction that was prepared" });
  });

  it("is refused without the owner's signature", () => {
    expect(checkSubmitted(prepared, wire(build(5)), owner.publicKey).ok).toBe(false);
  });

  it("is refused when the owner's signature is somebody else's", () => {
    const forged = build(5);
    forged.addSignature(owner.publicKey, Buffer.alloc(64, 7));
    expect(checkSubmitted(prepared, wire(forged), owner.publicKey)).toEqual({
      ok: false,
      reason: "a signature does not match",
    });
  });

  it("is refused when it is not a transaction at all", () => {
    expect(checkSubmitted(prepared, Uint8Array.of(1, 2, 3), owner.publicKey).ok).toBe(false);
  });
});

describe("following the tape by sequence number", () => {
  const sequences = (fills: ChainFill[]): number[] => fills.map((entry) => Number(entry.sequence));

  it("returns each fill once, oldest first, however often the same tape is read", () => {
    const tracker = new TapeTracker();
    expect(sequences(tracker.take(tapeOf(1, 2, 3)).fills)).toEqual([1, 2, 3]);
    expect(tracker.take(tapeOf(1, 2, 3)).fills).toEqual([]);
    expect(sequences(tracker.take(tapeOf(1, 2, 3, 4)).fills)).toEqual([4]);
  });

  it("backfills what a dropped connection skipped from what the tape still holds", () => {
    const tracker = new TapeTracker();
    tracker.take(tapeOf(1, 2, 3, 4, 5));
    const afterReconnect = tracker.take(tapeOf(3, 4, 5, 6, 7, 8, 9));
    expect(sequences(afterReconnect.fills)).toEqual([6, 7, 8, 9]);
    expect(afterReconnect.lost).toBe(0n);
  });

  it("counts the fills that left the ring before they could be read", () => {
    const tracker = new TapeTracker();
    tracker.take(tapeOf(1, 2, 3));
    const late = tracker.take(tapeOf(8, 9, 10));
    expect(sequences(late.fills)).toEqual([8, 9, 10]);
    expect(late.lost).toBe(4n);
  });

  it("starts over when the network was reset under it", () => {
    const tracker = new TapeTracker();
    tracker.take(tapeOf(1, 2, 3, 4, 5));
    expect(sequences(tracker.take(tapeOf(1, 2)).fills)).toEqual([1, 2]);
  });
});

describe("telling a bot's fill from a user's by receipt", () => {
  const makerSecret = new Uint8Array(16).fill(1);
  const takerSecret = new Uint8Array(16).fill(2);
  const stranger = new Uint8Array(16).fill(3);
  const printed = (maker: Uint8Array, taker: Uint8Array): ChainFill =>
    fill(7, {
      makerReceipt: receipt(maker, 7n, ROLE.maker),
      takerReceipt: receipt(taker, 7n, ROLE.taker),
    });

  it("counts a fill as bot activity only when both receipts are a bot's", () => {
    const secrets = [makerSecret, takerSecret];
    expect(originOf(fillRoles(printed(makerSecret, takerSecret), secrets))).toBe("bot");
    expect(originOf(fillRoles(printed(makerSecret, stranger), secrets))).toBe("user");
    expect(originOf(fillRoles(printed(stranger, takerSecret), secrets))).toBe("user");
  });

  it("does not recognise a receipt copied onto another fill", () => {
    const copied = fill(8, {
      makerReceipt: receipt(makerSecret, 7n, ROLE.maker),
      takerReceipt: receipt(takerSecret, 7n, ROLE.taker),
    });
    expect(fillRoles(copied, [makerSecret, takerSecret])).toEqual({ maker: false, taker: false });
  });

  it("keeps a cancelled order's secret until the tape was read after the cancel", () => {
    const secrets = new BotOrderSecrets();
    secrets.add("NSOL-PERP", "bot:maker:NSOL-PERP", makerSecret);
    secrets.add("NSOL-PERP", "bot:taker:0", takerSecret);
    secrets.retireAll("NSOL-PERP", "bot:maker:NSOL-PERP", 50_000);

    secrets.forgetEndedBefore("NSOL-PERP", 55_000);
    expect(secrets.of("NSOL-PERP")).toEqual([makerSecret, takerSecret]);

    secrets.forgetEndedBefore("NSOL-PERP", 61_000);
    expect(secrets.of("NSOL-PERP")).toEqual([takerSecret]);
  });
});

describe("the liquidator's blind sweep", () => {
  it("walks the seats a few at a time and wraps at the end of the table", () => {
    const sweep = new SeatSweep(2, 6, () => 2_000);
    expect(sweep.next(3)).toEqual([2, 3, 4]);
    expect(sweep.next(3)).toEqual([5, 2, 3]);
  });

  it("walks only as far as the gate ever opened seats, and further once it opens more", () => {
    let opened = 3;
    const sweep = new SeatSweep(2, 2_048, () => opened);
    expect(sweep.next(4)).toEqual([2, 3, 4, 2]);
    opened = 5;
    expect(sweep.next(4)).toEqual([3, 4, 5, 6]);
  });
});

describe("the funding desk when the transaction does not go through", () => {
  const gate = Keypair.generate();
  const faucet = Keypair.generate();
  const submitWith = async (network: {
    send(): Promise<string>;
    err?: unknown;
  }): Promise<Funded> => {
    const connection = {
      rpcEndpoint: "https://rollup.example/?token=secret",
      getLatestBlockhash: async () => ({
        blockhash: PublicKey.default.toBase58(),
        lastValidBlockHeight: 1,
      }),
      sendRawTransaction: () => network.send(),
      getSignatureStatus: async () => ({
        value: { confirmationStatus: "confirmed", err: network.err ?? null },
      }),
    } as unknown as Connection;
    const desk = new FundingDesk({
      program: new Program(Keypair.generate().publicKey.toBase58()),
      connection,
      gate,
      faucet,
      mint: Keypair.generate().publicKey.toBase58(),
      amountAtoms: 5_000_000_000n,
      clock: new ManualClock(1_000),
      onError: () => {},
    });
    const owner = Keypair.generate();
    const address = owner.publicKey.toBase58();
    const prepared = await desk.prepare(
      address,
      firstOrderKeys(owner).map((key) => key.toBase58()),
    );
    if (!prepared.ok) throw new Error("prepare failed");
    const transaction = Transaction.from(Buffer.from(prepared.transaction, "base64"));
    transaction.partialSign(owner);
    const signed = transaction.serialize({ requireAllSignatures: false, verifySignatures: false });
    return desk.submit(address, signed.toString("base64"));
  };

  it("says the daily limit is reached when the program refuses a new seat for that reason", async () => {
    const funded = await submitWith({
      send: async () => "signature",
      err: { InstructionError: [0, { Custom: 6137 }] },
    });
    expect(funded).toMatchObject({ ok: false, status: 503 });
    expect(funded.ok ? "" : funded.reason).toContain("daily limit reached");
  });

  it("passes on the endpoint's own status and body when it refuses the deposit, without the sign-in token", async () => {
    const funded = await submitWith({
      send: async () => {
        throw new Error('403 Forbidden: {"error":"Access denied"}');
      },
    });
    expect(funded).toMatchObject({ ok: false, status: 502 });
    const reason = funded.ok ? "" : funded.reason;
    expect(reason).toContain('403 Forbidden: {"error":"Access denied"}');
    expect(reason).not.toContain("secret");
  });

  it("reports any other refusal by the program as an account that was not opened", async () => {
    const funded = await submitWith({
      send: async () => "signature",
      err: { InstructionError: [0, { Custom: 6003 }] },
    });
    expect(funded).toMatchObject({ ok: false, status: 409 });
  });
});

describe("the load test's allow-list", () => {
  it("lets this machine through and refuses any other endpoint that was not named", () => {
    expect(() =>
      requireAllowedRpc(["http://127.0.0.1:6699", "ws://localhost:6700"], []),
    ).not.toThrow();
    expect(() => requireAllowedRpc(["https://devnet-tee.magicblock.app"], [])).toThrow(
      /allow-list/,
    );
  });

  it("lets a named endpoint through and still refuses its neighbour", () => {
    const allowed = ["https://devnet-tee.magicblock.app"];
    expect(() => requireAllowedRpc(["https://devnet-tee.magicblock.app/"], allowed)).not.toThrow();
    expect(() => requireAllowedRpc(["https://api.mainnet-beta.solana.com"], allowed)).toThrow();
  });
});

describe("units between the service and the program", () => {
  const sol = marketUnits(1_000_000n, 9);

  it("turns a price per lot into a price per whole unit and back", () => {
    expect(toSimPrice(sol, 150_000n)).toBe(150_000_000n);
    expect(toChainPrice(sol, 150_000_000n)).toBe(150_000n);
  });

  it("refuses a size that is not a whole number of lots", () => {
    expect(toChainSize(sol, 5_000n)).toBe(5n);
    expect(toChainSize(sol, 5_500n)).toBeNull();
  });
});

describe("the public deployment description", () => {
  const address = () => Keypair.generate().publicKey.toBase58();
  const roles = { gate: address(), oracle: address(), faucet: address() };
  const deployment = {
    network: "localnet",
    programId: address(),
    ...roles,
    depositUrl: "http://internal-rollup:7799",
    tokens: [
      { index: 0, symbol: "nUSD", decimals: 6, mint: address() },
      { index: 1, symbol: "nSOL", decimals: 9, mint: address() },
    ],
    markets: [
      { id: 0, symbol: "NSOL-PERP", kind: "perp" as const, baseDecimals: 9 },
      { id: 2, symbol: "NSOL-NUSD", kind: "spot" as const, baseDecimals: 9 },
    ],
  };
  const chainMarket = (
    marketId: number,
    kind: "perp" | "spot",
    baseToken: number,
  ): ChainMarket => ({
    marketId,
    kind,
    tick: 100n,
    baseLot: 1_000_000n,
    minSize: 1n,
    minNotional: 1_000_000n,
    bandBps: 400,
    imBps: 1_000,
    maxMoveBps: 250,
    minPublishGapSeconds: 1,
    maxPriceAgeSeconds: 10,
    baseToken,
    quoteToken: 0,
  });
  const addresses = () => ({
    exchange: "exchange-address",
    stats: "stats-address",
    market: address(),
    tape: address(),
    priceFeed: address(),
  });
  const described = publicDeployment(
    deployment,
    {
      solanaRpcUrl: "https://solana.example",
      rollupRpcUrl: "https://rollup.example",
      rollupWsUrl: "wss://rollup.example",
    },
    [
      { chain: chainMarket(0, "perp", 0), addresses: addresses() },
      { chain: chainMarket(2, "spot", 1), addresses: addresses() },
    ],
  );

  it("names the gate, the oracle, the faucet and the service's own deposit URL nowhere", () => {
    const text = JSON.stringify(described);
    for (const hidden of [...Object.values(roles), deployment.depositUrl]) {
      expect(text).not.toContain(hidden);
    }
  });

  it("gives a spot market both token mints and a perpetual only its quote", () => {
    const [perp, spot] = described.markets;
    expect(perp).toMatchObject({ marketId: 0, baseToken: null, lotSize: "1000000", tick: "100" });
    expect(perp!.quoteToken.mint).toBe(deployment.tokens[0]!.mint);
    expect(spot!.baseToken).toEqual({
      symbol: "nSOL",
      mint: deployment.tokens[1]!.mint,
      decimals: 9,
    });
  });
});

describe("the rollup settings", () => {
  const key = () => Keypair.generate();
  const oracle = key();
  const gate = key();
  const faucet = key();
  const secret = (pair: Keypair) => JSON.stringify(Array.from(pair.secretKey));
  const env = (over: Record<string, string | undefined> = {}) => ({
    SOLANA_RPC_URL: "http://127.0.0.1:8899",
    ROLLUP_RPC_URL: "http://127.0.0.1:6699",
    ROLLUP_WS_URL: "ws://127.0.0.1:6700",
    DEPLOYMENT_JSON: JSON.stringify({
      network: "localnet",
      programId: key().publicKey.toBase58(),
      gate: gate.publicKey.toBase58(),
      oracle: oracle.publicKey.toBase58(),
      faucet: faucet.publicKey.toBase58(),
      tokens: [],
      depositUrl: "http://127.0.0.1:7799",
      markets: [{ id: 0, symbol: "NSOL-PERP", kind: "perp", baseDecimals: 9 }],
    }),
    ORACLE_SECRET_KEY: secret(oracle),
    GATE_SECRET_KEY: secret(gate),
    FAUCET_SECRET_KEY: secret(faucet),
    BOT_TRADER_SEEDS: `${"11".repeat(32)},${"22".repeat(32)}`,
    ...over,
  });

  it("names what is missing and refuses to start", () => {
    expect(() => loadRollupSettings(env({ GATE_SECRET_KEY: undefined }), 2, ["NSOL-PERP"])).toThrow(
      "GATE_SECRET_KEY",
    );
  });

  it("refuses a key that is not the one the deployment names, without echoing it", () => {
    const wrong = secret(key());
    let message = "";
    try {
      loadRollupSettings(env({ ORACLE_SECRET_KEY: wrong }), 2, ["NSOL-PERP"]);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("oracle");
    expect(message).not.toContain(wrong.slice(0, 12));
  });

  it("refuses fewer seeds than bots, and a market the deployment lacks", () => {
    expect(() => loadRollupSettings(env(), 3, ["NSOL-PERP"])).toThrow("BOT_TRADER_SEEDS");
    expect(() => loadRollupSettings(env(), 2, ["NSOL-NUSD"])).toThrow("NSOL-NUSD");
  });

  it("gives each bot its own owner key from its own seed", () => {
    const settings = loadRollupSettings(env(), 2, ["NSOL-PERP"]);
    expect(settings.botOwners[0]!.publicKey.equals(settings.botOwners[1]!.publicKey)).toBe(false);
  });
});
