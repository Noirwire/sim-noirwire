import { createPublicKey, verify } from "node:crypto";
import { Keypair } from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BotAccounts } from "../src/rollup/bot-accounts.js";
import type { KeyCheckpoint } from "../src/rollup/chain-types.js";
import { Session, connectionTo } from "../src/rollup/connections.js";
import { Generation } from "../src/rollup/generation.js";
import { type Program, ProgramTrader, signedInConnection } from "../src/rollup/program.js";
import type { RollupSettings } from "../src/rollup/settings.js";
import { confirmedWithin } from "../src/rollup/transactions.js";

describe("a generation", () => {
  it("rejects work the moment it ends, and passes work that finished first", async () => {
    const life = new Generation();
    const finished = life.until(Promise.resolve("done"));
    const waiting = life.until(new Promise<string>(() => {}));

    await expect(finished).resolves.toBe("done");
    life.end();

    await expect(waiting).rejects.toThrow("went to sleep");
    await expect(life.until(Promise.resolve("late"))).rejects.toThrow("went to sleep");
  });
});

describe("a confirmation that never comes", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /** A rollup that takes every transaction and never reports it executed. */
  const silentRollup = () => {
    const methods: string[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: { body: string; signal?: AbortSignal }) => {
      init.signal?.throwIfAborted();
      const { id, method } = JSON.parse(init.body) as { id: number; method: string };
      methods.push(method);
      const result =
        method === "getLatestBlockhash"
          ? {
              context: { slot: 1 },
              value: { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 100 },
            }
          : method === "sendTransaction"
            ? "5".repeat(88)
            : { context: { slot: 1 }, value: [null] };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    return methods;
  };

  it("stops polling for its confirmation when the time is up", async () => {
    const methods = silentRollup();
    const connection = connectionTo("http://rollup.example");

    const outcome = confirmedWithin(connection, "signature", 1_000).catch(
      (error: Error) => error.message,
    );
    await vi.advanceTimersByTimeAsync(1_200);
    expect(await outcome).toContain("not confirmed");
    const atTheEnd = methods.length;
    await vi.advanceTimersByTimeAsync(10_000);

    expect(atTheEnd).toBeGreaterThan(0);
    expect(methods.length).toBe(atTheEnd);
  });

  it("stops polling when the generation ends, though the session that opened the connection was reset", async () => {
    const methods = silentRollup();
    const life = new Generation();
    const session = new Session(async () => connectionTo("http://rollup.example", undefined, life));

    const outcome = session
      .use((connection) => confirmedWithin(connection, "signature", 8_000))
      .catch((error: Error) => error.message);
    await vi.advanceTimersByTimeAsync(500);
    session.renew();
    life.end();
    await vi.advanceTimersByTimeAsync(0);
    const atTheEnd = methods.length;
    await vi.advanceTimersByTimeAsync(10_000);

    expect(methods.length).toBe(atTheEnd);
    await outcome;
  });
});

const owner = Keypair.generate();
const checkpointAt = (nextIndex: number): KeyCheckpoint =>
  ({ nextIndex }) as unknown as KeyCheckpoint;

const botsOpeningThrough = (
  opened: { checkpoint?: KeyCheckpoint; life?: Generation }[],
  controls: { unsettled: boolean; openings: (Promise<void> | null)[] } = {
    unsettled: false,
    openings: [],
  },
) => {
  let life: Generation | undefined = new Generation();
  const traders: {
    address: string;
    checkpoint: KeyCheckpoint;
    close: () => void;
    closed: boolean;
  }[] = [];
  const program = {
    openOwnTrader: async (
      _rpcUrl: string,
      _owner: Keypair,
      _gate: Keypair,
      _gateConnection: unknown,
      checkpoint?: KeyCheckpoint,
      madeFor?: Generation,
    ) => {
      opened.push({ checkpoint, life: madeFor });
      const nth = opened.length;
      await controls.openings[nth - 1];
      const trader = {
        address: owner.publicKey.toBase58(),
        checkpoint: checkpointAt(nth * 10),
        closed: false,
        get hasUnsettled() {
          return controls.unsettled;
        },
        close: () => (trader.closed = true),
      };
      traders.push(trader);
      return trader as unknown as ProgramTrader;
    },
  } as unknown as Program;
  const bots = new BotAccounts({
    program,
    settings: { rollupRpcUrl: "http://rollup.example", gate: Keypair.generate() } as RollupSettings,
    bots: [{ key: "maker", owner, tradesPerps: true, tradesSpot: false }],
    gate: Session.of({} as never),
    faucet: Session.of({} as never),
    keyCheckpoints: {},
    syncMarketId: 0,
    life: () => life,
  });
  return {
    bots,
    traders,
    sleep: () => {
      bots.retire();
      life?.end();
      life = undefined;
    },
    wake: () => {
      life = new Generation();
    },
    get life() {
      return life;
    },
  };
};

