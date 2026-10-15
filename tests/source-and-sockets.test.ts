import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Activity } from "../src/activity/activity.js";
import { JupiterPriceSource } from "../src/prices/jupiter-price-source.js";
import { type Socket, backedOffSockets } from "../src/rollup/bot-socket.js";

describe("the price source on a wake", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const sourceWith = (answer: () => Promise<unknown>) => {
    const fetches = vi.fn(async () => ({
      status: 200,
      ok: true,
      json: answer,
    }));
    vi.stubGlobal("fetch", fetches);
    const prices: bigint[] = [];
    const source = new JupiterPriceSource({
      ids: ["sol"],
      baseUrl: "http://prices.example",
      pollIntervalMs: 2_000,
      slowPollIntervalMs: 60_000,
      onError: () => {},
    });
    return {
      source,
      fetches,
      prices,
      start: () => source.start((point) => prices.push(point.price)),
    };
  };

  it("lets a waker wait for an answer that is fetched now, and delivers it first", async () => {
    let answerNow: (value: unknown) => void = () => {};
    const { source, fetches, prices, start } = sourceWith(
      () => new Promise((resolve) => (answerNow = resolve)),
    );
    source.setPace("slow");
    start();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetches).toHaveBeenCalledTimes(1);

    let delivered = false;
    void source.pollNow().then(() => (delivered = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(delivered).toBe(false);
    expect(fetches).toHaveBeenCalledTimes(1);

    answerNow({ sol: { usdPrice: 150 } });
    await vi.advanceTimersByTimeAsync(0);

    expect(delivered).toBe(true);
    expect(prices).toEqual([150_000_000n]);
    source.stop();
  });

  it("polls once a minute at the slow pace and fetches at once when it speeds up", async () => {
    const { source, fetches, start } = sourceWith(async () => ({ sol: { usdPrice: 150 } }));
    source.setPace("slow");
    start();

    await vi.advanceTimersByTimeAsync(59_000);
    expect(fetches).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetches).toHaveBeenCalledTimes(2);

    source.setPace("fast");
    await vi.advanceTimersByTimeAsync(0);
    expect(fetches).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetches).toHaveBeenCalledTimes(4);
    source.stop();
  });
});

describe("a poll that delivers no price", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const pollWith = async (
    reply: () => unknown,
  ): Promise<{ delivered: boolean; prices: number }> => {
    vi.stubGlobal("fetch", async () => reply());
    let prices = 0;
    const source = new JupiterPriceSource({
      ids: ["sol", "nvda"],
      baseUrl: "http://prices.example",
      pollIntervalMs: 2_000,
      slowPollIntervalMs: 60_000,
      onError: () => {},
    });
    source.start(() => (prices += 1));
    const delivered = await source.pollNow();
    source.stop();
    return { delivered, prices };
  };

  it("is not a delivery when the source turns the request away with a rate limit", async () => {
    const result = await pollWith(() => ({ status: 429, ok: false, json: async () => ({}) }));

    expect(result).toEqual({ delivered: false, prices: 0 });
  });

  it("is not a delivery when the request fails", async () => {
    const result = await pollWith(() => ({ status: 500, ok: false, json: async () => ({}) }));

    expect(result).toEqual({ delivered: false, prices: 0 });
  });

  it("is not a delivery when the answer lacks a price for one of the ids", async () => {
    const result = await pollWith(() => ({
      status: 200,
      ok: true,
      json: async () => ({ sol: { usdPrice: 150 } }),
    }));

    expect(result).toEqual({ delivered: false, prices: 1 });
  });

  it("is a delivery when every id has a price", async () => {
    const result = await pollWith(() => ({
      status: 200,
      ok: true,
      json: async () => ({ sol: { usdPrice: 150 }, nvda: { usdPrice: 181 } }),
    }));

    expect(result).toEqual({ delivered: true, prices: 2 });
  });
});

