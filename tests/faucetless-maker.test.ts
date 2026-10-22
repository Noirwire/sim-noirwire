import { TransactionFailed } from "@noirwire/orderbook";
import { Keypair } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";
import { makerTraderKey } from "../src/bots/bot-traders.js";
import { HouseMaker, QuotesHeld, ladderOrders } from "../src/bots/house-maker.js";
import { loadConfig } from "../src/config/config.js";
import { ManualClock } from "../src/engine/clock.js";
import { MARKETS } from "../src/engine/markets.js";
import type { MarketInfo, NewOrder, Venue } from "../src/engine/types.js";
import { ProblemLog } from "../src/logging/problem-log.js";
import { BotAccounts } from "../src/rollup/bot-accounts.js";
import type {
  ChainExchange,
  ChainMarket,
  KeyCheckpoint,
  PlaceOutcome,
} from "../src/rollup/chain-types.js";
import { Session, connectionTo } from "../src/rollup/connections.js";
import { noteMakerQuote } from "../src/rollup/maker-quotes.js";
import { type Program, ProgramTrader } from "../src/rollup/program.js";
import { RollupMarket } from "../src/rollup/rollup-market.js";
import { type RollupSettings, loadDeployment } from "../src/rollup/settings.js";
import { rollupWiring } from "../src/wiring/rollup-wiring.js";
import { dollars } from "./helpers.js";

const PERP = "NSOL-PERP";
const MAKER = makerTraderKey(PERP);
const keyOf = (keypair: Keypair): string => JSON.stringify([...keypair.secretKey]);
const usdc = () => ({
  index: 0,
  symbol: "USDC",
  decimals: 6,
  mint: Keypair.generate().publicKey.toBase58(),
  custodyNonce: "3",
});

describe("a bot's top-up on a deployment without a faucet", () => {
  const owner = Keypair.generate();

  const botsHolding = (collateral: bigint) => {
    const deposits = vi.fn();
    const trader = {
      address: owner.publicKey.toBase58(),
      checkpoint: { indices: [], nextIndex: 0 } as KeyCheckpoint,
      hasUnsettled: false,
      close: () => {},
      sync: async () => true,
      view: async () => ({ collateral, spot: [{ available: 0n, locked: 0n }] }),
    };
    const program = {
      openOwnTrader: async () => trader as unknown as ProgramTrader,
      deposit: deposits,
    } as unknown as Program;
    const bots = new BotAccounts({
      program,
      settings: {
        rollupRpcUrl: "http://rollup.example",
        gate: Keypair.generate(),
        faucet: null,
        deployment: { tokens: [usdc()] },
      } as unknown as RollupSettings,
      bots: [{ key: MAKER, owner, tradesPerps: true, tradesSpot: false }],
      gate: Session.of({} as never),
      faucet: null,
      keyCheckpoints: {},
      syncMarketId: 0,
      life: () => undefined,
    });
    return { bots, deposits };
  };

  it("throws, naming the owner key a deposit has to credit, while the seat holds nothing", async () => {
    const { bots, deposits } = botsHolding(0n);

    await expect(bots.topUp(MAKER, "nUSD", dollars(200_000))).rejects.toThrow(
      owner.publicKey.toBase58(),
    );
    await expect(bots.topUp(MAKER, "nUSD", dollars(200_000))).rejects.toThrow("no faucet");
    expect(bots.allFunded()).toBe(false);
    expect(deposits).not.toHaveBeenCalled();
  });

  it("counts the bot as funded once the seat holds any collateral, and deposits nothing", async () => {
    const { bots, deposits } = botsHolding(1n);

    await bots.topUp(MAKER, "nUSD", dollars(200_000));

    expect(bots.allFunded()).toBe(true);
    expect(deposits).not.toHaveBeenCalled();
  });
});

describe("a quote the program refuses", () => {
  const traderRefusedWith = (code: number): ProgramTrader => {
    const trader = new ProgramTrader(
      "http://rollup.example",
      Keypair.generate(),
      {} as never,
      Keypair.generate().publicKey,
      connectionTo("http://rollup.example"),
    );
    const refusing = {
      placeOrder: async () => {
        throw new TransactionFailed("signature", { InstructionError: [0, { Custom: code }] });
      },
      close: () => {},
    };
    (trader as unknown as { client: unknown }).client = refusing;
    return trader;
  };
  const quote = {
    side: "buy" as const,
    type: "postOnly" as const,
    price: 100_000n,
    size: 10n,
    reduceOnly: false,
    secret: new Uint8Array(32),
  };

  it("comes back failed with the program's error number, its name and what MakerNotListed means", async () => {
    const outcome = await traderRefusedWith(6091).place(0, quote);

    expect(outcome.status).toBe("failed");
    expect(outcome.programError).toBe(6091);
    expect(outcome.reason).toContain("MakerNotListed (6091)");
    expect(outcome.reason).toContain("not listed as a maker");
  });

  it("names any other error by its number and name", async () => {
    const outcome = await traderRefusedWith(6081).place(0, quote);

    expect(outcome).toMatchObject({ status: "failed", programError: 6081 });
    expect(outcome.reason).toBe("QuoteGuardTripped (6081)");
  });
});