describe("the bots across a sleep", () => {
  it("opens a new trader for the new generation from where the old one's order keys stood, and lets the old one go", async () => {
    const opened: { checkpoint?: KeyCheckpoint; life?: Generation }[] = [];
    const awake = botsOpeningThrough(opened);

    const first = await awake.bots.trader("maker");
    expect(await awake.bots.trader("maker")).toBe(first);
    const firstLife = awake.life;
    awake.sleep();
    awake.wake();
    const second = await awake.bots.trader("maker");

    expect(second).not.toBe(first);
    expect(awake.traders[0]?.closed).toBe(true);
    expect(opened).toHaveLength(2);
    expect(opened[0]?.life).toBe(firstLife);
    expect(opened[1]?.life).toBe(awake.life);
    expect(opened[1]?.life).not.toBe(firstLife);
    expect(opened[1]?.checkpoint).toEqual(checkpointAt(10));
    expect(awake.bots.keyCheckpoints()[owner.publicKey.toBase58()]).toEqual(checkpointAt(20));
  });

  it("closes and refuses a trader that finished opening after the service went to sleep", async () => {
    const opened: { checkpoint?: KeyCheckpoint; life?: Generation }[] = [];
    const awake = botsOpeningThrough(opened);

    const opening = awake.bots.trader("maker");
    awake.sleep();

    await expect(opening).rejects.toThrow("went to sleep");
    expect(awake.traders[0]?.closed).toBe(true);
  });
});

describe("a bot opening that outlives a sleep", () => {
  it("does not erase the opening a later wake started for the same bot, so no third one starts", async () => {
    let finishOld: () => void = () => {};
    let finishNew: () => void = () => {};
    const opened: { checkpoint?: KeyCheckpoint; life?: Generation }[] = [];
    const awake = botsOpeningThrough(opened, {
      unsettled: false,
      openings: [
        new Promise<void>((resolve) => (finishOld = resolve)),
        new Promise<void>((resolve) => (finishNew = resolve)),
      ],
    });

    const old = awake.bots.trader("maker").catch((error: Error) => error.message);
    await vi.waitFor(() => expect(opened).toHaveLength(1));
    awake.sleep();
    awake.wake();
    const next = awake.bots.trader("maker");
    await vi.waitFor(() => expect(opened).toHaveLength(2));

    finishOld();
    expect(await old).toContain("went to sleep");
    const shared = awake.bots.trader("maker");
    finishNew();

    expect(await shared).toBe(await next);
    expect(opened).toHaveLength(2);
  });
});

describe("a bot let go of with a call that may still land", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("may not sign with its order keys again until that call's expiry has passed, and its turns are skipped meanwhile", async () => {
    const opened: { checkpoint?: KeyCheckpoint; life?: Generation }[] = [];
    const awake = botsOpeningThrough(opened, { unsettled: true, openings: [] });
    await awake.bots.trader("maker");

    awake.sleep();
    awake.wake();
    await expect(awake.bots.trader("maker")).rejects.toThrow("order keys wait");
    await vi.advanceTimersByTimeAsync(64_000);
    await expect(awake.bots.trader("maker")).rejects.toThrow("order keys wait");
    expect(opened).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1_001);
    await awake.bots.trader("maker");
    expect(opened).toHaveLength(2);
  });

  it("opens again at once when nothing it signed is unsettled", async () => {
    const opened: { checkpoint?: KeyCheckpoint; life?: Generation }[] = [];
    const awake = botsOpeningThrough(opened, { unsettled: false, openings: [] });
    await awake.bots.trader("maker");

    awake.sleep();
    awake.wake();
    await awake.bots.trader("maker");

    expect(opened).toHaveLength(2);
  });
});

