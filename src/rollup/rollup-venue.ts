import type { FillOrigin } from "../data/stats.js";
import type { Clock } from "../engine/clock.js";
import type { MarketConfig } from "../engine/markets.js";
import type { Admission } from "../gate/admission.js";
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
import { idleWithin } from "../scheduling/repeating.js";
import { BotAccounts, type BotSpec } from "./bot-accounts.js";
import { BotOrderSecrets, originOf } from "./bot-orders.js";
import { ChainFeed, REREAD_INTERVAL_MS } from "./chain-feed.js";
import {
  type ChainExchange,
  type ChainFill,
  type ChainMarket,
  type ChainPrice,
  type ChainStats,
  type KeyCheckpoint,
  type PlaceOutcome,
  executed,
} from "./chain-types.js";
import { Session, connectionTo } from "./connections.js";
import { FundDesk } from "./fund-desk.js";
import { Generation } from "./generation.js";
import { noteMakerQuote } from "./maker-quotes.js";
import { OpenDesk } from "./open-desk.js";
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

/** Three of the feed's full reads: one missed is not an outage. */
const CONNECTED_WITHIN_MS = 3 * REREAD_INTERVAL_MS;
const MS_PER_SECOND = 1_000;
/** How long a rest waits for the requests in flight before it lets them go. */
const DRAIN_WITHIN_MS = 2_000;
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
  /** Whatever `onError` was last given under this name has worked again. */
  onRecovered(what: string): void;
  /** The rollup stopped answering an awake service: it should rest and wake again. */
  onUnreachable(): void;
}

export interface RollupVenueOptions {
  program: Program;
  settings: RollupSettings;
  markets: readonly MarketConfig[];
  bots: BotSpec[];
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
}

/**
 * The real order book program behind the `Venue` interface. The marks are
 * the program's own (on a mainnet-profile deployment, Pyth's, synced by a
 * crank this service does not run), and so is funding, which the program's
 * schedule advances. Every bot is an ordinary trader with its own seat,
 * private view and one-time order keys, and everything public (fills, marks,
 * counters) is read back from the chain, never from what this process
 * remembers having sent.
 */
export class RollupVenue implements Venue {
  private readonly followed = new Map<MarketId, RollupMarket>();
  private readonly secrets = new BotOrderSecrets();
  private readonly listeners = new Set<(fill: Fill) => void>();
  private readonly feed: ChainFeed;
  private readonly bots: BotAccounts;
  private readonly sweep: SeatSweep;
  /** Null on a deployment without a faucet. */
  private readonly faucet: Session | null;
  /** The gate key's connection. */
  private readonly gateSession: Session;
  /** Every key's connection, opened again after a rest. */
  private readonly sessions: Session[] = [];
  private stopped = false;
  /**
   * The generation now current: everything that sends is made for it and ends
   * with it. Undefined while the service rests, when nothing may send.
   */
  private life: Generation | undefined = new Generation();
  /** What the feed is failing at right now, by name. */
  private readonly failing = new Set<string>();
  private chainStats: ChainStats | null = null;
  /** Null until the feed has read it. */
  private exchange: ChainExchange | null = null;
  private ordersPlaced = 0;
  private liquidatorSeat: number | null = null;

