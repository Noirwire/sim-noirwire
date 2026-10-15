import { type Connection, Keypair } from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MARKETS } from "../src/engine/markets.js";
import type { ChainMarket } from "../src/rollup/chain-types.js";
import { ChainFeed } from "../src/rollup/chain-feed.js";
import { Session } from "../src/rollup/connections.js";
import { MAX_SOURCE_AGE_MS, PricePublisher } from "../src/rollup/price-publisher.js";
import type { Program } from "../src/rollup/program.js";
import { RollupMarket } from "../src/rollup/rollup-market.js";
import { ProgramRefused } from "../src/rollup/transactions.js";
import { dollars } from "./helpers.js";

const PERP: ChainMarket = {
  marketId: 0,
  kind: "perp",
  tick: 100n,
  baseLot: 1_000_000n,
  minNotional: 1_000_000n,
  bandBps: 400,
  initialMarginBps: 1_000,
  maxMoveBps: 250,
  maxPriceAgeSeconds: 10,
  fundingIntervalSeconds: 60,
  baseToken: 1,
  quoteToken: 0,
};

const NOW_MS = 1_000_000_000;

/** A market on chain at 150 whose source last said 151 at `sourceAtMs`. */
const marketWithSource = (index: number, sourceAtMs: number | null): RollupMarket => {
  const market = new RollupMarket(MARKETS[index], { ...PERP, marketId: index }, 9);
  market.acceptPrice({ price: 150_000n, publishTimeSeconds: 1_000 });
  if (sourceAtMs !== null) market.setTarget(dollars(151), sourceAtMs);
  return market;
};

/** A promise the test settles by hand. */
const gate = () => {
  let open: () => void = () => {};
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { opened, open };
};

interface Controls {
  clockSeconds: () => Promise<number>;
  publishPrices: (marketIds: number[]) => Promise<void>;
  updateFunding: () => Promise<void>;
}

const publisherOf = (
  markets: RollupMarket[],
  controls: Partial<Controls> = {},
  maxSourceAgeMs = 30_000,
) => {
  const sent = { clock: 0, bundles: [] as number[][], funding: 0 };
  const errors: string[] = [];
  const unreachable = { count: 0 };
  let clock = 1_001;
  const publisher = new PricePublisher({
    program: {
      clockSeconds: async () => {
        sent.clock += 1;
        return controls.clockSeconds ? controls.clockSeconds() : clock++;
      },
      publishPrices: async (_connection, _oracle, prices) => {
        const marketIds = prices.map(({ marketId }) => marketId);
        sent.bundles.push(marketIds);
        await controls.publishPrices?.(marketIds);
      },
      updateFunding: async () => {
        sent.funding += 1;
        await controls.updateFunding?.();
      },
    },
    oracle: Session.of({} as Connection),
    oracleKey: Keypair.generate(),
    markets,
    intervalMs: 5_000,
    maxSourceAgeMs,
    onError: (what) => errors.push(what),
    onRecovered: () => {},
    onUnreachable: () => (unreachable.count += 1),
  });
  return { publisher, sent, errors, unreachable };
};

describe("a price whose source has gone quiet", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
  });
  afterEach(() => vi.useRealTimers());

  it("is published while its source is recent, and refused once the source is older than the limit", async () => {
    const market = marketWithSource(0, NOW_MS);
    const { publisher, sent } = publisherOf([market]);

    await publisher.publishNow(0);
    expect(sent.bundles).toEqual([[0]]);

    await vi.advanceTimersByTimeAsync(30_001);
    await expect(publisher.publishNow(0)).rejects.toThrow("NSOL-PERP");
    expect(sent.bundles).toEqual([[0]]);
    expect(sent.clock).toBe(2);

    market.setTarget(dollars(151), Date.now());
    await publisher.publishNow(0);
    expect(sent.bundles).toEqual([[0], [0]]);
  });

  it("is refused for a market whose source has never answered", async () => {
    const market = marketWithSource(0, null);
    const { publisher, sent } = publisherOf([market]);

    await expect(publisher.publishNow(0)).rejects.toThrow("NSOL-PERP");

    expect(sent.bundles).toEqual([]);
  });

  it("is refused on a wake when it was delivered before the wake, though it is within the age limit", async () => {
    const market = marketWithSource(0, NOW_MS - 25_000);
    const { publisher, sent } = publisherOf([market]);

    await expect(publisher.publishNow(NOW_MS - 1)).rejects.toThrow("NSOL-PERP");
    expect(sent.bundles).toEqual([]);

    market.setTarget(dollars(151), NOW_MS);
    await publisher.publishNow(NOW_MS - 1);
    expect(sent.bundles).toEqual([[0]]);
  });
});