describe("a house maker's refused quotes in the log", () => {
  const owner = Keypair.generate().publicKey.toBase58();
  const failed = (programError: number): PlaceOutcome => ({
    status: "failed",
    filled: 0n,
    rested: 0n,
    sendToResultMs: 0,
    programError,
    reason: `program error ${programError}`,
  });
  const rested: PlaceOutcome = { status: "rested", filled: 0n, rested: 10n, sendToResultMs: 400 };

  const logged = () => {
    const lines: string[] = [];
    let now = 0;
    const log = new ProblemLog(
      (line) => lines.push(line),
      () => now,
    );
    const problems = {
      onError: (what: string, error: unknown) => log.failed(what, error),
      onRecovered: (what: string) => log.recovered(what),
    };
    return { lines, problems, advance: (ms: number) => (now += ms) };
  };

  it("logs MakerNotListed with the owner key the admin lists, and recovers once a quote executes", () => {
    const { lines, problems } = logged();

    noteMakerQuote(problems, MAKER, PERP, owner, failed(6091));
    noteMakerQuote(problems, MAKER, PERP, owner, rested);

    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("MakerNotListed (6091)");
    expect(lines[0]).toContain(owner);
    expect(lines[0]).toContain("set_seat_access");
    expect(lines[1]).toContain(`${MAKER} quoting on ${PERP} works again`);
  });

  it("logs any other refusal by number and name, once and then once a minute, however many quotes are refused", () => {
    const { lines, problems, advance } = logged();

    for (let quote = 0; quote < 10; quote += 1) {
      noteMakerQuote(problems, MAKER, PERP, owner, failed(6048));
    }
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("PositionCapExceeded (6048)");
    expect(lines[0]).toContain(owner);

    advance(60_000);
    noteMakerQuote(problems, MAKER, PERP, owner, failed(6024));
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("still failing");
    expect(lines[1]).toContain("InsufficientMargin (6024)");
    expect(lines[1]).toContain("Deposit more");
  });

  it("logs a quote the client refused before signing, and nothing for one that only ran out of time", () => {
    const { lines, problems } = logged();

    noteMakerQuote(problems, MAKER, PERP, owner, {
      status: "expired",
      filled: 0n,
      rested: 0n,
      sendToResultMs: 0,
    });
    expect(lines).toHaveLength(0);

    noteMakerQuote(problems, MAKER, PERP, owner, {
      status: "invalid",
      filled: 0n,
      rested: 0n,
      sendToResultMs: 0,
      reason: "NotionalTooSmall",
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("NotionalTooSmall");
  });
});

describe("the rollup wiring on a deployment without a faucet", () => {
  const gate = Keypair.generate();
  const seed = "ab".repeat(32);
  const configWith = (flags: Record<string, string>) =>
    loadConfig({
      VENUE: "rollup",
      SOLANA_RPC_URL: "http://127.0.0.1:8899",
      ROLLUP_RPC_URL: "http://127.0.0.1:6699",
      ROLLUP_WS_URL: "ws://127.0.0.1:6700",
      DEPLOYMENT_JSON: JSON.stringify({
        network: "devnet",
        programId: Keypair.generate().publicKey.toBase58(),
        gate: gate.publicKey.toBase58(),
        depositUrl: "http://127.0.0.1:6699",
        tokens: [usdc()],
        markets: [{ id: 0, symbol: "SOL-PERP", kind: "perp", baseDecimals: 9 }],
      }),
      GATE_SECRET_KEY: keyOf(gate),
      BOT_TRADER_SEEDS: seed,
      ...flags,
    } as NodeJS.ProcessEnv);
  const wire = (flags: Record<string, string>, onError = vi.fn()) =>
    rollupWiring({
      config: configWith(flags),
      data: {} as never,
      snapshot: null,
      usersEverOpened: () => 0,
      onError,
      onRecovered: () => {},
      onUnreachable: () => {},
    });

  it("refuses to start while the noise takers or the liquidator are on", () => {
    expect(() => wire({ NOISE_TAKERS_ENABLED: "1", LIQUIDATOR_ENABLED: "0" })).toThrow("no faucet");
    expect(() => wire({ NOISE_TAKERS_ENABLED: "0", LIQUIDATOR_ENABLED: "1" })).toThrow(
      "LIQUIDATOR_ENABLED=0",
    );
  });

  it("starts with the makers alone, and logs each maker's seat owner key at once", () => {
    const onError = vi.fn();

    const wiring = wire({ NOISE_TAKERS_ENABLED: "0", LIQUIDATOR_ENABLED: "0" }, onError);

    expect(wiring.botMarkets.map((market) => market.id)).toEqual([PERP]);
    const owner = Keypair.fromSeed(Buffer.from(seed, "hex")).publicKey.toBase58();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toContain(`the ${PERP} maker's seat owner is ${owner}`);
    expect(onError.mock.calls[0]?.[1]).toBeNull();
  });
});

describe("a deployment description written before custody nonces", () => {
  it("is refused in a sentence that says what is stale and where, not a raw dump", () => {
    const stale = JSON.stringify({
      network: "devnet",
      programId: Keypair.generate().publicKey.toBase58(),
      gate: Keypair.generate().publicKey.toBase58(),
      depositUrl: "https://rollup.example",
      tokens: [{ ...usdc(), custodyNonce: undefined }],
      markets: [],
    });

    expect(() => loadDeployment({ DEPLOYMENT_JSON: stale })).toThrow(
      /names no custody nonce.*retired here.*tokens\.0\.custodyNonce/,
    );
  });
});

const PERP_ON_CHAIN: ChainMarket = {
  marketId: 0,
  kind: "perp",
  tick: 10n,
  baseLot: 1_000_000n,
  minNotional: 1_000_000n,
  bandBps: 400,
  initialMarginBps: 1_000,
  maxMoveBps: 250,
  maxPriceAgeSeconds: 90,
  fundingIntervalSeconds: 3_600,
  baseToken: 0,
  quoteToken: 0,
  positionCap: 22_222n,
  status: "active",
  oracleHealth: "healthy",
};
const PUBLISHED_AT_S = 1_000_000;
const OPEN: ChainExchange = { paused: false, quoteGuardOkUntilSeconds: PUBLISHED_AT_S + 180 };

const marketWith = (over: Partial<ChainMarket> = {}): RollupMarket => {
  const market = new RollupMarket(MARKETS[0], { ...PERP_ON_CHAIN, ...over }, 9);
  market.acceptPrice({ price: 106_603n, publishTimeSeconds: PUBLISHED_AT_S });
  return market;
};

describe("whether the program would take a house maker's quote", () => {
  const at = (seconds: number) => (PUBLISHED_AT_S + seconds) * 1_000;

  it("takes it on an open market with a fresh mark and a passing USDC guard", () => {
    expect(marketWith().quotesRefusedBecause(at(5), OPEN)).toBeNull();
    expect(marketWith({ oracleHealth: "settling" }).quotesRefusedBecause(at(5), OPEN)).toBeNull();
  });

  it("refuses it on a stale mark, by the market's own age limit", () => {
    expect(marketWith().quotesRefusedBecause(at(89), OPEN)).toBeNull();
    expect(marketWith().quotesRefusedBecause(at(90), OPEN)).toContain("StalePrice, 6038");
  });

  it("refuses it on a paused, reduce-only or dislocated market, and on a paused exchange", () => {
    expect(marketWith({ status: "paused" }).quotesRefusedBecause(at(5), OPEN)).toContain("6031");
    expect(marketWith({ status: "reduceOnly" }).quotesRefusedBecause(at(5), OPEN)).toContain(
      "6032",
    );
    expect(marketWith({ oracleHealth: "dislocated" }).quotesRefusedBecause(at(5), OPEN)).toContain(
      "6077",
    );
    expect(marketWith().quotesRefusedBecause(at(5), { ...OPEN, paused: true })).toContain("6030");
  });

  it("refuses it on a perpetual once the USDC guard has tripped, and leaves an unbound guard to the program", () => {
    const tripped = { ...OPEN, quoteGuardOkUntilSeconds: PUBLISHED_AT_S };
    expect(marketWith().quotesRefusedBecause(at(5), tripped)).toContain("6081");
    expect(marketWith({ kind: "spot" }).quotesRefusedBecause(at(5), tripped)).toBeNull();
    const unbound = { ...OPEN, quoteGuardOkUntilSeconds: null };
    expect(marketWith().quotesRefusedBecause(at(5), unbound)).toBeNull();
  });

  it("tells the maker why, and the position cap in base units, through the market's info", () => {
    const info = marketWith({ status: "paused" }).info(at(5), null, OPEN);

    expect(info.quotesRefusedBecause).toContain("paused");
    expect(info.positionCap).toBe(dollars(22.222));
    expect(marketWith().info(at(5), null, OPEN).quotesRefusedBecause).toBeUndefined();
  });

  it("follows a fresh reading of the market account", () => {
    const market = marketWith();
    market.acceptMarket({ ...PERP_ON_CHAIN, status: "reduceOnly" });
    expect(market.quotesRefusedBecause(at(5), OPEN)).toContain("reduce-only");
  });
});

const SHAPE = {
  market: PERP,
  levels: 5,
  spreadBps: 15,
  levelStepBps: 5,
  baseSizePerLevel: dollars(3.75),
  maxSkewBps: 20,
  lotSize: dollars(0.001),
};

const sideTotal = (orders: NewOrder[], side: NewOrder["side"]): bigint =>
  orders.filter((order) => order.side === side).reduce((sum, order) => sum + order.size, 0n);

describe("a house maker's ladder under the venue's position cap", () => {
  const ladder = { mark: dollars(106.603), tickSize: dollars(0.01), positionLimit: dollars(500) };

  it("stops each side at the cap, trimming the last level that fits to the room left", () => {
    const orders = ladderOrders(SHAPE, { ...ladder, position: 0n, positionCap: dollars(22.222) });

    expect(sideTotal(orders, "buy")).toBe(dollars(22.222));
    expect(sideTotal(orders, "sell")).toBe(dollars(22.222));
    expect(orders.filter((order) => order.side === "buy").map((order) => order.size)).toEqual([
      dollars(3.75),
      dollars(7.5),
      dollars(10.972),
    ]);
  });

  it("counts a position on a side against that side's room only", () => {
    const orders = ladderOrders(SHAPE, {
      ...ladder,
      position: dollars(10),
      positionCap: dollars(22.222),
    });

    expect(sideTotal(orders, "buy")).toBeLessThanOrEqual(dollars(12.222));
    expect(sideTotal(orders, "sell")).toBe(dollars(22.222));
  });

  it("leaves out a remainder smaller than a first level, and quotes the whole ladder with no cap", () => {
    const tight = ladderOrders(SHAPE, { ...ladder, position: 0n, positionCap: dollars(5) });
    expect(tight.map((order) => order.size)).toEqual([dollars(3.75), dollars(3.75)]);

    const uncapped = ladderOrders(SHAPE, { ...ladder, position: 0n });
    expect(sideTotal(uncapped, "buy")).toBe(dollars(3.75 * 15));
  });
});

describe("a house maker on a venue that would refuse its quotes", () => {
  const options = {
    ...SHAPE,
    kind: "perp" as const,
    baseToken: "SOL",
    quoteToken: "nUSD",
    requoteThresholdBps: 12,
    requoteIntervalMs: 90_000,
    positionLimitNotional: dollars(50_000),
    startingQuoteBalance: dollars(200_000),
    startingBaseBalance: 0n,
    clock: new ManualClock(1_000),
  };

  const venueSaying = (info: Partial<MarketInfo>) => {
    const sent = { cancels: 0, orders: 0 };
    const market: MarketInfo = {
      id: PERP,
      kind: "perp",
      base: "SOL",
      quote: "nUSD",
      tickSize: dollars(0.01),
      lotSize: dollars(0.001),
      maxLeverage: 10,
      markPrice: dollars(106.603),
      markPriceUpdatedAtMs: 1_000,
      change24h: null,
      volume24h: 0n,
      openInterest: null,
      positionCap: dollars(22.222),
      ...info,
    };
    const venue = {
      markets: async () => [market],
      cancelAll: async () => {
        sent.cancels += 1;
        return 0;
      },
      placeOrder: async () => {
        sent.orders += 1;
        return { orderId: "", tag: 0n, status: "open", filledSize: 0n, remainingSize: 0n };
      },
      traderState: async () => ({ positions: {}, balances: {}, openOrders: [] }),
    } as unknown as Venue;
    return { venue, sent, market };
  };

  it("holds its quotes, cancelling and sending nothing, and says why", async () => {
    const { venue, sent } = venueSaying({ quotesRefusedBecause: "the market is paused" });
    const maker = new HouseMaker(options);

    await expect(maker.tick(venue)).rejects.toThrow(QuotesHeld);
    await expect(maker.tick(venue)).rejects.toThrow("the market is paused");
    expect(sent).toEqual({ cancels: 0, orders: 0 });
  });

  it("requotes on its first tick once the venue takes quotes again, within the cap", async () => {
    const { venue, sent, market } = venueSaying({ quotesRefusedBecause: "its mark is stale" });
    const maker = new HouseMaker(options);
    await maker.tick(venue).catch(() => {});

    delete market.quotesRefusedBecause;
    await maker.tick(venue);

    expect(sent).toEqual({ cancels: 1, orders: 6 });
  });
});
