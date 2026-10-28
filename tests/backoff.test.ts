import { EventEmitter } from "node:events";
import type { Connection } from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProblemLog } from "../src/logging/problem-log.js";
import { backOffReconnects, connectionTo, useReconnectBackoff } from "../src/rollup/connections.js";
import {
  MAINNET_WAKE_BACKOFF,
  ROLLUP_BACKOFF,
  backoffDelayMs,
  retryWithBackoff,
} from "../src/scheduling/backoff.js";
import { every } from "../src/scheduling/repeating.js";
import { StartUp, type StartUpOptions } from "../src/scheduling/start-up.js";

const startUpOf = (options: Omit<StartUpOptions, "cleanup"> & Partial<StartUpOptions>): StartUp =>
  new StartUp({ cleanup: async () => {}, ...options });

describe("the wait after repeated failures", () => {
  it("starts at 5 seconds, doubles each time and stops growing at 5 minutes", () => {
    const waits = [1, 2, 3, 4, 5, 6, 7, 8, 9, 20].map((failures) => backoffDelayMs(failures));

    expect(waits).toEqual([
      5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000, 300_000, 300_000,
    ]);
  });
});

describe("the wake on mainnet", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("never waits longer than 30 seconds between tries", () => {
    const waits = [1, 2, 3, 4, 5, 10, 20].map((failures) =>
      backoffDelayMs(failures, MAINNET_WAKE_BACKOFF),
    );

    expect(waits).toEqual([5_000, 10_000, 20_000, 30_000, 30_000, 30_000, 30_000]);
  });

  it("retries a wake with that cap, and a start-up too", async () => {
    const waits: number[] = [];
    let tries = 0;
    const wake = retryWithBackoff(
      async () => {
        tries += 1;
        if (tries < 7) throw new Error("refused");
      },
      {
        backoff: MAINNET_WAKE_BACKOFF,
        keepTrying: () => true,
        onFailure: (_error, _failures, retryInMs) => waits.push(retryInMs),
      },
    );
    await vi.advanceTimersByTimeAsync(5_000 + 10_000 + 20_000 + 30_000 * 3);
    expect(await wake).toBe(true);
    expect(waits).toEqual([5_000, 10_000, 20_000, 30_000, 30_000, 30_000]);

    const startUpWaits: number[] = [];
    let attempts = 0;
    const startUp = startUpOf({
      backoff: MAINNET_WAKE_BACKOFF,
      work: async () => {
        attempts += 1;
        if (attempts < 6) throw new Error("refused");
      },
      wanted: () => true,
      onFailure: (_error, _failures, retryInMs) => startUpWaits.push(retryInMs),
    });
    startUp.start();
    await vi.advanceTimersByTimeAsync(5_000 + 10_000 + 20_000 + 30_000 * 2);
    expect(startUp.ready).toBe(true);
    expect(startUpWaits).toEqual([5_000, 10_000, 20_000, 30_000, 30_000]);
  });
});

describe("retrying with a growing wait", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("tries again after each wait until the work succeeds", async () => {
    let tries = 0;
    const waits: number[] = [];
    const finished = retryWithBackoff(
      async () => {
        tries += 1;
        if (tries < 4) throw new Error("refused");
      },
      {
        keepTrying: () => true,
        onFailure: (_error, _failures, retryInMs) => waits.push(retryInMs),
      },
    );

    await vi.advanceTimersByTimeAsync(5_000 + 10_000 + 20_000);

    expect(await finished).toBe(true);
    expect(tries).toBe(4);
    expect(waits).toEqual([5_000, 10_000, 20_000]);
  });

  it("stops when it is told to, without trying once more", async () => {
    let tries = 0;
    let wanted = true;
    const finished = retryWithBackoff(
      async () => {
        tries += 1;
        throw new Error("refused");
      },
      { keepTrying: () => wanted, onFailure: () => {} },
    );
    await vi.advanceTimersByTimeAsync(0);
    wanted = false;
    await vi.advanceTimersByTimeAsync(5_000);

    expect(await finished).toBe(false);
    expect(tries).toBe(1);
  });
});

