import type { Connection } from "@solana/web3.js";
import type { FillOrigin } from "../data/stats.js";
import type { Clock } from "../engine/clock.js";
import type { MarketConfig } from "../engine/markets.js";
import type {
  Fill,
  MarketId,
  MarketInfo,
  NewOrder,
  PlaceResult,
  TraderKey,
  TraderState,
  Venue,
} from "../engine/types.js";
import { rejectedOrder } from "../engine/venue-orders.js";
import { BotAccounts, type BotSpec } from "./bot-accounts.js";
import { BotOrderSecrets, originOf } from "./bot-orders.js";
import { ChainFeed } from "./chain-feed.js";
import {
  type ChainFill,
  type ChainPrice,
  type ChainStats,
  type KeyCheckpoint,
  type PlaceOutcome,
  executed,
} from "./chain-types.js";
import { Session, connectionTo } from "./connections.js";
import { FundDesk } from "./fund-desk.js";
import { PricePublisher } from "./price-publisher.js";
import {
  FIRST_TRADER_SEAT,
  SEAT_COUNT,
  type Program,
  fillRoles,
  newOrderSecret,
  signedInSession,
} from "./program.js";
import { type BrowserUrls, type PublicDeployment, publicDeployment } from "./public-deployment.js";
import { RollupMarket } from "./rollup-market.js";
import { SeatSweep, seatOfTarget, seatTarget } from "./seat-sweep.js";
import { type RollupSettings, deployedMarket } from "./settings.js";
import type { TapeUpdate } from "./tape-tracker.js";
import { COLLATERAL_TOKEN, deployedToken } from "./tokens.js";
import { chainPriceAndSize, placeResultOf, traderStateOf } from "./translation.js";
import { toChainAmount } from "./units.js";

const CONNECTED_WITHIN_MS = 15_000;
const MS_PER_SECOND = 1_000;
/** The program gives a bot's order no tag: its fills are recognised by receipt instead. */
const NO_TAG = 0n;

export interface RollupFill {
  fill: Fill;
  origin: FillOrigin;
  /** Already recorded by an earlier run of this service, or part of a warm-up: history, not news. */
  replayed: boolean;
}

export interface RollupVenueHandlers {
  onFill(event: RollupFill): void;
  onPrice(market: MarketId, price: bigint, publishedAtMs: number): void;
  onBotOrder(trader: TraderKey, outcome: PlaceOutcome): void;
  /** A bot's order whose outcome could not be told in time; `onBotOrderSettled` follows. */
  onBotOrderUnknown(): void;
  onBotOrderSettled(executedAfterAll: boolean): void;
  onChainStats(stats: ChainStats): void;
  onError(what: string, error: unknown): void;
}

export interface RollupVenueOptions {
  program: Program;
  settings: RollupSettings;
  markets: readonly MarketConfig[];
  bots: BotSpec[];
  quoteExpirySeconds: number;
  publishIntervalMs: number;
  /** Per market, the last fill sequence an earlier run already recorded. */
  recordedThrough: Record<MarketId, number>;
  /** Per bot owner address, where its order keys stood when an earlier run last saved. */
  keyCheckpoints: Record<string, KeyCheckpoint>;
  /** How many user accounts this service's gate key has opened, ever. */
  usersEverOpened(): number;
  handlers: RollupVenueHandlers;
}

export interface Readiness {
  connected: boolean;
  pricesFresh: boolean;
  botsFunded: boolean;
  /** Per perpetual, how often this process has advanced its funding since it started. */
  fundingUpdates: Record<MarketId, number>;
}

/**
 * The real order book program behind the `Venue` interface. Prices are
 * published by the oracle key, every bot is an ordinary trader with its own
 * seat, private view and one-time order keys, and everything public (fills,
 * marks, counters) is read back from the chain, never from what this process
 * remembers having sent.
 */
