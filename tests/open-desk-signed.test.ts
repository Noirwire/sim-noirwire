import { createPrivateKey, sign } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Connection, Ed25519Program, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Activity } from "../src/activity/activity.js";
import { loadConfig } from "../src/config/config.js";
import { CandleAggregator } from "../src/data/candles.js";
import { FundLedger } from "../src/data/fund-ledger.js";
import { StatsTracker } from "../src/data/stats.js";
import { TapeStore } from "../src/data/tape-store.js";
import { ManualClock } from "../src/engine/clock.js";
import { MemoryVenue } from "../src/engine/memory-venue.js";
import { Admission } from "../src/gate/admission.js";
import { InviteList } from "../src/gate/invite-list.js";
import { SeatLedger } from "../src/gate/seat-ledger.js";
import { Hub } from "../src/http/hub.js";
import { buildServer } from "../src/http/server.js";
import { base58Of } from "../src/rollup/base58.js";
import type { ChainExchange } from "../src/rollup/chain-types.js";
import { Session } from "../src/rollup/connections.js";
import { OpenDesk } from "../src/rollup/open-desk.js";
import { Program } from "../src/rollup/program.js";
import type { PublicDeployment } from "../src/rollup/public-deployment.js";

const DIR = join("data-test", `open-desk-signed-${Date.now()}`);
const SIGNATURE = "5".repeat(88);
const START_MS = 1_000_000;
const ROLLUP_CLOCK_SECONDS = 1_700_000_000;
const EXCHANGE: ChainExchange = {
  paused: false,
  quoteGuardOkUntilSeconds: null,
  maxSeatsPerDay: 10,
};
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

beforeAll(() => mkdirSync(DIR, { recursive: true }));
afterAll(() => rmSync(DIR, { recursive: true, force: true }));

let app: FastifyInstance | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

let counter = 0;

type Outcome = "executed" | "silent" | { err: unknown };

const customError = (code: number): Outcome => ({
  err: { InstructionError: [1, { Custom: code }] },
});

const clockAccount = (seconds: number) => {
  const data = Buffer.alloc(40);
  data.writeBigInt64LE(BigInt(seconds), 32);
  return { data };
};

const signedBy = (owner: Keypair, message: Uint8Array): string =>
  sign(
    null,
    message,
    createPrivateKey({
      key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(owner.secretKey.subarray(0, 32))]),
      format: "der",
      type: "pkcs8",
    }),
  ).toString("base64");