describe("start-up work", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("survives a refused first try: it reports why, is not ready, and is ready once a retry works", async () => {
    let tries = 0;
    const failures: string[] = [];
    const startUp = startUpOf({
      work: async () => {
        tries += 1;
        if (tries === 1) throw new Error("failed to get info about account: 403 Forbidden\n<html>");
      },
      wanted: () => true,
      onFailure: (error) => failures.push((error as Error).message),
    });

    startUp.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(startUp.ready).toBe(false);
    expect(startUp.problem).toBe("failed to get info about account: 403 Forbidden");
    expect(failures).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(5_000);
    await startUp.finished;

    expect(startUp.ready).toBe(true);
    expect(startUp.problem).toBeNull();
    expect(tries).toBe(2);
  });

  it("ends without being ready when it is stopped, and never retries after", async () => {
    let tries = 0;
    const startUp = startUpOf({
      work: async () => {
        tries += 1;
        throw new Error("refused");
      },
      wanted: () => true,
      onFailure: () => {},
    });
    startUp.start();
    await vi.advanceTimersByTimeAsync(0);

    startUp.stop();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await startUp.finished;

    expect(startUp.ready).toBe(false);
    expect(tries).toBe(1);
  });

  it("tries once with nobody around, and then asks the host nothing more until somebody wants the service", async () => {
    let tries = 0;
    let wanted = false;
    const startUp = startUpOf({
      work: async () => {
        tries += 1;
        throw new Error("403 Forbidden");
      },
      wanted: () => wanted,
      onFailure: () => {},
    });
    startUp.start();

    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    expect(tries).toBe(1);
    expect(startUp.problem).toBe("403 Forbidden");

    wanted = true;
    startUp.demand();
    await vi.advanceTimersByTimeAsync(0);
    expect(tries).toBe(2);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(tries).toBe(3);
  });

  it("goes on while it is wanted, with the backoff, and stops again when nobody wants it", async () => {
    let tries = 0;
    let wanted = true;
    const startUp = startUpOf({
      work: async () => {
        tries += 1;
        throw new Error("403 Forbidden");
      },
      wanted: () => wanted,
      onFailure: () => {},
    });
    startUp.start();

    await vi.advanceTimersByTimeAsync(5_000 + 10_000 + 20_000);
    expect(tries).toBe(4);

    wanted = false;
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    expect(tries).toBe(4);
  });

  it("lets a retry that is already running finish and report, so a waker can see how it ended", async () => {
    let release: () => void = () => {};
    const startUp = startUpOf({
      work: () => new Promise<void>((resolve) => (release = resolve)),
      wanted: () => true,
      onFailure: () => {},
    });
    startUp.start();

    let ended = false;
    void startUp.attemptEnded().then(() => (ended = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(ended).toBe(false);

    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(ended).toBe(true);
    expect(startUp.ready).toBe(true);
  });

  it("stops what a failed try opened before it waits for the next, and not after a try that worked", async () => {
    const events: string[] = [];
    let tries = 0;
    const startUp = startUpOf({
      work: async () => {
        tries += 1;
        events.push(`try ${tries}`);
        if (tries < 3) throw new Error("403 Forbidden");
      },
      cleanup: async () => {
        events.push("cleanup");
      },
      wanted: () => true,
      onFailure: () => events.push("failed"),
    });
    startUp.start();

    await vi.advanceTimersByTimeAsync(5_000 + 10_000);
    await startUp.finished;

    expect(events).toEqual(["try 1", "cleanup", "failed", "try 2", "cleanup", "failed", "try 3"]);
  });

  it("throws a failure no wait will cure instead of retrying it", async () => {
    const startUp = startUpOf({
      work: async () => {
        throw new Error("mainnet");
      },
      isFatal: () => true,
      wanted: () => true,
      onFailure: () => {},
    });
    startUp.start();

    await expect(startUp.finished).rejects.toThrow("mainnet");
  });
});

describe("a loop that keeps failing", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("waits at least 5 seconds after the first failure, however short its interval", async () => {
    let runs = 0;
    const loop = every(
      500,
      async () => {
        runs += 1;
        throw new Error("403");
      },
      () => {},
    );

    await vi.advanceTimersByTimeAsync(500);
    expect(runs).toBe(1);
    await vi.advanceTimersByTimeAsync(4_500);
    expect(runs).toBe(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(runs).toBe(2);
    loop.stop();
  });

  it("doubles the pause after each failure in a row, up to 30 seconds", async () => {
    let runs = 0;
    const loop = every(
      1_000,
      async () => {
        runs += 1;
        throw new Error("403");
      },
      () => {},
    );

    await vi.advanceTimersByTimeAsync(6_000);
    expect(runs).toBe(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(runs).toBe(3);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(runs).toBe(4);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(runs).toBe(5);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runs).toBe(7);
    loop.stop();
  });

  it("goes back to its own pace once a run works", async () => {
    let failing = true;
    let runs = 0;
    const recovered = vi.fn();
    const loop = every(
      1_000,
      async () => {
        runs += 1;
        if (failing) throw new Error("403");
      },
      () => {},
      recovered,
    );
    await vi.advanceTimersByTimeAsync(10_000);
    expect(recovered).not.toHaveBeenCalled();
    failing = false;
    await vi.advanceTimersByTimeAsync(8_000);
    expect(recovered).toHaveBeenCalled();

    const before = runs;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(runs - before).toBe(5);
    loop.stop();
  });
});

/** The reconnecting websocket as rpc-websockets keeps it: it waits `reconnect_interval` before each retry. */
class FakeReconnectingSocket extends EventEmitter {
  intervals: number[] = [];
  setReconnectInterval(intervalMs: number): void {
    this.intervals.push(intervalMs);
  }
  get latest(): number | undefined {
    return this.intervals[this.intervals.length - 1];
  }
}

const connectionWith = (socket: FakeReconnectingSocket): Connection =>
  ({ _rpcWebSocket: socket }) as unknown as Connection;

describe("a mainnet websocket the endpoint refuses", () => {
  it("never waits longer than 30 s for a retry", () => {
    const socket = new FakeReconnectingSocket();
    backOffReconnects(connectionWith(socket), MAINNET_WAKE_BACKOFF);
    expect(socket.latest).toBe(5_000);

    const waits: number[] = [];
    for (let attempt = 0; attempt < 7; attempt += 1) {
      socket.emit("error", new Error("403"));
      waits.push(socket.latest ?? 0);
    }

    expect(waits).toEqual([10_000, 20_000, 30_000, 30_000, 30_000, 30_000, 30_000]);
  });

  it("is what a connection opened by the service uses once mainnet is chosen", () => {
    useReconnectBackoff(MAINNET_WAKE_BACKOFF);
    try {
      const connection = connectionTo("http://rollup.example", "ws://rollup.example");
      const socket = (
        connection as unknown as {
          _rpcWebSocket: EventEmitter & { setReconnectInterval(ms: number): void };
        }
      )._rpcWebSocket;
      const waits: number[] = [];
      vi.spyOn(socket, "setReconnectInterval").mockImplementation((ms: number) => {
        waits.push(ms);
      });
      for (let attempt = 0; attempt < 6; attempt += 1) socket.emit("error", new Error("403"));
      expect(Math.max(...waits)).toBe(30_000);
    } finally {
      useReconnectBackoff(ROLLUP_BACKOFF);
    }
  });
});

describe("a websocket the endpoint refuses", () => {
  it("waits 5 s for the first retry, then twice as long after each refusal, up to 5 minutes", () => {
    const socket = new FakeReconnectingSocket();
    backOffReconnects(connectionWith(socket));
    expect(socket.latest).toBe(5_000);

    const waits: number[] = [];
    for (let attempt = 0; attempt < 9; attempt += 1) {
      socket.emit("error", new Error("Unexpected server response: 403"));
      waits.push(socket.latest ?? 0);
    }

    expect(waits).toEqual([
      10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000, 300_000, 300_000,
    ]);
  });

  it("counts a socket that opened and then dropped once, however many events say so", () => {
    const socket = new FakeReconnectingSocket();
    backOffReconnects(connectionWith(socket));
    socket.emit("open");

    socket.emit("error", new Error("reset"));
    socket.emit("close");

    expect(socket.latest).toBe(10_000);
  });

  it("goes back to 5 s once a socket has opened", () => {
    const socket = new FakeReconnectingSocket();
    backOffReconnects(connectionWith(socket));
    socket.emit("error", new Error("403"));
    socket.emit("error", new Error("403"));
    expect(socket.latest).toBe(20_000);

    socket.emit("open");

    expect(socket.latest).toBe(5_000);
  });
});

describe("logging a thing that keeps failing", () => {
  const logWith = () => {
    const lines: string[] = [];
    let now = 1_000_000;
    const log = new ProblemLog(
      (line) => lines.push(line),
      () => now,
    );
    return { log, lines, advance: (ms: number) => (now += ms) };
  };

  it("writes one line when it starts failing, not one per failure", () => {
    const { log, lines, advance } = logWith();

    for (let second = 0; second < 50; second += 1) {
      log.failed("publishing the NSOL-PERP price", new Error("403 Forbidden\n<html>"));
      advance(1_000);
    }

    expect(lines).toEqual(["sim-noirwire: publishing the NSOL-PERP price failing: 403 Forbidden"]);
  });

  it("writes a summary a minute while it goes on, and a line when it works again", () => {
    const { log, lines, advance } = logWith();

    for (let second = 0; second < 130; second += 1) {
      log.failed("reading the public accounts", new Error("403 Forbidden"));
      advance(1_000);
    }
    log.recovered("reading the public accounts");
    log.recovered("reading the public accounts");

    expect(lines).toHaveLength(4);
    expect(lines[1]).toContain("still failing, 60 more failures in the last 60 s");
    expect(lines[2]).toContain("still failing");
    expect(lines[3]).toBe(
      "sim-noirwire: reading the public accounts works again after 130 failures",
    );
  });

  it("writes an event that is not a failure as it comes", () => {
    const { log, lines } = logWith();

    log.failed("3 fills left the tape before they were read", null);
    log.failed("3 fills left the tape before they were read", null);

    expect(lines).toHaveLength(2);
  });
});
