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
import {
  ORDER_EXPIRY_TOO_NEAR,
  rejectedOrder,
  unknownOrder,
  unrunOrder,
} from "../engine/venue-orders.js";
import { DeadlineExceeded, withinDeadline } from "../scheduling/deadline.js";
import { idleWithin } from "../scheduling/repeating.js";
import { BotAccounts, type BotSpec } from "./bot-accounts.js";
import { BotOrderSecrets, endsByMsOf, originOf } from "./bot-orders.js";
import { ChainFeed, REREAD_INTERVAL_MS } from "./chain-feed.js";
import {
  type ChainExchange,
  type ChainFill,
  type ChainMarket,
  type ChainPrice,
  type ChainStats,
  type KeyCheckpoint,
  type PlaceOutcome,
  type RangeLiquidation,
  type SeatRange,
  executed,
} from "./chain-types.js";
import { Session, connectionTo } from "./connections.js";
import { FundDesk } from "./fund-desk.js";
import { Generation } from "./generation.js";
import { noteMakerQuote } from "./maker-quotes.js";
import { OpenDesk } from "./open-desk.js";
import {
  FIRST_TRADER_SEAT,
  type Program,
  fillRoles,
  newOrderSecret,
  signedInSession,
} from "./program.js";
import {
  type BrowserUrls,
  type OwnerAuth,
  type PublicDeployment,
  publicDeployment,
} from "./public-deployment.js";
import { RollupMarket } from "./rollup-market.js";
import { sweepStopText } from "./program-errors.js";
import { SeatSweep, seatRangeOfTarget, seatRangeTarget } from "./seat-sweep.js";
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
/** How long an order of unknown outcome may hold its bot's tick before it is reported as still unknown. */
export const SETTLEMENT_DEADLINE_MS = 30_000;
/**
 * How long the program may take to take an order before its outcome is reported as unknown. A late
 * answer after that is dropped: the order is never reported as placed by it.
 */
