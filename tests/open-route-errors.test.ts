import { Keypair } from "@solana/web3.js";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { Activity } from "../src/activity/activity.js";
import { loadConfig } from "../src/config/config.js";
import { CandleAggregator } from "../src/data/candles.js";
import { FundLedger } from "../src/data/fund-ledger.js";
import { StatsTracker } from "../src/data/stats.js";
import { TapeStore } from "../src/data/tape-store.js";
import { ManualClock } from "../src/engine/clock.js";
import { MemoryVenue } from "../src/engine/memory-venue.js";
import { Hub } from "../src/http/hub.js";
import { buildServer } from "../src/http/server.js";
import type { OpenRequests } from "../src/rollup/open-desk.js";

let app: FastifyInstance | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

const owner = Keypair.generate().publicKey.toBase58();

/** A mainnet service whose open desk is `desk`, and what the problem log was told. */
const serviceWith = async (desk: OpenRequests) => {
  const clock = new ManualClock(1_000_000);
  const told = { errors: [] as { what: string; message: string }[], recovered: [] as string[] };
  const activity = new Activity({
    lifecycle: { wake: async () => {}, sleep: async () => {} },
    idleAfterMs: 600_000,
    idleAfterLastSocketMs: 15_000,
    onError: () => {},
  });
  activity.holdAwake();
  app = await buildServer({
    config: { ...loadConfig({} as NodeJS.ProcessEnv), NETWORK: "mainnet" },
    venue: new MemoryVenue({ clock }),
    tape: new TapeStore(),
    candles: new CandleAggregator(),
    stats: new StatsTracker(),
    fundLedger: new FundLedger({ perIpLimit: 20, perIpWindowMs: 60_000, clock }),
    hub: new Hub(),
    activity,
    openDesk: desk,
    readiness: () => ({ connected: true, pricesFresh: true, botsFunded: true }),
    problems: {
      onError: (what, error) =>
        told.errors.push({ what, message: error instanceof Error ? error.message : String(error) }),
      onRecovered: (what) => told.recovered.push(what),
    },
  });
  const server = app;
  const prepare = () =>
    server.inject({
      method: "POST",
      url: "/v1/open/prepare",
      payload: {
        owner,
        orderKeys: Array.from({ length: 4 }, () => Keypair.generate().publicKey.toBase58()),
      },
    });
  const submit = () =>
    server.inject({
      method: "POST",
      url: "/v1/open/submit",
      payload: { owner, transaction: "AAAA" },
    });
  return { told, prepare, submit };
};

describe("the open desk's errors", () => {
  it("are logged when prepare fails, while the caller is only told the rollup did not answer", async () => {
    const { told, prepare } = await serviceWith({
      prepare: async () => {
        throw new Error("the rpc node returned 500 for getLatestBlockhash");
      },
      submit: async () => ({ ok: true, signature: "x" }),
    });

    const answer = await prepare();

    expect(answer.statusCode).toBe(502);
    expect(JSON.parse(answer.body)).toEqual({ error: "the rollup did not answer, try again" });
    expect(told.errors).toEqual([
      {
        what: "opening an account (prepare)",
        message: "the rpc node returned 500 for getLatestBlockhash",
      },
    ]);
  });

  it("are logged when submit fails, and a later success says it works again", async () => {
    let failing = true;
    const { told, submit } = await serviceWith({
      prepare: async () => ({ ok: false, status: 403, reason: "not invited" }),
      submit: async () => {
        if (failing) throw new Error("a bug inside the desk");
        return { ok: true, signature: "x" };
      },
    });

    const failed = await submit();
    failing = false;
    const worked = await submit();

    expect(failed.statusCode).toBe(502);
    expect(told.errors).toEqual([
      { what: "opening an account (submit)", message: "a bug inside the desk" },
    ]);
    expect(worked.statusCode).toBe(200);
    expect(told.recovered).toContain("opening an account (submit)");
  });

  it("are not logged for a refusal the desk gives on purpose", async () => {
    const { told, prepare } = await serviceWith({
      prepare: async () => ({ ok: false, status: 403, reason: "not on the invite list" }),
      submit: async () => ({ ok: true, signature: "x" }),
    });

    const answer = await prepare();

    expect(answer.statusCode).toBe(403);
    expect(told.errors).toEqual([]);
  });
});
