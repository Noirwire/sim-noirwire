import type { Connection } from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChainFeed, REREAD_INTERVAL_MS } from "../src/rollup/chain-feed.js";
import type { Program } from "../src/rollup/program.js";

/** A promise the test settles by hand. */
const gate = () => {
  let open: () => void = () => {};
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { opened, open };
};

/** The websocket half of a connection, enough for `hangUp`. */
const fakeConnection = (): Connection =>
  ({
    _rpcWebSocketHeartbeat: null,
    _updateSubscriptions: async () => {},
    _rpcWebSocket: { setAutoReconnect: () => {}, close: () => {}, reconnect_timer_id: undefined },
  }) as unknown as Connection;

const quietHandlers = {
  onPrice: () => {},
  onTape: () => {},
  onStats: () => {},
  onMarket: () => {},
  onExchange: () => {},
  onError: () => {},
  onRecovered: () => {},
  onUnreachable: () => {},
};

describe("pausing the chain feed", () => {
  it("asks for nothing more from a read in flight, and is idle once that read has ended", async () => {
    const price = gate();
    const reads = { price: 0, tape: 0, stats: 0 };
    const program = {
      price: async () => {
        reads.price += 1;
        await price.opened;
        return { price: 0n, publishTimeSeconds: 0 };
      },
      tape: async () => {
        reads.tape += 1;
        return { lastSequence: 0n, fills: [] };
      },
      stats: async () => {
        reads.stats += 1;
        return { orders: 0n, fills: 0n, openInterest: [] };
      },
      market: async () => ({}),
      exchange: async () => ({ paused: false, quoteGuardOkUntilSeconds: null, maxSeatsPerDay: 5 }),
      subscribePrice: () => () => {},
      subscribeTape: () => () => {},
      subscribeMarket: () => () => {},
      subscribeExchange: () => () => {},
      subscribeStats: () => () => {},
    } as unknown as Program;
    const feed = new ChainFeed(program, fakeConnection, [0, 1], quietHandlers);
    const following = feed.follow();
    await Promise.resolve();

    feed.pause();
    let idle = false;
    void feed.idle().then(() => (idle = true));
    await Promise.resolve();
    expect(idle).toBe(false);

    price.open();
    await following;
    await feed.idle();

    expect(idle).toBe(true);
    expect(reads).toEqual({ price: 1, tape: 0, stats: 0 });
  });
});

describe("a rollup that stops answering the chain feed", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("is reported once after two full reads in a row fail, and not again while it goes on failing", async () => {
    let answering = true;
    const answer = async <T>(value: T): Promise<T> => {
      if (!answering) throw new Error("connection refused");
      return value;
    };
    const program = {
      price: () => answer({ price: 150_000n, publishTimeSeconds: 1_000 }),
      tape: () => answer({ lastSequence: 0n, fills: [] }),
      stats: () => answer({ orders: 0n, fills: 0n, openInterest: [] }),
      market: () => answer({}),
      exchange: () => answer({ paused: false, quoteGuardOkUntilSeconds: null, maxSeatsPerDay: 5 }),
      subscribePrice: () => () => {},
      subscribeTape: () => () => {},
      subscribeMarket: () => () => {},
      subscribeExchange: () => () => {},
      subscribeStats: () => () => {},
    } as unknown as Program;
    let unreachable = 0;
    const feed = new ChainFeed(program, fakeConnection, [0], {
      ...quietHandlers,
      onUnreachable: () => (unreachable += 1),
    });
    await feed.follow();

    answering = false;
    await vi.advanceTimersByTimeAsync(REREAD_INTERVAL_MS);
    expect(unreachable).toBe(0);
    await vi.advanceTimersByTimeAsync(REREAD_INTERVAL_MS);
    expect(unreachable).toBe(1);
    await vi.advanceTimersByTimeAsync(3 * REREAD_INTERVAL_MS);
    expect(unreachable).toBe(1);
    feed.stop();
  });
});
