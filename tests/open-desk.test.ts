import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Connection, Keypair, Transaction } from "@solana/web3.js";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Activity } from "../src/activity/activity.js";
import { type Config, loadConfig } from "../src/config/config.js";
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
import type { ChainExchange } from "../src/rollup/chain-types.js";
import { Session } from "../src/rollup/connections.js";
import { OpenDesk } from "../src/rollup/open-desk.js";
import { Program } from "../src/rollup/program.js";

const DIR = join("data-test", `open-desk-${Date.now()}`);
const CODE = "launch-code-0001";
const SIGNATURE = "5".repeat(88);
const PROGRAM_DAILY_LIMIT_ERROR = 6137;
const EXCHANGE: ChainExchange = {
  paused: false,
  quoteGuardOkUntilSeconds: null,
  maxSeatsPerDay: 5,
};

beforeAll(() => mkdirSync(DIR, { recursive: true }));
afterAll(() => rmSync(DIR, { recursive: true, force: true }));

let app: FastifyInstance | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

let counter = 0;

/** How the rollup answers a sent transaction: executed, refused by the program, or never heard from. */
type Outcome = "executed" | "silent" | { err: unknown };

/** A mainnet service with an open desk on a connection that records what is sent and answers as told. */
const serviceWith = async (
  invites: (owners: Keypair[]) => string,
  options: {
    exchange?: ChainExchange | null;
    outcome?: Outcome;
    perDay?: number;
    perIp?: number;
    network?: string;
  } = {},
) => {
  counter += 1;
  const dir = join(DIR, `service-${counter}`);
  mkdirSync(dir, { recursive: true });
  const owners = Array.from({ length: 3 }, () => Keypair.generate());
  const invitesPath = join(dir, "invites.txt");
  writeFileSync(invitesPath, invites(owners));
  const gate = Keypair.generate();
  const sent: Transaction[] = [];
  const answer = { outcome: options.outcome ?? "executed" } satisfies { outcome: Outcome };
  const connection = {
    rpcEndpoint: "https://rollup.example",
    getLatestBlockhash: async () => ({
      blockhash: Keypair.generate().publicKey.toBase58(),
      lastValidBlockHeight: 1,
    }),
    sendRawTransaction: async (raw: Buffer) => {
      sent.push(Transaction.from(raw));
      return SIGNATURE;
    },
    getSignatureStatus: async () => {
      const { outcome } = answer;
      if (outcome === "silent") throw new Error("the rollup did not answer");
      return {
        value: {
          confirmationStatus: "confirmed",
          err: outcome === "executed" ? null : outcome.err,
        },
      };
    },
  } as unknown as Connection;

  const clock = new ManualClock(1_000_000);
  const lines: string[] = [];
  const problems: string[] = [];
  const admission = new Admission(
    new InviteList(invitesPath, () => {}),
    new SeatLedger(join(dir, "gate-seats.json"), new ManualClock(1_000_000)),
    { perDay: options.perDay ?? 3, perAskerPerDay: options.perIp ?? 1 },
    clock,
  );
  const desk = new OpenDesk({
    program: new Program(Keypair.generate().publicKey.toBase58()),
    session: Session.of(connection),
    gate,
    admission,
    exchange: () => (options.exchange === undefined ? EXCHANGE : options.exchange),
    clock,
    log: (line) => lines.push(line),
    onError: (what) => problems.push(what),
  });
  const config: Config = {
    ...loadConfig({} as NodeJS.ProcessEnv),
    NETWORK: options.network ?? "mainnet",
  };
  const activity = new Activity({
    lifecycle: { wake: async () => {}, sleep: async () => {} },
    idleAfterMs: 600_000,
    idleAfterLastSocketMs: 15_000,
    onError: () => {},
  });
  activity.holdAwake();
  app = await buildServer({
    config,
    venue: new MemoryVenue({ clock }),
    tape: new TapeStore(),
    candles: new CandleAggregator(),
    stats: new StatsTracker(),
    fundLedger: new FundLedger({ perIpLimit: 20, perIpWindowMs: 60_000, clock }),
    hub: new Hub(),
    activity,
    openDesk: desk,
    readiness: () => ({ connected: true, pricesFresh: true, botsFunded: true }),
  });
  await vi.waitFor(() => expect(activity.phase).toBe("awake"));
  const server = app;

  const prepare = (owner: Keypair, invite?: string, ip = "10.0.0.1") =>
    server.inject({
      method: "POST",
      url: "/v1/open/prepare",
      remoteAddress: ip,
      payload: {
        owner: owner.publicKey.toBase58(),
        orderKeys: Array.from({ length: 4 }, () => Keypair.generate().publicKey.toBase58()),
        ...(invite ? { invite } : {}),
      },
    });
  const signedBy = (owner: Keypair, prepared: string): string => {
    const transaction = Transaction.from(Buffer.from(prepared, "base64"));
    transaction.partialSign(owner);
    return transaction
      .serialize({ requireAllSignatures: false, verifySignatures: false })
      .toString("base64");
  };
  const submit = (owner: Keypair, transaction: string, ip = "10.0.0.1") =>
    server.inject({
      method: "POST",
      url: "/v1/open/submit",
      remoteAddress: ip,
      payload: { owner: owner.publicKey.toBase58(), transaction },
    });
  const open = async (owner: Keypair, invite?: string, ip?: string) => {
    const prepared = await prepare(owner, invite, ip);
    expect(prepared.statusCode).toBe(200);
    return submit(owner, signedBy(owner, JSON.parse(prepared.body).transaction), ip);
  };

  return { owners, gate, sent, lines, problems, prepare, submit, signedBy, open, dir, answer };
};