export class RollupVenue implements Venue {
  private readonly followed = new Map<MarketId, RollupMarket>();
  private readonly secrets = new BotOrderSecrets();
  private readonly listeners = new Set<(fill: Fill) => void>();
  private readonly feed: ChainFeed;
  private readonly publisher: PricePublisher;
  private readonly bots: BotAccounts;
  private readonly sweep: SeatSweep;
  private readonly faucet: Session;
  private chainStats: ChainStats | null = null;
  private ordersPlaced = 0;
  private liquidatorSeat: number | null = null;

  private constructor(
    private readonly options: RollupVenueOptions,
    markets: RollupMarket[],
    feedConnection: Connection,
  ) {
    const { program, settings, handlers } = options;
    const [anyMarket] = markets;
    if (!anyMarket) throw new Error("the rollup venue was given no markets");
    for (const market of markets) this.followed.set(market.config.id, market);

    // A hosted endpoint takes a transaction only from a signed-in caller; the
    // local stack's own port, where its deposits go, takes one from anyone.
    const depositsThroughTheFilter =
      new URL(settings.depositRpcUrl).host === new URL(settings.rollupRpcUrl).host;
    this.faucet = depositsThroughTheFilter
      ? signedInSession(settings.rollupRpcUrl, settings.faucet)
      : Session.of(connectionTo(settings.depositRpcUrl));

    this.feed = new ChainFeed(
      program,
      feedConnection,
      markets.map((market) => market.chain.marketId),
      {
        onPrice: (marketId, price) => this.acceptPrice(marketId, price),
        onTape: (marketId, update, readAtMs) => this.acceptTape(marketId, update, readAtMs),
        onStats: (stats) => this.acceptStats(stats),
        onError: handlers.onError,
      },
    );
    this.publisher = new PricePublisher({
      program,
      oracle: signedInSession(settings.rollupRpcUrl, settings.oracle),
      oracleKey: settings.oracle,
      markets,
      intervalMs: options.publishIntervalMs,
      onError: handlers.onError,
    });
    this.bots = new BotAccounts({
      program,
      settings,
      bots: options.bots,
      gate: signedInSession(settings.rollupRpcUrl, settings.gate),
      faucet: this.faucet,
      keyCheckpoints: options.keyCheckpoints,
      syncMarketId: anyMarket.chain.marketId,
    });
    // Seats fill from the lowest number, so none lies beyond the accounts ever opened.
    this.sweep = new SeatSweep(
      FIRST_TRADER_SEAT,
      SEAT_COUNT,
      () => this.bots.count + options.usersEverOpened(),
    );
  }

  static async connect(options: RollupVenueOptions): Promise<RollupVenue> {
    const { program, settings } = options;
    const feedConnection = connectionTo(settings.rollupRpcUrl, settings.rollupWsUrl);
    const markets: RollupMarket[] = [];
    for (const config of options.markets) {
      const deployed = deployedMarket(settings.deployment, config.id);
      const chain = await program.market(feedConnection, deployed.id);
      markets.push(new RollupMarket(config, chain, deployed.baseDecimals));
    }
    return new RollupVenue(options, markets, feedConnection);
  }

  async start(): Promise<void> {
    await this.feed.start();
    this.publisher.start();
  }

  async stop(): Promise<void> {
    this.publisher.stop();
    this.bots.close();
    this.feed.stop();
  }

  private market(id: MarketId): RollupMarket {
    const market = this.followed.get(id);
    if (!market) throw new Error(`unknown market ${id}`);
    return market;
  }

  private marketOnChain(marketId: number): RollupMarket {
    for (const market of this.followed.values()) {
      if (market.chain.marketId === marketId) return market;
    }
    throw new Error(`the chain feed named market ${marketId}, which this venue does not follow`);
  }

  private perpMarketIds(): number[] {
    return [...this.followed.values()]
      .filter((market) => market.chain.kind === "perp")
      .map((market) => market.chain.marketId);
  }