/** A mainnet service whose open desk takes a signed message, on a connection that records what is sent. */
const serviceWith = async (
  options: {
    owners?: number;
    perDay?: number;
    perIp?: number;
    signed?: boolean;
    outcome?: Outcome;
  } = {},
) => {
  counter += 1;
  const dir = join(DIR, `service-${counter}`);
  mkdirSync(dir, { recursive: true });
  const owners = Array.from({ length: options.owners ?? 3 }, () => Keypair.generate());
  const invitesPath = join(dir, "invites.txt");
  writeFileSync(invitesPath, owners.map((owner) => `${owner.publicKey.toBase58()}\n`).join(""));
  const seatsPath = join(dir, "gate-seats.json");
  const gate = Keypair.generate();
  const sent: Transaction[] = [];
  const answer: {
    outcome: Outcome;
    blockHeight: number;
    landed: boolean;
    sendHold: Promise<void> | null;
    blockhashHold: Promise<void> | null;
    /** A look at the seat record taken at the moment a transaction reaches the wire. */
    atSend: (() => void) | null;
  } = {
    outcome: options.outcome ?? "executed",
    blockHeight: 0,
    landed: false,
    sendHold: null,
    blockhashHold: null,
    atSend: null,
  };
  const connection = {
    rpcEndpoint: "https://rollup.example",
    getAccountInfo: async () => clockAccount(ROLLUP_CLOCK_SECONDS),
    getLatestBlockhash: async () => {
      await answer.blockhashHold;
      return { blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1 };
    },
    sendRawTransaction: async (raw: Buffer) => {
      answer.atSend?.();
      await answer.sendHold;
      sent.push(Transaction.from(raw));
      return SIGNATURE;
    },
    getBlockHeight: async () => answer.blockHeight,
    getSignatureStatus: async (
      _signature: string,
      search?: { searchTransactionHistory: boolean },
    ) => {
      if (search?.searchTransactionHistory) {
        return { value: answer.landed ? { confirmationStatus: "finalized", err: null } : null };
      }
      if (answer.outcome === "silent") throw new Error("the rollup did not answer");
      return {
        value: {
          confirmationStatus: "confirmed",
          err: answer.outcome === "executed" ? null : answer.outcome.err,
        },
      };
    },
  } as unknown as Connection;

  const clock = new ManualClock(START_MS);
  const lines: string[] = [];
  const program = new Program(Keypair.generate().publicKey.toBase58());
  const ledger = () => new SeatLedger(seatsPath, clock);
  const makeDesk = (sweepEveryMs?: number) =>
    new OpenDesk({
      ...(sweepEveryMs === undefined ? {} : { sweepEveryMs }),
      program,
      session: Session.of(connection),
      gate,
      admission: new Admission(
        new InviteList(invitesPath, () => {}),
        new SeatLedger(seatsPath, clock),
        { perDay: options.perDay ?? 3, perAskerPerDay: options.perIp ?? 1 },
        clock,
      ),
      exchange: () => EXCHANGE,
      clock,
      log: (line) => lines.push(line),
      onError: () => {},
    });
  const desk = makeDesk();
  const signedMode = options.signed ?? true;
  const activity = new Activity({
    lifecycle: { wake: async () => {}, sleep: async () => {} },
    idleAfterMs: 600_000,
    idleAfterLastSocketMs: 15_000,
    onError: () => {},
  });
  activity.holdAwake();
  const start = async (openDesk: OpenDesk) => {
    await app?.close();
    app = await buildServer({
      config: {
        ...loadConfig({ SIGNED_OWNER_ACTIONS: signedMode ? "1" : "0" } as NodeJS.ProcessEnv),
        NETWORK: "mainnet",
      },
      venue: new MemoryVenue({ clock }),
      tape: new TapeStore(),
      candles: new CandleAggregator(),
      stats: new StatsTracker(),
      fundLedger: new FundLedger({ perIpLimit: 20, perIpWindowMs: 60_000, clock }),
      hub: new Hub(),
      activity,
      openDesk,
      readiness: () => ({ connected: true, pricesFresh: true, botsFunded: true }),
    });
    await vi.waitFor(() => expect(activity.phase).toBe("awake"));
    return app;
  };
  let server = await start(desk);

  const keysOf = new Map<string, string[]>();
  const keysFor = (owner: Keypair, fresh = false): string[] => {
    const id = owner.publicKey.toBase58();
    const keys =
      (!fresh && keysOf.get(id)) ||
      Array.from({ length: 4 }, () => Keypair.generate().publicKey.toBase58());
    keysOf.set(id, keys);
    return keys;
  };
  const prepare = (owner: Keypair, ip = "10.0.0.1", fresh = false) =>
    server.inject({
      method: "POST",
      url: "/v1/open/prepare",
      remoteAddress: ip,
      payload: { owner: owner.publicKey.toBase58(), orderKeys: keysFor(owner, fresh) },
    });
  const submit = (payload: Record<string, unknown>, ip = "10.0.0.1") =>
    server.inject({ method: "POST", url: "/v1/open/submit", remoteAddress: ip, payload });
  /** What the owner's wallet signs: the message built from the owner's own keys and the prepared expiry. */
  const messageFor = (owner: Keypair, expiresAt: number, keys = keysFor(owner)) =>
    program.openMessage(
      owner.publicKey,
      keys.map((key) => new PublicKey(key)),
      expiresAt,
    );
  const submitSigned = (
    owner: Keypair,
    prepared: { expiresAt: number },
    over: { signature?: string; expiresAt?: number; ip?: string } = {},
  ) =>
    submit(
      {
        owner: owner.publicKey.toBase58(),
        signature: over.signature ?? signedBy(owner, messageFor(owner, prepared.expiresAt)),
        expiresAt: over.expiresAt ?? prepared.expiresAt,
      },
      over.ip,
    );
  const open = async (owner: Keypair, ip?: string) => {
    const prepared = await prepare(owner, ip);
    expect(prepared.statusCode).toBe(200);
    return submitSigned(owner, JSON.parse(prepared.body), { ip });
  };

  return {
    owners,
    gate,
    sent,
    lines,
    answer,
    clock,
    program,
    ledger,
    makeDesk,
    desk,
    restart: (restarted: OpenDesk) => start(restarted).then((next) => (server = next)),
    prepare,
    submit,
    submitSigned,
    messageFor,
    keysFor,
    open,
  };
};