  private constructor(
    private readonly options: RollupVenueOptions,
    markets: RollupMarket[],
  ) {
    const { program, settings, handlers } = options;
    const [anyMarket] = markets;
    if (!anyMarket) throw new Error("the rollup venue was given no markets");
    for (const market of markets) this.followed.set(market.config.id, market);

    // A hosted endpoint takes a transaction only from a signed-in caller; the
    // local stack's own port, where its deposits go, takes one from anyone.
    const depositsThroughTheFilter =
      new URL(settings.depositRpcUrl).host === new URL(settings.rollupRpcUrl).host;
    const faucetKey = settings.faucet;
    this.faucet = !faucetKey
      ? null
      : depositsThroughTheFilter
        ? signedInSession(settings.rollupRpcUrl, faucetKey, () => this.life)
        : Session.of(connectionTo(settings.depositRpcUrl));

    const gate = signedInSession(settings.rollupRpcUrl, settings.gate, () => this.life);
    this.gateSession = gate;
    this.sessions.push(gate);
    if (this.faucet) this.sessions.push(this.faucet);

    // What the feed fails at is what the rollup's reachability is judged by.
    const watched = {
      onError: (what: string, error: unknown) => {
        this.failing.add(what);
        handlers.onError(what, error);
      },
      onRecovered: (what: string) => {
        this.failing.delete(what);
        handlers.onRecovered(what);
      },
    };

    this.feed = new ChainFeed(
      program,
      () => connectionTo(settings.rollupRpcUrl, settings.rollupWsUrl, this.life),
      markets.map((market) => market.chain.marketId),
      {
        onPrice: (marketId, price) => this.acceptPrice(marketId, price),
        onTape: (marketId, update, readAtMs) => this.acceptTape(marketId, update, readAtMs),
        onStats: (stats) => this.acceptStats(stats),
        onMarket: (market) => this.acceptMarket(market),
        onExchange: (exchange) => (this.exchange = exchange),
        onUnreachable: handlers.onUnreachable,
        ...watched,
      },
    );
    this.bots = new BotAccounts({
      program,
      settings,
      bots: options.bots,
      gate,
      faucet: this.faucet,
      keyCheckpoints: options.keyCheckpoints,
      syncMarketId: anyMarket.chain.marketId,
      life: () => this.life,
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
    const reading = connectionTo(settings.rollupRpcUrl);
    const markets: RollupMarket[] = [];
    for (const config of options.markets) {
      const deployed = deployedMarket(settings.deployment, config.id);
      const chain = await program.market(reading, deployed.id);
      markets.push(new RollupMarket(config, chain, deployed.baseDecimals));
    }
    return new RollupVenue(options, markets);
  }

  /**
   * Starts following the chain's public accounts: reads them all, then
   * listens. Throws when the first read fails, having started nothing.
   */
  follow(): Promise<void> {
    this.life ??= new Generation();
    return this.feed.follow();
  }

  /**
   * Follows the chain again after a rest. Throws when the first read fails;
   * safe to call again after it threw. A mark that is missing or stale is
   * reported by `readiness`, not refused here: the program refuses the orders
   * it would price, and the crank that syncs it is not this service.
   */
  async resume(): Promise<void> {
    if (this.stopped) return;
    await this.follow();
  }

  /**
   * Sends nothing and listens to nothing until `resume`. The reads in flight
   * get a moment to end, none of them asking for more; then the generation
   * ends, and with it every connection, confirmation, order client and poll
   * made for it. The bots are let go of, not paused: the next call for one
   * opens a new trader for the next generation.
   */
  async rest(): Promise<void> {
    this.feed.pause();
    await idleWithin([this.feed], DRAIN_WITHIN_MS);
    this.bots.retire();
    this.life?.end();
    this.life = undefined;
    for (const session of this.sessions) session.renew();
    this.failing.clear();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.bots.close();
    this.feed.stop();
    this.life?.end();
    this.life = undefined;
  }

  /**
   * `work`, as long as the service is awake: it is refused while the service
   * rests and rejected the moment the generation it began in ends.
   */
  private whileAwake<T>(work: () => Promise<T>): Promise<T> {
    if (!this.life) return Promise.reject(new Error("the service is asleep"));
    return this.life.until(work());
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

  private acceptPrice(marketId: number, reading: ChainPrice): void {
    const market = this.marketOnChain(marketId);
    const news = market.acceptPrice(reading);
    if (news) this.options.handlers.onPrice(market.config.id, news.price, news.atMs);
  }

  private acceptMarket(reading: ChainMarket): void {
    this.marketOnChain(reading.marketId).acceptMarket(reading);
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
    const fill = market.acceptFill(chainFill);
    const origin = originOf(fillRoles(chainFill, this.secrets.of(marketId)));
    this.options.handlers.onFill({ fill, origin, replayed: alreadyRecorded });
    if (!alreadyRecorded) for (const listener of this.listeners) listener(fill);
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
      [...this.followed.values()].map(({ chain, config }) => ({
        chain,
        symbol: config.id,
        addresses: program.publicAddresses(chain.marketId),
      })),
    );
  }

  readiness(): Readiness {
    const now = Date.now();
    return {
      connected: now - this.feed.readAtMs < CONNECTED_WITHIN_MS && this.failing.size === 0,
      pricesFresh: [...this.followed.values()].every((market) => market.priceIsFresh(now)),
      botsFunded: this.bots.allFunded(),
    };
  }

  async markets(): Promise<MarketInfo[]> {
    const now = Date.now();
    const openInterest = this.chainStats?.openInterest;
    return [...this.followed.values()].map((market) =>
      market.info(
        now,
        openInterest ? (openInterest[market.chain.marketId] ?? 0n) : null,
        this.exchange,
      ),
    );
  }

  /** Refused: the mark is the program's own, and nothing here sets it. */
  async publishPrice(market: MarketId): Promise<void> {
    throw new Error(`${market}: the mark on the rollup is the program's own, not this service's`);
  }

  async openTrader(trader: TraderKey): Promise<void> {
    await this.whileAwake(() => this.bots.trader(trader));
  }

  deposit(trader: TraderKey, token: string, amount: bigint): Promise<void> {
    return this.whileAwake(() => this.bots.topUp(trader, token, amount));
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
    const restsWithoutExpiry = rests && !order.reduceOnly && order.expiresInSeconds === undefined;
    if (restsWithoutExpiry) {
      return rejectedOrder(
        orderId,
        NO_TAG,
        order,
        "a resting order needs an expiry of its own, so it cannot outlive the bot that placed it",
      );
    }
    let outcome: PlaceOutcome;
    let owner = "";
    try {
      outcome = await this.whileAwake(async () => {
        const programTrader = await this.bots.trader(trader);
        owner = programTrader.address;
        return programTrader.place(market.chain.marketId, {
          side: order.side,
          type: order.type,
          ...sendable,
          reduceOnly: order.reduceOnly ?? false,
          secret,
          restingExpirySeconds:
            rests && !order.reduceOnly && order.expiresInSeconds !== undefined
              ? Math.floor(Date.now() / MS_PER_SECOND) + order.expiresInSeconds
              : undefined,
        });
      });
    } catch (error) {
      this.secrets.retire(secret, Date.now());
      const reason = error instanceof Error ? error.message : String(error);
      return rejectedOrder(orderId, NO_TAG, order, reason);
    }
    if (outcome.settled) outcome = await this.onceSettled(outcome.settled);
    if (outcome.status !== "rested") this.secrets.retire(secret, Date.now());
    if (rests && !order.reduceOnly) {
      noteMakerQuote(this.options.handlers, trader, order.market, owner, outcome);
    }
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
    const cancelled = await this.whileAwake(async () =>
      (await this.bots.trader(trader)).cancelAll(this.market(market).chain.marketId),
    );
    if (cancelled === null) return 0;
    this.secrets.retireAll(market, trader, Date.now());
    return Number(cancelled);
  }

  async traderState(trader: TraderKey): Promise<TraderState> {
    const view = await this.whileAwake(async () => (await this.bots.trader(trader)).view());
    const { tokens } = this.options.settings.deployment;
    return traderStateOf(trader, view, this.followed.values(), tokens);
  }

  /** Invariant: nothing to do on request. The program's own schedule advances funding. */
  async updateFunding(): Promise<void> {}

  /** The seats the liquidator tries next, as targets `liquidate` accepts. */
  nextLiquidationTargets(count: number): TraderKey[] {
    return this.sweep.next(count).map(seatTarget);
  }

  async liquidate(liquidator: TraderKey, target: TraderKey, market: MarketId): Promise<boolean> {
    const seat = seatOfTarget(target);
    const { chain, mark } = this.market(market);
    if (seat === null || mark === 0n) return false;
    return this.whileAwake(async () => {
      const programTrader = await this.bots.trader(liquidator);
      this.liquidatorSeat ??= (await programTrader.view()).seat;
      if (seat === this.liquidatorSeat) return false;
      return programTrader.liquidate(chain.marketId, seat, mark);
    });
  }

  /** Where every open bot's order keys stand, by owner address, to save and restore from. */
  keyCheckpoints(): Record<string, KeyCheckpoint> {
    return this.bots.keyCheckpoints();
  }

  /** The desk that opens and funds users, or null on a deployment without a faucet. */
  fundDesk(amount: bigint, clock: Clock): FundDesk | null {
    const { settings, program, handlers } = this.options;
    if (!this.faucet || !settings.faucet) return null;
    const collateral = deployedToken(settings.deployment, COLLATERAL_TOKEN);
    if (!collateral) throw new Error(`the deployment has no ${COLLATERAL_TOKEN} token`);
    return new FundDesk({
      program,
      session: this.faucet,
      gate: settings.gate,
      faucet: settings.faucet,
      token: collateral,
      amountAtoms: toChainAmount(amount, collateral.decimals),
      clock,
      onError: handlers.onError,
    });
  }

  /** The desk that opens accounts for invited users and funds none of them. */
  openDesk(admission: Admission, log: (line: string) => void, clock: Clock): OpenDesk {
    const { settings, program, handlers } = this.options;
    return new OpenDesk({
      program,
      session: this.gateSession,
      gate: settings.gate,
      admission,
      exchange: () => this.exchange,
      clock,
      log,
      onError: handlers.onError,
    });
  }

  onFill(listener: (fill: Fill) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
