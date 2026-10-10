import type { Connection } from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChainFeed } from "../src/rollup/chain-feed.js";
import type { Program } from "../src/rollup/program.js";
import { every, idleWithin } from "../src/scheduling/repeating.js";

const RECONNECT_MS = 1_000;
const HEARTBEAT_MS = 5_000;
const REREAD_MS = 5_000;
const A_LONG_TIME_MS = 120_000;

/**
 * The websocket half of a connection as web3.js 1.99.0 holds it: a socket
 * that is opened again a second after it is lost, a heartbeat while it is
 * open, and an unsubscribe that never yields when the socket is on its way out.
 */
class FakeConnection {
  connects = 0;
  closes = 0;
  heartbeats = 0;
  unsubscribesAsked = 0;
  subscriptions = 0;
  open = false;
  _rpcWebSocketHeartbeat: ReturnType<typeof setInterval> | null = null;

  readonly _rpcWebSocket = {
    reconnect: true,
    reconnect_timer_id: undefined as ReturnType<typeof setTimeout> | undefined,
    setAutoReconnect: (reconnect: boolean) => {
      this._rpcWebSocket.reconnect = reconnect;
    },
    close: () => {
      this.closes += 1;
      this.open = false;
    },
  };

  constructor() {
    this.connect();
  }

  private connect(): void {
    this.connects += 1;
    this.open = true;
    this._rpcWebSocketHeartbeat = setInterval(() => {
      this.heartbeats += 1;
    }, HEARTBEAT_MS);
  }

  /** The far end went away: the socket is gone and a new one is due. */
  lose(): void {
    this.open = false;
    if (!this._rpcWebSocket.reconnect) return;
    this._rpcWebSocket.reconnect_timer_id = setTimeout(() => this.connect(), RECONNECT_MS);
  }

  async _updateSubscriptions(): Promise<void> {
    this.unsubscribesAsked += 1;
    if (!this.open) this.connect();
  }

  get asConnection(): Connection {
    return this as unknown as Connection;
  }
}

const NO_PRICE = { price: 0n, publishTimeSeconds: 0 };
const NO_TAPE = { lastSequence: 0n, fills: [] };
const NO_STATS = { orders: 0n, fills: 0n, openInterest: [] };

/** A program whose reads answer at once until `hang` is called, and never after. */
const fakeProgram = (connection: FakeConnection) => {
  let hanging = false;
  const answer = <T>(value: T): Promise<T> =>
    hanging ? new Promise<T>(() => {}) : Promise.resolve(value);
  const subscribe = () => {
    connection.subscriptions += 1;
    return () => connection._updateSubscriptions();
  };
  const reads = { count: 0 };
  const program = {
    price: () => {
      reads.count += 1;
      return answer(NO_PRICE);
    },
    tape: () => answer(NO_TAPE),
    stats: () => answer(NO_STATS),
    subscribePrice: subscribe,
    subscribeTape: subscribe,
    subscribeStats: subscribe,
  } as unknown as Program;
  return { program, reads, hang: () => (hanging = true) };
};

const startedFeed = async () => {
  const connection = new FakeConnection();
  const { program, reads, hang } = fakeProgram(connection);
  const feed = new ChainFeed(program, connection.asConnection, [0, 1], {
    onPrice: () => {},
    onTape: () => {},
    onStats: () => {},
    onError: () => {},
  });
  await feed.start();
  return { connection, feed, reads, hang };
};

describe("stopping", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const expectNothingLeftRunning = async (
    connection: FakeConnection,
    reads: { count: number },
  ): Promise<void> => {
    const before = {
      connects: connection.connects,
      reads: reads.count,
      beats: connection.heartbeats,
    };
    await vi.advanceTimersByTimeAsync(A_LONG_TIME_MS);
    expect(connection.connects).toBe(before.connects);
    expect(reads.count).toBe(before.reads);
    expect(connection.heartbeats).toBe(before.beats);
    expect(connection.unsubscribesAsked).toBe(0);
    expect(connection.open).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  };

  it("closes the chain feed's socket, ends its timers and asks for no unsubscribe", async () => {
    const { connection, feed, reads } = await startedFeed();
    expect(connection.subscriptions).toBe(5);

    feed.stop();

    expect(connection.closes).toBe(1);
    await expectNothingLeftRunning(connection, reads);
  });

  it("is safe to ask for twice", async () => {
    const { connection, feed, reads } = await startedFeed();
    feed.stop();
    feed.stop();
    await expectNothingLeftRunning(connection, reads);
  });

  it("does not reconnect when it is asked for while the socket is lost and a reconnect is due", async () => {
    const { connection, feed, reads } = await startedFeed();
    connection.lose();
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    feed.stop();

    expect(connection.connects).toBe(1);
    await expectNothingLeftRunning(connection, reads);
  });

  it("does not wait for a read that hangs, and starts no other after it", async () => {
    const { connection, feed, reads, hang } = await startedFeed();
    hang();
    await vi.advanceTimersByTimeAsync(REREAD_MS);
    const readsInFlight = reads.count;
    expect(readsInFlight).toBeGreaterThan(2);

    feed.stop();

    expect(reads.count).toBe(readsInFlight);
    await expectNothingLeftRunning(connection, reads);
  });

  it("subscribes to nothing when it is asked for before the feed's first read has ended", async () => {
    const connection = new FakeConnection();
    const { program, reads, hang } = fakeProgram(connection);
    hang();
    const feed = new ChainFeed(program, connection.asConnection, [0], {
      onPrice: () => {},
      onTape: () => {},
      onStats: () => {},
      onError: () => {},
    });
    void feed.start();

    feed.stop();

    expect(connection.subscriptions).toBe(0);
    await expectNothingLeftRunning(connection, reads);
  });

  it("gives the loops' runs in flight a bounded time and then abandons them", async () => {
    let finishQuickRun = (): void => {};
    const hanging = every(
      1_000,
      () => new Promise<void>(() => {}),
      () => {},
    );
    const quick = every(
      1_000,
      () =>
        new Promise<void>((resolve) => {
          finishQuickRun = resolve;
        }),
      () => {},
    );
    await vi.advanceTimersByTimeAsync(1_000);
    hanging.stop();
    hanging.stop();
    quick.stop();

    let quickIdle = false;
    void idleWithin([quick], 2_000).then(() => (quickIdle = true));
    finishQuickRun();
    await vi.advanceTimersByTimeAsync(0);
    expect(quickIdle).toBe(true);
    expect(vi.getTimerCount()).toBe(0);

    let abandoned = false;
    void idleWithin([hanging, quick], 2_000).then(() => (abandoned = true));
    await vi.advanceTimersByTimeAsync(1_999);
    expect(abandoned).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(abandoned).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