/** A socket the test controls, and the ones the factory opened. */
const socketsOpened = () => {
  const opened: (Socket & {
    fail(): void;
    open(): void;
    drop(): void;
    answer(reply: { result?: number; error?: object }): void;
  })[] = [];
  const open = (): Socket => {
    const socket = {
      send: () => {},
      close: () => {},
      onopen: null as (() => void) | null,
      onmessage: null as ((event: { data: unknown }) => void) | null,
      onclose: null as (() => void) | null,
      onerror: null as (() => void) | null,
      fail: () => {
        socket.onerror?.();
        socket.onclose?.();
      },
      open: () => socket.onopen?.(),
      drop: () => socket.onclose?.(),
      answer: (reply: { result?: number; error?: object }) =>
        socket.onmessage?.({ data: JSON.stringify({ jsonrpc: "2.0", id: 1, ...reply }) }),
    };
    opened.push(socket);
    return socket;
  };
  return { opened, open };
};

describe("the bots' view sockets when the endpoint refuses them", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("open no socket for 5 s after one is refused, then 10 s, and so on up to 5 minutes", async () => {
    const { opened, open } = socketsOpened();
    let now = 0;
    const factory = backedOffSockets(open, () => now);

    const waits = [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000, 300_000];
    factory("ws://rollup.example");
    opened[0].fail();

    for (const wait of waits) {
      const count = opened.length;
      now += wait - 1;
      factory("ws://rollup.example");
      expect(opened).toHaveLength(count);
      now += 1;
      factory("ws://rollup.example");
      expect(opened).toHaveLength(count + 1);
      opened[opened.length - 1].fail();
    }
  });

  it("fail a socket asked for during the wait at once, without opening anything", async () => {
    const { opened, open } = socketsOpened();
    let now = 0;
    const factory = backedOffSockets(open, () => now);
    factory("ws://rollup.example");
    opened[0].fail();
    now = 1_000;

    const refused = factory("ws://rollup.example");
    const errored = vi.fn();
    refused.onerror = errored;
    await vi.advanceTimersByTimeAsync(0);

    expect(opened).toHaveLength(1);
    expect(errored).toHaveBeenCalledTimes(1);
  });

  it("open a socket at once again after one whose subscription was accepted, even if it then dropped", () => {
    const { opened, open } = socketsOpened();
    let now = 0;
    const factory = backedOffSockets(open, () => now);

    factory("ws://rollup.example");
    opened[0].fail();
    now = 5_000;
    factory("ws://rollup.example");
    opened[1].open();
    opened[1].answer({ result: 7 });
    opened[1].drop();

    factory("ws://rollup.example");
    expect(opened).toHaveLength(3);
  });

  it("count a socket that opened and was then turned away as a refusal, whether by an error answer or by closing", async () => {
    const { opened, open } = socketsOpened();
    let now = 0;
    const factory = backedOffSockets(open, () => now);

    factory("ws://rollup.example");
    opened[0].open();
    opened[0].answer({ error: { code: -32000, message: "not allowed" } });
    opened[0].drop();
    now = 4_999;
    factory("ws://rollup.example");
    expect(opened).toHaveLength(1);
    now = 5_000;
    factory("ws://rollup.example");
    expect(opened).toHaveLength(2);

    opened[1].open();
    opened[1].drop();
    now = 5_000 + 9_999;
    factory("ws://rollup.example");
    expect(opened).toHaveLength(2);
    now = 5_000 + 10_000;
    factory("ws://rollup.example");
    expect(opened).toHaveLength(3);
  });

  it("pass the socket's events on to the client that opened it", () => {
    const { opened, open } = socketsOpened();
    const factory = backedOffSockets(open, () => 0);
    const socket = factory("ws://rollup.example");
    const events: string[] = [];
    socket.onopen = () => events.push("open");
    socket.onmessage = (event) => events.push(`message ${String(event.data)}`);
    socket.onclose = () => events.push("close");

    opened[0].open();
    opened[0].onmessage?.({ data: "hello" });
    opened[0].drop();

    expect(events).toEqual(["open", "message hello", "close"]);
  });
});

describe("asking for activity", () => {
  it("tells whoever is waiting for demand on every request and every socket, awake or not", () => {
    const demands = vi.fn();
    const activity = new Activity({
      lifecycle: { wake: async () => {}, sleep: async () => {} },
      idleAfterMs: 600_000,
      idleAfterLastSocketMs: 15_000,
      onError: () => {},
      onDemand: demands,
    });

    activity.touch();
    activity.touch();
    const close = activity.socketOpened();
    close();
    activity.settle();

    expect(demands).toHaveBeenCalledTimes(3);
  });
});