const bodyOf = (response: { body: string }) => JSON.parse(response.body) as Record<string, unknown>;

describe("opening an account with a signed message", () => {
  it("prepares an expiry on the rollup's clock and signs nothing", async () => {
    const { owners, prepare, sent, ledger } = await serviceWith();

    const prepared = await prepare(owners[0]);

    expect(prepared.statusCode).toBe(200);
    expect(bodyOf(prepared)).toEqual({
      ownerAuth: "message",
      expiresAt: ROLLUP_CLOCK_SECONDS + 100,
      expiresAtMs: START_MS + 100_000,
    });
    expect(sent).toHaveLength(0);
    expect(ledger().seatsToday(START_MS)).toBe(0);
  });

  it("opens the account: the owner's proof first, then the open, with the gate paying and signing alone", async () => {
    const { owners, gate, sent, open, ledger, answer } = await serviceWith();
    let atSend: unknown[] = [];
    answer.atSend = () => {
      atSend = ledger().awaitingSettlement();
    };

    const opened = await open(owners[0]);

    expect(opened.statusCode).toBe(200);
    expect(bodyOf(opened)).toEqual({ reference: SIGNATURE });
    expect(sent).toHaveLength(1);
    expect(sent[0].instructions).toHaveLength(2);
    expect(sent[0].instructions[0].programId.equals(Ed25519Program.programId)).toBe(true);
    expect(sent[0].feePayer?.equals(gate.publicKey)).toBe(true);
    expect(sent[0].verifySignatures()).toBe(true);
    expect(sent[0].signatures.filter((entry) => entry.signature)).toHaveLength(1);
    // The signature and last valid block height were on record before the transaction was sent.
    expect(atSend).toHaveLength(1);
    const seat = ledger().awaitingSettlement()[0];
    expect(seat.signatures).toEqual([base58Of(sent[0].signature ?? new Uint8Array(64))]);
    expect(seat.lastValidBlockHeight).toBe(1);
  });

  it("settles the seat as opened once the sweep sees it finalized", async () => {
    const { owners, open, answer, ledger, makeDesk } = await serviceWith();
    await open(owners[0]);
    answer.blockHeight = 10;
    answer.landed = true;

    const restarted = makeDesk(60_000);
    restarted.startSweeping();
    try {
      await vi.waitFor(() =>
        expect(ledger().openedFor(owners[0].publicKey.toBase58())).toBeTruthy(),
      );
    } finally {
      restarted.stopSweeping();
    }
  });

  it("refuses a signature that is not the owner's, before anything is spent", async () => {
    const { owners, prepare, submitSigned, messageFor, sent, ledger } = await serviceWith();
    const prepared = bodyOf(await prepare(owners[0])) as { expiresAt: number };

    const answer = await submitSigned(owners[0], prepared, {
      signature: signedBy(owners[1], messageFor(owners[0], prepared.expiresAt)),
    });

    expect(answer.statusCode).toBe(400);
    expect(bodyOf(answer).error).toContain("not the owner's");
    expect(sent).toHaveLength(0);
    expect(ledger().seatsToday(START_MS)).toBe(0);
  });

  it("refuses a signature over other order keys than the ones prepared", async () => {
    const { owners, prepare, submitSigned, messageFor, sent, ledger } = await serviceWith();
    const prepared = bodyOf(await prepare(owners[0])) as { expiresAt: number };
    const other = Array.from({ length: 4 }, () => Keypair.generate().publicKey.toBase58());

    const answer = await submitSigned(owners[0], prepared, {
      signature: signedBy(owners[0], messageFor(owners[0], prepared.expiresAt, other)),
    });

    expect(answer.statusCode).toBe(400);
    expect(sent).toHaveLength(0);
    expect(ledger().seatsToday(START_MS)).toBe(0);
  });

  it("refuses an expiry other than the prepared one, and a signature over a different expiry", async () => {
    const { owners, prepare, submitSigned, messageFor, sent } = await serviceWith();
    const prepared = bodyOf(await prepare(owners[0])) as { expiresAt: number };

    const named = await submitSigned(owners[0], prepared, { expiresAt: prepared.expiresAt + 5 });
    const signedOver = await submitSigned(owners[0], prepared, {
      signature: signedBy(owners[0], messageFor(owners[0], prepared.expiresAt + 5)),
    });

    expect(named.statusCode).toBe(400);
    expect(bodyOf(named).error).toContain("not the one that was prepared");
    expect(signedOver.statusCode).toBe(400);
    expect(sent).toHaveLength(0);
  });

  it("refuses a submit after the prepared time has passed", async () => {
    const { owners, prepare, submitSigned, clock, sent } = await serviceWith();
    const prepared = bodyOf(await prepare(owners[0])) as { expiresAt: number };
    clock.advance(100_001);

    const answer = await submitSigned(owners[0], prepared);

    expect(answer.statusCode).toBe(410);
    expect(sent).toHaveLength(0);
  });

  it("refuses a submit that was never prepared", async () => {
    const { owners, submitSigned, sent } = await serviceWith();

    const answer = await submitSigned(owners[0], { expiresAt: ROLLUP_CLOCK_SECONDS + 100 });

    expect(answer.statusCode).toBe(410);
    expect(sent).toHaveLength(0);
  });

  it("sends once for a double submit, however fast", async () => {
    const { owners, prepare, submitSigned, answer, sent } = await serviceWith();
    const prepared = bodyOf(await prepare(owners[0])) as { expiresAt: number };
    let release: () => void = () => {};
    answer.sendHold = new Promise<void>((resolve) => (release = resolve));
    let onTheWire = false;
    answer.atSend = () => {
      onTheWire = true;
    };

    const first = submitSigned(owners[0], prepared);
    await vi.waitFor(() => expect(onTheWire).toBe(true));
    const second = await submitSigned(owners[0], prepared);
    release();
    const opened = await first;
    const third = await submitSigned(owners[0], prepared);

    expect(opened.statusCode).toBe(200);
    expect(second.statusCode).toBe(409);
    expect(third.statusCode).toBe(410);
    expect(sent).toHaveLength(1);
  });

  it("keeps the daily limit when more people submit at once than the day allows", async () => {
    const { owners, prepare, submitSigned, answer, sent, ledger } = await serviceWith({
      owners: 6,
      perDay: 2,
      perIp: 6,
    });
    // Preparing reserves nothing, so every owner gets a prepare; the limit is held at submit.
    const prepared: { expiresAt: number }[] = [];
    for (const [at, owner] of owners.entries()) {
      const response = await prepare(owner, `10.0.0.${at + 1}`);
      expect(response.statusCode).toBe(200);
      prepared.push(bodyOf(response) as { expiresAt: number });
    }
    let release: () => void = () => {};
    answer.blockhashHold = new Promise<void>((resolve) => (release = resolve));

    const all = owners.map((owner, at) =>
      submitSigned(owner, prepared[at], { ip: `10.0.0.${at + 1}` }),
    );
    release();
    const answers = await Promise.all(all);

    expect(answers.filter((response) => response.statusCode === 200)).toHaveLength(2);
    expect(answers.filter((response) => response.statusCode === 503)).toHaveLength(4);
    expect(sent).toHaveLength(2);
    expect(ledger().seatsToday(START_MS)).toBe(2);
  });

  it("keeps the per-address limit when two owners behind one address submit at once", async () => {
    const { owners, prepare, submitSigned, answer, sent, ledger } = await serviceWith({
      perDay: 3,
      perIp: 1,
    });
    const first = bodyOf(await prepare(owners[0], "10.9.9.9")) as { expiresAt: number };
    const second = bodyOf(await prepare(owners[1], "10.9.9.9")) as { expiresAt: number };
    let release: () => void = () => {};
    answer.blockhashHold = new Promise<void>((resolve) => (release = resolve));

    const both = [
      submitSigned(owners[0], first, { ip: "10.9.9.9" }),
      submitSigned(owners[1], second, { ip: "10.9.9.9" }),
    ];
    release();
    const answers = await Promise.all(both);

    expect(answers.map((response) => response.statusCode).sort()).toEqual([200, 429]);
    expect(sent).toHaveLength(1);
    expect(ledger().seatsToday(START_MS)).toBe(1);
  });

  it("lets only one of many simultaneous prepares through the desk at a time, and none of them reserves a seat", async () => {
    const { owners, prepare, ledger } = await serviceWith({ owners: 6, perDay: 2, perIp: 6 });

    const answers = await Promise.all(
      owners.map((owner, at) => prepare(owner, `10.0.0.${at + 1}`)),
    );

    for (const response of answers) expect([200, 503]).toContain(response.statusCode);
    expect(answers.some((response) => response.statusCode === 200)).toBe(true);
    expect(ledger().seatsToday(START_MS)).toBe(0);
  });

  it("forgets a prepare across a restart and reserves nothing for it", async () => {
    const { owners, prepare, submitSigned, makeDesk, restart, ledger, sent, open } =
      await serviceWith();
    const prepared = bodyOf(await prepare(owners[0])) as { expiresAt: number };

    await restart(makeDesk());
    const answer = await submitSigned(owners[0], prepared);

    expect(answer.statusCode).toBe(410);
    expect(sent).toHaveLength(0);
    expect(ledger().seatsToday(START_MS)).toBe(0);
    expect((await open(owners[0])).statusCode).toBe(200);
    expect(sent).toHaveLength(1);
  });

  it("answers an owner proof the program refused in fixed words, and keeps the seat until it can no longer land", async () => {
    const { owners, open, ledger, answer } = await serviceWith({ outcome: customError(6151) });

    const refused = await open(owners[0]);

    expect(refused.statusCode).toBe(400);
    expect(bodyOf(refused).error).toContain("did not accept the wallet's signature");
    expect(ledger().awaitingSettlement()).toHaveLength(1);

    answer.outcome = customError(6133);
    const expired = await open(owners[0]);
    expect(expired.statusCode).toBe(410);
    expect(bodyOf(expired).error).toContain("expired");
    expect(ledger().seatsToday(START_MS)).toBe(1);
  });

  it("maps the other owner errors to fixed answers", async () => {
    for (const [code, status] of [
      [6152, 409],
      [6153, 400],
      [6154, 400],
    ] as const) {
      const { owners, open } = await serviceWith({ outcome: customError(code) });
      const refused = await open(owners[0]);
      expect(refused.statusCode).toBe(status);
      expect(bodyOf(refused).error).toContain("Nothing changed");
    }
  });

  it("lets the same order keys be sent again after an unconfirmed try, and holds other keys back until it settles", async () => {
    const { owners, prepare, submitSigned, answer, sent } = await serviceWith({
      outcome: "silent",
    });
    const prepared = bodyOf(await prepare(owners[0])) as { expiresAt: number };

    const unconfirmed = await submitSigned(owners[0], prepared);
    expect(unconfirmed.statusCode).toBe(502);
    answer.outcome = "executed";
    const again = await submitSigned(owners[0], prepared);
    expect(again.statusCode).toBe(200);
    expect(sent).toHaveLength(2);

    const second = await serviceWith({ outcome: "silent" });
    const firstTry = bodyOf(await second.prepare(second.owners[0])) as { expiresAt: number };
    expect((await second.submitSigned(second.owners[0], firstTry)).statusCode).toBe(502);
    const otherKeys = bodyOf(await second.prepare(second.owners[0], "10.0.0.1", true)) as {
      expiresAt: number;
    };
    second.answer.outcome = "executed";

    const held = await second.submitSigned(second.owners[0], otherKeys);

    expect(held.statusCode).toBe(409);
    expect(bodyOf(held).error).toContain("can still land");
    expect(second.sent).toHaveLength(1);
  });
});