const refusedByTheProgram = (): ProgramRefused =>
  new ProgramRefused({ InstructionError: [0, { Custom: 1 }] });

describe("a rollup that stops answering", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
  });
  afterEach(() => vi.useRealTimers());

  it("is reported once after two rounds in a row fail, and not again while it goes on failing", async () => {
    const { publisher, unreachable } = publisherOf([marketWithSource(0, NOW_MS)], {
      clockSeconds: async () => {
        throw new Error("403 Forbidden");
      },
    });
    publisher.start();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(unreachable.count).toBe(0);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(unreachable.count).toBe(1);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(unreachable.count).toBe(1);
    publisher.stop();
  });

  it("is reported when there is no price to publish and the rollup refuses its clock read", async () => {
    const { publisher, unreachable } = publisherOf([marketWithSource(0, null)], {
      clockSeconds: async () => {
        throw new Error("403 Forbidden");
      },
    });
    publisher.start();

    await vi.advanceTimersByTimeAsync(10_000);

    expect(unreachable.count).toBe(1);
    publisher.stop();
  });

  it("is never reported for missing source prices alone while the rollup answers", async () => {
    const { publisher, unreachable, sent } = publisherOf([marketWithSource(0, null)]);
    publisher.start();

    await vi.advanceTimersByTimeAsync(60_000);

    expect(sent.clock).toBeGreaterThan(5);
    expect(sent.bundles).toEqual([]);
    expect(unreachable.count).toBe(0);
    publisher.stop();
  });

  it("is not reported when the failed rounds are not in a row", async () => {
    let failing = true;
    const { publisher, unreachable } = publisherOf([marketWithSource(0, NOW_MS)], {
      clockSeconds: async () => {
        if (failing) throw new Error("403 Forbidden");
        return 2_000;
      },
    });
    publisher.start();

    await vi.advanceTimersByTimeAsync(5_000);
    failing = false;
    await vi.advanceTimersByTimeAsync(5_000);
    failing = true;
    await vi.advanceTimersByTimeAsync(5_000);

    expect(unreachable.count).toBe(0);
    publisher.stop();
  });

  it("is not reported for a market the program keeps refusing", async () => {
    const { publisher, unreachable } = publisherOf([marketWithSource(0, NOW_MS)], {
      publishPrices: async () => {
        throw refusedByTheProgram();
      },
    });
    publisher.start();

    await vi.advanceTimersByTimeAsync(60_000);

    expect(unreachable.count).toBe(0);
    publisher.stop();
  });
});

describe("a bundle the program refuses", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
  });
  afterEach(() => vi.useRealTimers());

  const markets = () => [
    marketWithSource(0, NOW_MS),
    marketWithSource(1, NOW_MS),
    marketWithSource(2, NOW_MS),
  ];
  /** The program refuses any transaction that holds market 1. */
  const refusingMarketOne = async (marketIds: number[]): Promise<void> => {
    if (marketIds.includes(1)) throw refusedByTheProgram();
  };

  it("is sent again market by market in the same round, so the healthy ones still advance", async () => {
    const { publisher, sent, errors } = publisherOf(markets(), {
      publishPrices: refusingMarketOne,
    });
    publisher.start();

    await vi.advanceTimersByTimeAsync(5_000);

    expect(sent.bundles).toEqual([[0, 1, 2], [0], [1], [2]]);
    expect(sent.clock).toBe(1);
    expect(errors).toEqual(["publishing the NNVDA-PERP price"]);
    publisher.stop();
  });

  it("leaves the market the program keeps refusing to back off on its own, and publishes the others every round", async () => {
    const { publisher, sent } = publisherOf(markets(), { publishPrices: refusingMarketOne });
    publisher.start();

    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(sent.bundles.slice(4)).toEqual([[0, 2]]);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(sent.bundles.slice(5)).toEqual([[0, 1, 2], [0], [1], [2]]);
    publisher.stop();
  });

  it("is not isolated when the failure is the network's, which every market would meet alone too", async () => {
    const { publisher, sent } = publisherOf(markets(), {
      publishPrices: async () => {
        throw new Error("403 Forbidden");
      },
    });

    await expect(publisher.publishNow(0)).rejects.toThrow("403 Forbidden");

    expect(sent.bundles).toEqual([[0, 1, 2]]);
  });

  it("fails a wake naming the market, though the others went through", async () => {
    const { publisher, sent } = publisherOf(markets(), { publishPrices: refusingMarketOne });

    await expect(publisher.publishNow(0)).rejects.toThrow("NNVDA-PERP");

    expect(sent.bundles).toEqual([[0, 1, 2], [0], [1], [2]]);
  });
});