export const PLACE_DEADLINE_MS = 20_000;
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
  /** Per bot trader, the place calls handed to the program that have not settled. */
  private readonly placesInFlight = new Map<TraderKey, number>();
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
  /** Sweeps in a row that failed outright, across markets. */
  private failedSweeps = 0;

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
    this.sweep = new SeatSweep(FIRST_TRADER_SEAT, () => this.seatCapacity());
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
  publicDeployment(urls: BrowserUrls, ownerAuth: OwnerAuth): PublicDeployment {
    const { program, settings } = this.options;
    return publicDeployment(
      settings.deployment,
      urls,
      [...this.followed.values()].map(({ chain, config }) => ({
        chain,
        symbol: config.id,
        addresses: program.publicAddresses(chain.marketId),
      })),
      ownerAuth,
    );
  }

  /** The seats the exchange's ledger can hold; null until the feed has read a live exchange. */
  seatCapacity(): number | null {
    return this.exchange?.seatCapacity ?? null;
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

  /** Counts `placing` against `trader` until it resolves or rejects, whatever deadline its caller gave up at. */
  private trackUntilSettled(trader: TraderKey, placing: Promise<unknown>): void {
    this.placesInFlight.set(trader, (this.placesInFlight.get(trader) ?? 0) + 1);
    const settled = (): void => {
      const left = (this.placesInFlight.get(trader) ?? 1) - 1;
      if (left > 0) this.placesInFlight.set(trader, left);
      else this.placesInFlight.delete(trader);
    };
    placing.then(settled, settled);
  }

  /** How many calls handing an order to the program for `trader` have not yet resolved or rejected. */
  unsettledPlaces(trader: TraderKey): number {
    return this.placesInFlight.get(trader) ?? 0;
  }

  async placeOrder(trader: TraderKey, order: NewOrder): Promise<PlaceResult> {
    this.ordersPlaced += 1;
    const orderId = `${trader}#${this.ordersPlaced}`;
    const market = this.market(order.market);
    const sendable = chainPriceAndSize(market, order);
    if (typeof sendable === "string") return rejectedOrder(orderId, NO_TAG, order, sendable);

    const rests = order.type === "limit" || order.type === "postOnly";
    const hasExpiry = order.expiresInSeconds !== undefined || order.expiresAtMs !== undefined;
    const restsWithoutExpiry = rests && !order.reduceOnly && !hasExpiry;
    if (restsWithoutExpiry) {
      return rejectedOrder(
        orderId,
        NO_TAG,
        order,
        "a resting order needs an expiry of its own, so it cannot outlive the bot that placed it",
      );
    }
    const expiresAtMs = order.expiresAtMs;
    const lapsed =
      rests &&
      !order.reduceOnly &&
      expiresAtMs !== undefined &&
      Math.floor(expiresAtMs / MS_PER_SECOND) <= Math.floor(Date.now() / MS_PER_SECOND) + 1;
    if (lapsed) {
      return rejectedOrder(orderId, NO_TAG, order, ORDER_EXPIRY_TOO_NEAR);
    }
    const secret = newOrderSecret();
    const endsByMs =
      rests && !order.reduceOnly && hasExpiry
        ? endsByMsOf(
            expiresAtMs !== undefined
              ? Math.floor(expiresAtMs / MS_PER_SECOND)
              : Math.floor((Date.now() + PLACE_DEADLINE_MS) / MS_PER_SECOND) +
                  (order.expiresInSeconds ?? 0),
          )
        : null;
    this.secrets.add(order.market, trader, secret, endsByMs);
    let outcome: PlaceOutcome;
    let owner = "";
    let dispatched = false;
    // Set once the deadline has passed: work that has not been handed to the program by then never is.
    let abandoned = false;
    try {
      outcome = await withinDeadline(
        this.whileAwake(async () => {
          const programTrader = await this.bots.trader(trader);
          if (abandoned) throw new Error("the order was abandoned before it was sent");
          owner = programTrader.address;
          dispatched = true;
          const placing = programTrader.place(market.chain.marketId, {
            side: order.side,
            type: order.type,
            ...sendable,
            reduceOnly: order.reduceOnly ?? false,
            secret,
            restingExpirySeconds:
              rests && !order.reduceOnly && hasExpiry
                ? order.expiresAtMs !== undefined
                  ? // Rounded down, so the program never keeps the order past the time the caller recorded.
                    Math.floor(order.expiresAtMs / MS_PER_SECOND)
                  : Math.floor(Date.now() / MS_PER_SECOND) + (order.expiresInSeconds ?? 0)
                : undefined,
          });
          this.trackUntilSettled(trader, placing);
          return placing;
        }),
        PLACE_DEADLINE_MS,
        "placing the order",
      );
    } catch (error) {
      abandoned = true;
      const reason = error instanceof Error ? error.message : String(error);
      // Once the order was handed to the program it may still fill, and its fills are told by this secret.
      if (dispatched) return unknownOrder(orderId, NO_TAG, order, reason);
      this.secrets.retire(secret, Date.now());
      // Not handed to the program by the deadline, and `abandoned` now stops it ever being: it never ran.
      if (error instanceof DeadlineExceeded) return unrunOrder(orderId, NO_TAG, order, reason);
      return rejectedOrder(orderId, NO_TAG, order, reason);
    }
    if (outcome.settled) outcome = await this.onceSettled(outcome.settled);
    if (outcome.orderSeq !== undefined) this.secrets.rests(secret, outcome.orderSeq);
    if (outcome.status !== "rested" && outcome.status !== "unknown") {
      this.secrets.retire(secret, Date.now());
    }
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
    const stillUnknown = (reason: string): PlaceOutcome => ({
      status: "unknown",
      filled: 0n,
      rested: 0n,
      sendToResultMs: 0,
      reason,
    });
    let stopWaiting: () => void = () => {};
    const timedOut = new Promise<PlaceOutcome>((resolve) => {
      const timer = setTimeout(
        () => resolve(stillUnknown("the order was not settled in time")),
        SETTLEMENT_DEADLINE_MS,
      );
      stopWaiting = () => clearTimeout(timer);
    });
    const outcome = await Promise.race([
      settled.catch(() => stillUnknown("the order's outcome could not be settled")),
      timedOut,
    ]).finally(stopWaiting);
    handlers.onBotOrderSettled(executed(outcome));
    return outcome;
  }

  async cancelAll(trader: TraderKey, market: MarketId): Promise<number> {
    // Only the orders that stood when this cancel was issued end with it, however late it completes.
    const fence = this.secrets.mark();
    const cancelled = await this.whileAwake(async () =>
      (await this.bots.trader(trader)).cancelAll(this.market(market).chain.marketId),
    );
    if (cancelled === null) return 0;
    this.secrets.retireAll(market, trader, Date.now(), fence);
    return Number(cancelled);
  }

  async cancelOrder(trader: TraderKey, market: MarketId, orderId: string): Promise<boolean> {
    const orderSeq = BigInt(orderId);
    const cancelled = await this.whileAwake(async () =>
      (await this.bots.trader(trader)).cancelOrder(this.market(market).chain.marketId, orderSeq),
    );
    // Cancelled now, or already gone: either way the order cannot fill from here on.
    this.secrets.retireResting(market, trader, orderSeq, Date.now());
    return cancelled;
  }

  async traderState(trader: TraderKey): Promise<TraderState> {
    const view = await this.whileAwake(async () => (await this.bots.trader(trader)).view());
    const { tokens } = this.options.settings.deployment;
    return traderStateOf(trader, view, this.followed.values(), tokens);
  }

  /** Invariant: nothing to do on request. The program's own schedule advances funding. */
  async updateFunding(): Promise<void> {}

  /** The seats the liquidator tries next, as a target `liquidate` accepts; none while the exchange's seat capacity is unknown. */
  nextLiquidationTargets(count: number): TraderKey[] {
    const range = this.sweep.next(count);
    return range === null ? [] : [seatRangeTarget(range)];
  }

  /** Whether the sweep of the seats in `target` took over a position. A seat of the liquidator's own is skipped by the program. */
  async liquidate(liquidator: TraderKey, target: TraderKey, market: MarketId): Promise<boolean> {
    const range = seatRangeOfTarget(target);
    const { chain, mark } = this.market(market);
    if (range === null || mark === 0n) return false;
    return this.whileAwake(async () => {
      const programTrader = await this.bots.trader(liquidator);
      const swept = await programTrader.liquidateRange(chain.marketId, range, mark);
      const what = `${market} liquidation sweep`;
      const { handlers } = this.options;
      if (swept === null) {
        // The seats were not looked at: the same range is tried again on the next tick.
        this.sweep.resumeAt(range.start);
        this.failedSweeps += 1;
        if (this.failedSweeps === 1) {
          handlers.onError(
            what,
            new Error(
              `the sweep of seats ${range.start} to ${range.start + range.count - 1} failed and is tried again; failures in a row are counted but not repeated here`,
            ),
          );
        }
        return false;
      }
      if (this.failedSweeps > 0) {
        this.failedSweeps = 0;
        handlers.onRecovered(what);
      }
      this.noteSweep(market, range, swept);
      return swept.taken > 0;
    });
  }

  /**
   * A sweep that ended before the end of its range carries on after the seat it stopped at, so it
   * cannot wedge there: that seat is tried again on the next lap. Only a stale price, which stops
   * the sweep before any seat, resumes at the start. A stop is reported until a sweep of this
   * market runs to the end of its range again; one cut short by its takeover limit is no stop.
   */
  private noteSweep(market: MarketId, range: SeatRange, swept: RangeLiquidation): void {
    const what = `${market} liquidation sweep`;
    const { handlers } = this.options;
    if (swept.stopped === null) {
      if (swept.nextSeat < range.start + range.count) this.sweep.resumeAt(swept.nextSeat);
      else handlers.onRecovered(what);
      return;
    }
    this.sweep.resumeAt(swept.nextSeat + (swept.stopped === "stalePrice" ? 0 : 1));
    if (swept.stopped !== "stalePrice") {
      handlers.onError(what, new Error(sweepStopText(swept.stopped)));
    }
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