describe("the open routes for both shapes", () => {
  it("takes only the signature shape when messages are signed", async () => {
    const { owners, submit } = await serviceWith();
    const owner = owners[0].publicKey.toBase58();
    const good = Buffer.alloc(64, 1).toString("base64");

    const legacy = await submit({ owner, transaction: "AAAA" });
    const short = await submit({
      owner,
      signature: Buffer.alloc(63, 1).toString("base64"),
      expiresAt: 5,
    });
    const long = await submit({
      owner,
      signature: Buffer.alloc(65, 1).toString("base64"),
      expiresAt: 5,
    });
    const notBase64 = await submit({ owner, signature: `${"!".repeat(88)}`, expiresAt: 5 });
    const noExpiry = await submit({ owner, signature: good });
    const fractional = await submit({ owner, signature: good, expiresAt: 1.5 });

    for (const response of [legacy, short, long, notBase64, noExpiry, fractional]) {
      expect(response.statusCode).toBe(400);
      expect(bodyOf(response).error).toBe("invalid request");
    }
  });

  it("takes only the transaction shape when messages are not signed, and prepares as before", async () => {
    const { owners, submit, prepare } = await serviceWith({ signed: false });
    const owner = owners[0].publicKey.toBase58();

    const signature = await submit({
      owner,
      signature: Buffer.alloc(64, 1).toString("base64"),
      expiresAt: 5,
    });
    const prepared = bodyOf(await prepare(owners[0]));

    expect(signature.statusCode).toBe(400);
    expect(prepared.ownerAuth).toBe("transaction");
    expect(typeof prepared.transaction).toBe("string");
    expect(prepared).not.toHaveProperty("expiresAt");
  });
});