describe("a round that takes too long", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
  });
  afterEach(() => vi.useRealTimers());

  it("is given up a second before the next is due, and the next starts on time", async () => {
    const market = marketWithSource(0, NOW_MS);
    let calls = 0;
    const { publisher, sent, errors } = publisherOf([market], {
      publishPrices: () => {
        calls += 1;
        return calls === 1 ? new Promise<void>(() => {}) : Promise.resolve();
      },
    });
    publisher.start();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(sent.bundles).toEqual([[0]]);
    await vi.advanceTimersByTimeAsync(3_999);
    expect(errors).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(errors).toEqual(["publishing the prices"]);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(sent.bundles).toEqual([[0], [0]]);
    expect(sent.clock).toBe(2);
    publisher.stop();
  });

  it("keeps its state with what landed: a send that succeeds after the round was given up is recorded, and no further send starts", async () => {
    const markets = [marketWithSource(0, NOW_MS), marketWithSource(1, NOW_MS)];
    const single = gate();
    const { publisher, sent, errors } = publisherOf(markets, {
      publishPrices: async (marketIds) => {
        if (marketIds.length === 2) throw refusedByTheProgram();
        if (marketIds[0] === 0) await single.opened;
      },
    });
    publisher.start();

    await vi.advanceTimersByTimeAsync(9_000);
    expect(errors).toEqual(["publishing the prices"]);
    expect(publisher.lastPublishedAtMs(markets[0])).toBe(0);

    single.open();
    await vi.advanceTimersByTimeAsync(0);

    expect(publisher.lastPublishedAtMs(markets[0])).toBe(Date.now());
    expect(sent.bundles).toEqual([[0, 1], [0]]);
    publisher.stop();
  });

  it("sends nothing from a round that was given up while it waited for the rollup's clock", async () => {
    const market = marketWithSource(0, NOW_MS);
    const clock = gate();
    const { publisher, sent } = publisherOf([market], {
      clockSeconds: async () => {
        await clock.opened;
        return 1_001;
      },
    });
    publisher.start();

    await vi.advanceTimersByTimeAsync(9_000);
    clock.open();
    await vi.advanceTimersByTimeAsync(0);

    expect(sent.bundles).toEqual([]);
    publisher.stop();
  });
});

describe("the age of a source price", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
  });
  afterEach(() => vi.useRealTimers());

  it("is held to the ten seconds the program calls a price fresh", () => {
    expect(MAX_SOURCE_AGE_MS).toBe(10_000);
  });

  it("keeps a market whose source is older than that out of the round, to go stale honestly", async () => {
    const markets = [marketWithSource(0, NOW_MS), marketWithSource(1, NOW_MS - 10_001)];
    const { publisher, sent, errors } = publisherOf(markets, {}, 10_000);
    publisher.start();

    await vi.advanceTimersByTimeAsync(5_000);

    expect(sent.bundles).toEqual([[0]]);
    expect(errors).toEqual(["publishing the NNVDA-PERP price"]);
    publisher.stop();
  });
});

