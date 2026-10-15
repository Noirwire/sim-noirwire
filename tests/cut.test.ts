import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Session, connectionTo } from "../src/rollup/connections.js";
import { Generation } from "../src/rollup/generation.js";
import { confirmedWithin } from "../src/rollup/transactions.js";

/** A rollup that answers every JSON-RPC call; like the real fetch it refuses a request whose signal was aborted. */
const answeringRollup = (result: unknown) => {
  /** The requests that went out: a request whose signal was aborted never does. */
  const requests = vi.fn();
  vi.stubGlobal("fetch", async (_url: string, init: { body: string; signal?: AbortSignal }) => {
    init.signal?.throwIfAborted();
    requests();
    const { id } = JSON.parse(init.body) as { id: number };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  return requests;
};

const NOT_CONFIRMED = { context: { slot: 1 }, value: [null] };

describe("a connection whose generation ended", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("stops a confirmation that is polling the rollup, whatever its timeout", async () => {
    const requests = answeringRollup(NOT_CONFIRMED);
    const life = new Generation();
    const connection = connectionTo("http://rollup.example", undefined, life);
    const outcome = confirmedWithin(connection, "signature", 30_000).then(
      () => "confirmed",
      (error: Error) => error.message,
    );

    await vi.advanceTimersByTimeAsync(1_000);
    expect(requests.mock.calls.length).toBeGreaterThan(5);

    life.end();
    await vi.advanceTimersByTimeAsync(0);
    const afterTheEnd = requests.mock.calls.length;
    await vi.advanceTimersByTimeAsync(25_000);

    expect(requests.mock.calls.length).toBe(afterTheEnd);
    expect(await outcome).not.toBe("confirmed");
  });

  it("refuses a later request without sending it", async () => {
    const requests = answeringRollup(1);
    const life = new Generation();
    const connection = connectionTo("http://rollup.example", undefined, life);
    life.end();

    await expect(connection.getSlot()).rejects.toThrow();

    expect(requests).not.toHaveBeenCalled();
  });

  it("leaves a connection of the next generation alone", async () => {
    const requests = answeringRollup(7);
    const old = new Generation();
    const next = new Generation();
    connectionTo("http://rollup.example", undefined, old);
    const current = connectionTo("http://rollup.example", undefined, next);
    old.end();

    expect(await current.getSlot()).toBe(7);
    expect(requests).toHaveBeenCalledTimes(1);
  });

  it("never answers a later request on a connection made to hang, so a caller that retries on every failure ends", async () => {
    const requests = answeringRollup(1);
    const life = new Generation();
    const connection = connectionTo("http://rollup.example", undefined, life, true);
    life.end();

    let settled = false;
    void connection.getSlot().then(
      () => (settled = true),
      () => (settled = true),
    );
    await vi.advanceTimersByTimeAsync(60_000);

    expect(settled).toBe(false);
    expect(requests).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("a session that is renewed", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("opens a new connection on the next use", async () => {
    answeringRollup(3);
    const session = new Session(async () => connectionTo("http://rollup.example"));
    const first = await session.connection();

    session.renew();

    const second = await session.connection();
    expect(second).not.toBe(first);
    expect(await second.getSlot()).toBe(3);
  });
});