describe("the setting", () => {
  it("is off unless it is exactly 1", () => {
    expect(loadConfig({} as NodeJS.ProcessEnv).SIGNED_OWNER_ACTIONS).toBe(false);
    expect(
      loadConfig({ SIGNED_OWNER_ACTIONS: "0" } as NodeJS.ProcessEnv).SIGNED_OWNER_ACTIONS,
    ).toBe(false);
    expect(
      loadConfig({ SIGNED_OWNER_ACTIONS: "1" } as NodeJS.ProcessEnv).SIGNED_OWNER_ACTIONS,
    ).toBe(true);
    expect(() => loadConfig({ SIGNED_OWNER_ACTIONS: "true" } as NodeJS.ProcessEnv)).toThrow();
  });

  it("is carried by the deployment the service describes", async () => {
    const clock = new ManualClock(START_MS);
    const activity = new Activity({
      lifecycle: { wake: async () => {}, sleep: async () => {} },
      idleAfterMs: 600_000,
      idleAfterLastSocketMs: 15_000,
      onError: () => {},
    });
    activity.holdAwake();
    for (const ownerAuth of ["message", "transaction"] as const) {
      const server = await buildServer({
        config: loadConfig({} as NodeJS.ProcessEnv),
        venue: new MemoryVenue({ clock }),
        tape: new TapeStore(),
        candles: new CandleAggregator(),
        stats: new StatsTracker(),
        fundLedger: new FundLedger({ perIpLimit: 20, perIpWindowMs: 60_000, clock }),
        hub: new Hub(),
        activity,
        deployment: () => ({ ownerAuth }) as PublicDeployment,
        readiness: () => ({ connected: true, pricesFresh: true, botsFunded: true }),
      });
      const response = await server.inject({ method: "GET", url: "/v1/deployment" });
      await server.close();
      expect(bodyOf(response).ownerAuth).toBe(ownerAuth);
    }
  });
});