  private acceptPrice(marketId: number, reading: ChainPrice): void {
    const market = this.marketOnChain(marketId);
    const news = market.acceptPrice(reading);
    if (news) this.options.handlers.onPrice(market.config.id, news.price, news.atMs);
  }

  private acceptTape(marketId: number, update: TapeUpdate, readAtMs: number): void {
    const market = this.marketOnChain(marketId);
    const firstReading = market.tapeCursor === 0;
    if (update.lost > 0n && !firstReading) {
      this.options.handlers.onError(
        `${market.config.id}: ${update.lost} fills left the tape before they were read`,
        null,
      );
    }
    for (const chainFill of update.fills) this.acceptFill(market, chainFill);
    this.secrets.forgetEndedBefore(market.config.id, readAtMs);
  }

  private acceptFill(market: RollupMarket, chainFill: ChainFill): void {
    const marketId = market.config.id;
    const alreadyRecorded =
      Number(chainFill.sequence) <= (this.options.recordedThrough[marketId] ?? 0);
    const replayed = market.warmingUp || alreadyRecorded;
    const fill = market.acceptFill(chainFill);
    const origin = originOf(fillRoles(chainFill, this.secrets.of(marketId)));
    this.options.handlers.onFill({ fill, origin, replayed });
    if (!replayed) for (const listener of this.listeners) listener(fill);
  }

  private acceptStats(stats: ChainStats): void {
    // The counters only grow, so a smaller one is an older picture arriving late.
    if (this.chainStats && stats.orders < this.chainStats.orders) return;
    this.chainStats = stats;
    this.options.handlers.onChainStats(stats);
  }

  tapeCursors(): Record<MarketId, number> {
    const cursors: Record<MarketId, number> = {};
    for (const [id, market] of this.followed) cursors[id] = market.tapeCursor;
    return cursors;
  }

  /** What a browser needs to trade on the program directly, with the URLs a browser should use. */
  publicDeployment(urls: BrowserUrls): PublicDeployment {
    const { program, settings } = this.options;
    return publicDeployment(
      settings.deployment,
      urls,
      [...this.followed.values()].map(({ chain }) => ({
        chain,
        addresses: program.publicAddresses(chain.marketId),
      })),
    );
  }

  readiness(): Readiness {
    const now = Date.now();
    return {
      connected: now - this.feed.readAtMs < CONNECTED_WITHIN_MS,
      pricesFresh: [...this.followed.values()].every((market) =>
        market.priceIsFresh(now, this.publisher.lastPublishedAtMs(market)),
      ),
      botsFunded: this.bots.allFunded(),
      fundingUpdates: this.publisher.fundingUpdates(),
    };
  }

  async markets(): Promise<MarketInfo[]> {
    const now = Date.now();
    const openInterest = this.chainStats?.openInterest;
    return [...this.followed.values()].map((market) =>
      market.info(now, openInterest ? (openInterest[market.chain.marketId] ?? 0n) : null),
    );
  }

  /** Sets where the mark should be. The publisher walks the chain's price there. */
  async publishPrice(market: MarketId, price: bigint): Promise<void> {
    this.market(market).setTarget(price);
  }

  async openTrader(trader: TraderKey): Promise<void> {
    await this.bots.trader(trader);
  }

  deposit(trader: TraderKey, token: string, amount: bigint): Promise<void> {
    return this.bots.topUp(trader, token, amount);
  }