describe("publishing every market", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
  });
  afterEach(() => vi.useRealTimers());

  it("takes one transaction and one read of the rollup's clock for all of them", async () => {
    const markets = [marketWithSource(0, NOW_MS), marketWithSource(1, NOW_MS)];
    const { publisher, sent } = publisherOf(markets);

    await publisher.publishNow(0);

    expect(sent.bundles).toEqual([[0, 1]]);
    expect(sent.clock).toBe(1);
  });

  it("fails a wake, naming the market, when the rollup refuses the transaction", async () => {
    const markets = [marketWithSource(0, NOW_MS), marketWithSource(1, NOW_MS)];
    const { publisher } = publisherOf(markets, {
      publishPrices: async () => {
        throw new Error("403 Forbidden");
      },
    });

    await expect(publisher.publishNow(0)).rejects.toThrow("403 Forbidden");
  });

  it("fails a wake when a market has no recent price from the source, though the others went through", async () => {
    const markets = [marketWithSource(0, NOW_MS), marketWithSource(1, NOW_MS - 31_000)];
    const { publisher, sent, errors } = publisherOf(markets);

    await expect(publisher.publishNow(0)).rejects.toThrow("NNVDA-PERP");

    expect(sent.bundles).toEqual([[0]]);
    expect(errors).toEqual(["publishing the NNVDA-PERP price"]);
  });

  it("leaves a market out of a round, and reports it, without holding back the others on the loop", async () => {
    const markets = [marketWithSource(0, NOW_MS), marketWithSource(1, NOW_MS - 31_000)];
    const { publisher, sent, errors } = publisherOf(markets);
    publisher.start();

    await vi.advanceTimersByTimeAsync(5_000);

    expect(sent.bundles).toEqual([[0]]);
    expect(errors).toEqual(["publishing the NNVDA-PERP price"]);
    publisher.stop();
  });
});

describe("stopping the publisher", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
  });
  afterEach(() => vi.useRealTimers());

  it("sends nothing more from a publish that was waiting for the rollup's clock, and says when it has ended", async () => {
    const market = marketWithSource(0, NOW_MS);
    const clock = gate();
    const { publisher, sent } = publisherOf([market], {
      clockSeconds: async () => {
        await clock.opened;
        return 1_001;
      },
    });
    const publishing = publisher.publishNow(0).catch(() => {});
    await vi.advanceTimersByTimeAsync(0);

    publisher.stop();
    let idle = false;
    void publisher.idle().then(() => (idle = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(idle).toBe(false);

    clock.open();
    await publishing;
    await vi.advanceTimersByTimeAsync(0);

    expect(sent.bundles).toEqual([]);
    expect(idle).toBe(true);
  });

  it("waits for a publish in flight and for the funding update it started before it is idle", async () => {
    const market = marketWithSource(0, NOW_MS);
    const publish = gate();
    const funding = gate();
    const { publisher, sent } = publisherOf([market], {
      publishPrices: () => publish.opened,
      updateFunding: () => funding.opened,
    });
    void publisher.publishNow(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(sent.bundles).toEqual([[0]]);

    publish.open();
    await vi.advanceTimersByTimeAsync(0);
    expect(sent.funding).toBe(1);
    publisher.stop();
    let idle = false;
    void publisher.idle().then(() => (idle = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(idle).toBe(false);

    funding.open();
    await vi.advanceTimersByTimeAsync(0);
    expect(idle).toBe(true);
  });

  it("starts no funding update after it was told to stop", async () => {
    const market = marketWithSource(0, NOW_MS);
    const publish = gate();
    const { publisher, sent } = publisherOf([market], { publishPrices: () => publish.opened });
    const publishing = publisher.publishNow(0);
    await vi.advanceTimersByTimeAsync(0);

    publisher.stop();
    publish.open();
    await publishing;
    await publisher.idle();

    expect(sent.funding).toBe(0);
  });
});

/** The websocket half of a connection, enough for `hangUp`. */
const fakeConnection = (): Connection =>
  ({
    _rpcWebSocketHeartbeat: null,
    _updateSubscriptions: async () => {},
    _rpcWebSocket: { setAutoReconnect: () => {}, close: () => {}, reconnect_timer_id: undefined },
  }) as unknown as Connection;

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
      subscribePrice: () => () => {},
      subscribeTape: () => () => {},
      subscribeStats: () => () => {},
    } as unknown as Program;
    const feed = new ChainFeed(program, fakeConnection, [0, 1], {
      onPrice: () => {},
      onTape: () => {},
      onStats: () => {},
      onError: () => {},
      onRecovered: () => {},
    });
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