describe("a trader that signs in again", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends nothing once the service went to sleep while it signed in, and refuses every later call", async () => {
    const requests = vi.fn();
    const signingIn = { held: false };
    vi.stubGlobal("fetch", (url: string, init: { signal?: AbortSignal }): Promise<Response> => {
      init.signal?.throwIfAborted();
      if (url.includes("/auth/challenge")) {
        // The endpoint is slow to answer a sign-in; the request ends only when it is aborted.
        signingIn.held = true;
        return new Promise((_resolve, reject) =>
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
        );
      }
      requests();
      return Promise.reject(new Error("the network is away"));
    });
    const life = new Generation();
    const trader = new ProgramTrader(
      "http://rollup.example",
      owner,
      {} as never,
      Keypair.generate().publicKey,
      connectionTo("http://rollup.example", undefined, life, true),
      life,
    );
    await expect(trader.view()).rejects.toThrow();
    const failedAt = requests.mock.calls.length;
    expect(failedAt).toBeGreaterThan(0);

    const next = trader.view().catch((error: Error) => error.message);
    await vi.waitFor(() => expect(signingIn.held).toBe(true));
    life.end();

    expect(await next).toContain("went to sleep");
    expect(requests.mock.calls.length).toBe(failedAt);
    await expect(trader.view()).rejects.toThrow("went to sleep");
    expect(requests.mock.calls.length).toBe(failedAt);
  });

  it("refuses a call from a generation that has ended, before it sends anything", async () => {
    const requests = vi.fn();
    vi.stubGlobal("fetch", async () => {
      requests();
      throw new Error("the network is away");
    });
    const life = new Generation();
    const connection = connectionTo("http://rollup.example", undefined, life, true);
    const trader = new ProgramTrader(
      "http://rollup.example",
      owner,
      {} as never,
      Keypair.generate().publicKey,
      connection,
      life,
    );
    life.end();

    await expect(trader.view()).rejects.toThrow("went to sleep");

    expect(requests).not.toHaveBeenCalled();
  });

  it("reports a call that may still land while one is under way, and not once it has ended", async () => {
    let fail: () => void = () => {};
    vi.stubGlobal(
      "fetch",
      () => new Promise<Response>((_resolve, reject) => (fail = () => reject(new Error("away")))),
    );
    const trader = new ProgramTrader(
      "http://rollup.example",
      owner,
      {} as never,
      Keypair.generate().publicKey,
      connectionTo("http://rollup.example"),
    );
    expect(trader.hasUnsettled).toBe(false);

    const call = trader.cancelAll(1).catch(() => {});
    await vi.waitFor(() => expect(trader.hasUnsettled).toBe(true));
    fail();
    await call;

    expect(trader.hasUnsettled).toBe(false);
  });

  it("does not report a read under way: it signed nothing, so its order keys are free", async () => {
    let requested = false;
    vi.stubGlobal("fetch", () => {
      requested = true;
      return new Promise<Response>(() => {});
    });
    const trader = new ProgramTrader(
      "http://rollup.example",
      owner,
      {} as never,
      Keypair.generate().publicKey,
      connectionTo("http://rollup.example"),
    );

    void trader.view().catch(() => {});
    await vi.waitFor(() => expect(requested).toBe(true));

    expect(trader.hasUnsettled).toBe(false);
  });
});

/** The text of an ed25519 signature as base58, taken back to bytes. */
const bytesOfBase58 = (text: string): Uint8Array => {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let number = 0n;
  for (const letter of text) number = number * 58n + BigInt(alphabet.indexOf(letter));
  const bytes: number[] = [];
  for (; number > 0n; number /= 256n) bytes.unshift(Number(number % 256n));
  return Uint8Array.from([
    ...new Array(text.length - text.replace(/^1+/, "").length).fill(0),
    ...bytes,
  ]);
};

describe("signing in", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("answers the endpoint's challenge with the key's signature, and connects with the token it gets", async () => {
    let loginBody: { pubkey: string; challenge: string; signature: string } | null = null;
    vi.stubGlobal("fetch", async (url: string, init?: { body?: string }) => {
      if (url.includes("/auth/challenge")) return Response.json({ challenge: "prove it" });
      loginBody = JSON.parse(init?.body ?? "{}");
      return Response.json({ token: "the-token" });
    });

    const connection = await signedInConnection("http://rollup.example", owner);

    expect(connection.rpcEndpoint).toBe("http://rollup.example?token=the-token");
    expect(loginBody).toMatchObject({ pubkey: owner.publicKey.toBase58(), challenge: "prove it" });
    const signature = bytesOfBase58(loginBody!.signature);
    expect(signature).toHaveLength(64);
    const publicKey = createPublicKey({
      key: Buffer.concat([
        Buffer.from("302a300506032b6570032100", "hex"),
        owner.publicKey.toBytes(),
      ]),
      format: "der",
      type: "spki",
    });
    expect(verify(null, Buffer.from("prove it"), publicKey, signature)).toBe(true);
  });

  it("sends no login once the service went to sleep while the challenge was on its way", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", (url: string, init: { signal?: AbortSignal }): Promise<Response> => {
      init.signal?.throwIfAborted();
      urls.push(url);
      return new Promise((_resolve, reject) =>
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
      );
    });
    const life = new Generation();

    const signingIn = signedInConnection("http://rollup.example", owner, life).catch(
      (error: Error) => error.message,
    );
    await vi.waitFor(() => expect(urls).toHaveLength(1));
    life.end();

    expect(await signingIn).toContain("went to sleep");
    expect(urls).toHaveLength(1);
  });
});