  async placeOrder(trader: TraderKey, order: NewOrder): Promise<PlaceResult> {
    this.ordersPlaced += 1;
    const orderId = `${trader}#${this.ordersPlaced}`;
    const market = this.market(order.market);
    const sendable = chainPriceAndSize(market, order);
    if (typeof sendable === "string") return rejectedOrder(orderId, NO_TAG, order, sendable);

    const secret = newOrderSecret();
    this.secrets.add(order.market, trader, secret);
    const rests = order.type === "limit" || order.type === "postOnly";
    let outcome: PlaceOutcome;
    try {
      const programTrader = await this.bots.trader(trader);
      outcome = await programTrader.place(
        market.chain.marketId,
        {
          side: order.side,
          type: order.type,
          ...sendable,
          reduceOnly: order.reduceOnly ?? false,
          secret,
          restingExpirySeconds:
            rests && !order.reduceOnly
              ? Math.floor(Date.now() / MS_PER_SECOND) + this.options.quoteExpirySeconds
              : undefined,
        },
        this.perpMarketIds(),
      );
    } catch (error) {
      this.secrets.retire(secret, Date.now());
      const reason = error instanceof Error ? error.message : String(error);
      return rejectedOrder(orderId, NO_TAG, order, reason);
    }
    if (outcome.settled) outcome = await this.onceSettled(outcome.settled);
    if (outcome.status !== "rested") this.secrets.retire(secret, Date.now());
    this.options.handlers.onBotOrder(trader, outcome);
    return placeResultOf(orderId, order, market, sendable.size, outcome);
  }

  /**
   * An order whose outcome is unknown may still run, so it is neither placed
   * nor failed yet, and its bot does nothing else until the rollup's clock
   * has settled it.
   */
  private async onceSettled(settled: Promise<PlaceOutcome>): Promise<PlaceOutcome> {
    const { handlers } = this.options;
    handlers.onBotOrderUnknown();
    const outcome = await settled.catch((): PlaceOutcome => ({
      status: "expired",
      filled: 0n,
      rested: 0n,
      sendToResultMs: 0,
    }));
    handlers.onBotOrderSettled(executed(outcome));
    return outcome;
  }

  async cancelAll(trader: TraderKey, market: MarketId): Promise<number> {
    const programTrader = await this.bots.trader(trader);
    const cancelled = await programTrader.cancelAll(this.market(market).chain.marketId);
    if (cancelled === null) return 0;
    this.secrets.retireAll(market, trader, Date.now());
    return Number(cancelled);
  }

  async traderState(trader: TraderKey): Promise<TraderState> {
    const view = await (await this.bots.trader(trader)).view();
    const { tokens } = this.options.settings.deployment;
    return traderStateOf(trader, view, this.followed.values(), tokens);
  }

  /** Invariant: nothing to do on request. The publisher advances funding right after a fresh price. */
  async updateFunding(): Promise<void> {}

  /** The seats the liquidator tries next, as targets `liquidate` accepts. */
  nextLiquidationTargets(count: number): TraderKey[] {
    return this.sweep.next(count).map(seatTarget);
  }

  async liquidate(liquidator: TraderKey, target: TraderKey, market: MarketId): Promise<boolean> {
    const seat = seatOfTarget(target);
    const { chain, mark } = this.market(market);
    if (seat === null || mark === 0n) return false;
    const programTrader = await this.bots.trader(liquidator);
    this.liquidatorSeat ??= (await programTrader.view()).seat;
    if (seat === this.liquidatorSeat) return false;
    return programTrader.liquidate(chain.marketId, seat, mark, this.perpMarketIds());
  }

  /** Where every open bot's order keys stand, by owner address, to save and restore from. */
  keyCheckpoints(): Record<string, KeyCheckpoint> {
    return this.bots.keyCheckpoints();
  }

  /** The desk that opens and funds users. */
  fundDesk(amount: bigint, clock: Clock): FundDesk {
    const { settings, program, handlers } = this.options;
    const collateral = deployedToken(settings.deployment, COLLATERAL_TOKEN);
    if (!collateral) throw new Error(`the deployment has no ${COLLATERAL_TOKEN} token`);
    return new FundDesk({
      program,
      session: this.faucet,
      gate: settings.gate,
      faucet: settings.faucet,
      mint: collateral.mint,
      amountAtoms: toChainAmount(amount, collateral.decimals),
      clock,
      onError: handlers.onError,
    });
  }

  onFill(listener: (fill: Fill) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