const errorOf = (response: { body: string }): string => JSON.parse(response.body).error;

describe("opening an account on mainnet", () => {
  it("signs for an invited owner: the account opens, and nothing else is in the transaction", async () => {
    const { owners, gate, sent, open } = await serviceWith((o) => `${o[0].publicKey.toBase58()}\n`);

    const opened = await open(owners[0]);

    expect(opened.statusCode).toBe(200);
    expect(JSON.parse(opened.body).reference).toBe(SIGNATURE);
    expect(sent).toHaveLength(1);
    expect(sent[0].instructions).toHaveLength(1);
    expect(sent[0].feePayer?.equals(gate.publicKey)).toBe(true);
    expect(sent[0].verifySignatures()).toBe(true);
    const signers = sent[0].signatures
      .filter((entry) => entry.signature)
      .map((entry) => entry.publicKey);
    expect(signers.map((key) => key.toBase58()).sort()).toEqual(
      [gate.publicKey, owners[0].publicKey].map((key) => key.toBase58()).sort(),
    );
  });

  it("hands out the prepared transaction already signed by the gate, with the owner's slot empty", async () => {
    const { owners, gate, prepare } = await serviceWith((o) => `${o[0].publicKey.toBase58()}\n`);

    const prepared = Transaction.from(
      Buffer.from(JSON.parse((await prepare(owners[0])).body).transaction, "base64"),
    );

    const slot = (key: Keypair) =>
      prepared.signatures.find((entry) => entry.publicKey.equals(key.publicKey));
    expect(slot(gate)?.signature).toBeTruthy();
    expect(slot(owners[0])?.signature ?? null).toBeNull();
    expect(prepared.verifySignatures(false)).toBe(true);
    expect(prepared.verifySignatures(true)).toBe(false);
  });

  it("refuses a transaction without the owner's signature", async () => {
    const { owners, prepare, submit, sent } = await serviceWith(
      (o) => `${o[0].publicKey.toBase58()}\n`,
    );
    const prepared = JSON.parse((await prepare(owners[0])).body).transaction as string;

    const answer = await submit(owners[0], prepared);

    expect(answer.statusCode).toBe(400);
    expect(errorOf(answer)).toContain("owner has not signed");
    expect(sent).toHaveLength(0);
  });

  it("refuses a transaction whose message was changed, even if the owner signed the change", async () => {
    const { owners, prepare, submit, sent } = await serviceWith(
      (o) => `${o[0].publicKey.toBase58()}\n`,
    );
    const prepared = Transaction.from(
      Buffer.from(JSON.parse((await prepare(owners[0])).body).transaction, "base64"),
    );
    const changed = new Transaction({
      feePayer: prepared.feePayer,
      blockhash: prepared.recentBlockhash ?? "",
      lastValidBlockHeight: 1,
    }).add(...prepared.instructions, prepared.instructions[0]);
    changed.signatures = prepared.signatures;
    changed.partialSign(owners[0]);

    const answer = await submit(
      owners[0],
      changed
        .serialize({ requireAllSignatures: false, verifySignatures: false })
        .toString("base64"),
    );

    expect(answer.statusCode).toBe(400);
    expect(errorOf(answer)).toContain("not the transaction that was prepared");
    expect(sent).toHaveLength(0);
  });

  it("refuses a transaction whose gate signature was stripped", async () => {
    const { owners, gate, prepare, submit, sent } = await serviceWith(
      (o) => `${o[0].publicKey.toBase58()}\n`,
    );
    const prepared = Transaction.from(
      Buffer.from(JSON.parse((await prepare(owners[0])).body).transaction, "base64"),
    );
    prepared.signatures = prepared.signatures.map((entry) =>
      entry.publicKey.equals(gate.publicKey) ? { ...entry, signature: null } : entry,
    );
    prepared.partialSign(owners[0]);

    const answer = await submit(
      owners[0],
      prepared
        .serialize({ requireAllSignatures: false, verifySignatures: false })
        .toString("base64"),
    );

    expect(answer.statusCode).toBe(400);
    expect(errorOf(answer)).toContain("gate's signature");
    expect(sent).toHaveLength(0);
  });

  it("refuses a transaction whose gate signature was altered", async () => {
    const { owners, gate, prepare, submit, sent } = await serviceWith(
      (o) => `${o[0].publicKey.toBase58()}\n`,
    );
    const prepared = Transaction.from(
      Buffer.from(JSON.parse((await prepare(owners[0])).body).transaction, "base64"),
    );
    prepared.addSignature(gate.publicKey, Buffer.alloc(64, 9));
    prepared.partialSign(owners[0]);

    const answer = await submit(
      owners[0],
      prepared
        .serialize({ requireAllSignatures: false, verifySignatures: false })
        .toString("base64"),
    );

    expect(answer.statusCode).toBe(400);
    expect(sent).toHaveLength(0);
  });

  it("turns away an owner that is not invited, with the reason, before anything is built", async () => {
    const { owners, prepare, sent, lines } = await serviceWith(() => "");

    const refused = await prepare(owners[1]);

    expect(refused.statusCode).toBe(403);
    expect(errorOf(refused)).toContain("not on the invite list");
    expect(sent).toHaveLength(0);
    expect(lines).toEqual([
      expect.stringContaining(`gate: ${owners[1].publicKey.toBase58()} prepare refused`),
    ]);
  });

  it("needs the invite code when the invite has one, and rejects a wrong one", async () => {
    const { owners, prepare, open } = await serviceWith(
      (o) => `${CODE} ${o[0].publicKey.toBase58()}\n`,
    );

    expect(errorOf(await prepare(owners[0]))).toContain("Send the invite code");
    expect((await prepare(owners[0], "launch-code-9999")).statusCode).toBe(403);
    expect((await prepare(owners[1], CODE)).statusCode).toBe(403);
    expect((await open(owners[0], CODE)).statusCode).toBe(200);
  });

  it("opens one account per invite: the second try is refused with the reason", async () => {
    const { owners, prepare, open } = await serviceWith((o) => `${o[0].publicKey.toBase58()}\n`);
    await open(owners[0]);

    const again = await prepare(owners[0]);

    expect(again.statusCode).toBe(409);
    expect(errorOf(again)).toContain("used already");
  });

  it("does not sign a transaction other than the last one it prepared", async () => {
    const { owners, prepare, submit, sent, lines } = await serviceWith(
      (o) => `${o[0].publicKey.toBase58()}\n`,
    );
    const earlier = JSON.parse((await prepare(owners[0])).body).transaction as string;
    await prepare(owners[0]);
    const transaction = Transaction.from(Buffer.from(earlier, "base64"));
    transaction.partialSign(owners[0]);
    const stale = transaction.serialize({ requireAllSignatures: false }).toString("base64");

    const answer = await submit(owners[0], stale);

    expect(answer.statusCode).toBe(400);
    expect(errorOf(answer)).toContain("not the transaction that was prepared");
    expect(sent).toHaveLength(0);
    expect(lines.at(-1)).toContain("submit refused");
  });

  it("does not sign for someone whose invite was taken off the list after prepare", async () => {
    const { owners, prepare, signedBy, submit, sent, dir } = await serviceWith(
      (o) => `${o[0].publicKey.toBase58()}\n`,
    );
    const prepared = JSON.parse((await prepare(owners[0])).body).transaction as string;
    const path = join(dir, "invites.txt");
    writeFileSync(path, "");
    utimesSync(path, new Date(Date.now() + 5_000), new Date(Date.now() + 5_000));

    const answer = await submit(owners[0], signedBy(owners[0], prepared));

    expect(answer.statusCode).toBe(403);
    expect(sent).toHaveLength(0);
  });

  it("limits one network address, and says it resets tomorrow", async () => {
    const { owners, open, prepare } = await serviceWith(
      (o) => o.map((owner) => owner.publicKey.toBase58()).join("\n"),
      { perIp: 1 },
    );
    expect((await open(owners[0], undefined, "10.0.0.7")).statusCode).toBe(200);

    const refused = await prepare(owners[1], undefined, "10.0.0.7");

    expect(refused.statusCode).toBe(429);
    expect(errorOf(refused)).toContain("try again tomorrow");
    expect((await prepare(owners[1], undefined, "10.0.0.8")).statusCode).toBe(200);
  });

  it("stops at the day's limit", async () => {
    const { owners, open, prepare } = await serviceWith(
      (o) => o.map((owner) => owner.publicKey.toBase58()).join("\n"),
      { perDay: 1, perIp: 1 },
    );
    expect((await open(owners[0], undefined, "10.0.0.7")).statusCode).toBe(200);

    const refused = await prepare(owners[1], undefined, "10.0.0.8");

    expect(refused.statusCode).toBe(503);
    expect(errorOf(refused)).toContain("all given out");
  });

  it("is refused until the program's own daily limit has been read from the chain", async () => {
    const { owners, prepare } = await serviceWith((o) => `${o[0].publicKey.toBase58()}\n`, {
      exchange: null,
    });

    const refused = await prepare(owners[0]);

    expect(refused.statusCode).toBe(503);
    expect(errorOf(refused)).toContain("still starting");
  });

  it("frees the invite when the program refuses with its daily limit, and says so", async () => {
    const { owners, open, prepare } = await serviceWith((o) => `${o[0].publicKey.toBase58()}\n`, {
      outcome: { err: { InstructionError: [0, { Custom: PROGRAM_DAILY_LIMIT_ERROR }] } },
    });

    const refused = await open(owners[0]);

    expect(refused.statusCode).toBe(503);
    expect(errorOf(refused)).toContain("daily limit reached");
    expect((await prepare(owners[0])).statusCode).toBe(200);
  });

  it("keeps the seat of an account that opened although its confirmation was lost, when a retry is told it exists", async () => {
    const { owners, answer, open, prepare, dir, lines } = await serviceWith(
      (o) => `${o[0].publicKey.toBase58()}\n`,
    );
    answer.outcome = "silent";
    expect((await open(owners[0])).statusCode).toBe(502);
    const owner = owners[0].publicKey.toBase58();
    expect(
      new SeatLedger(join(dir, "gate-seats.json"), new ManualClock(1_000_000)).forInvite(
        `key:${owner}`,
      )?.state,
    ).toBe("unconfirmed");

    answer.outcome = { err: { InstructionError: [0, { Custom: 6113 }] } };
    const retry = await open(owners[0]);

    expect(retry.statusCode).toBe(409);
    const record = new SeatLedger(join(dir, "gate-seats.json"), new ManualClock(1_000_000));
    expect(record.openedFor(owner)?.invite).toBe(`key:${owner}`);
    expect(record.seatsToday(1_000_000)).toBe(1);
    expect(lines.some((line) => line.includes("opened by an earlier try, now recorded"))).toBe(
      true,
    );
    expect((await prepare(owners[0])).statusCode).toBe(409);
  });

  it("frees the invite when a first try, with nothing unconfirmed before it, is told the account exists", async () => {
    const { owners, open, dir } = await serviceWith((o) => `${o[0].publicKey.toBase58()}\n`, {
      outcome: { err: { InstructionError: [0, { Custom: 6113 }] } },
    });

    expect((await open(owners[0])).statusCode).toBe(409);

    expect(
      new SeatLedger(join(dir, "gate-seats.json"), new ManualClock(1_000_000)).seatsToday(
        1_000_000,
      ),
    ).toBe(0);
  });

  it("logs one line per decision, with the public key and nothing else about the person", async () => {
    const { owners, lines, open, prepare } = await serviceWith(
      (o) => `${CODE} ${o[0].publicKey.toBase58()}\n`,
    );
    await prepare(owners[1], undefined, "203.0.113.55");
    await open(owners[0], CODE, "203.0.113.56");

    const owner = owners[0].publicKey.toBase58();
    expect(lines).toEqual([
      expect.stringContaining(`gate: ${owners[1].publicKey.toBase58()} prepare refused`),
      `gate: ${owner} prepare admitted`,
      `gate: ${owner} submit admitted, sending`,
      `gate: ${owner} account opened`,
    ]);
    const text = lines.join("\n");
    expect(text).not.toContain(CODE);
    expect(text).not.toContain("203.0.113");
  });

  it("writes the seat down on disk under its invite, where a restart finds it", async () => {
    const { owners, open, dir } = await serviceWith((o) => `${o[0].publicKey.toBase58()}\n`);
    await open(owners[0]);

    const record = new SeatLedger(join(dir, "gate-seats.json"), new ManualClock(1_000_000));

    expect(record.openedFor(owners[0].publicKey.toBase58())?.invite).toBe(
      `key:${owners[0].publicKey.toBase58()}`,
    );
  });

  it("is not there on devnet, where the fund routes are", async () => {
    const { owners, prepare } = await serviceWith(() => "", { network: "devnet" });

    expect((await prepare(owners[0])).statusCode).toBe(404);
  });
});
