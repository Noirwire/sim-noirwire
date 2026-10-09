import type { Connection, Keypair } from "@solana/web3.js";
import type { FillOrigin } from "../data/stats.js";
import type { Clock } from "../engine/clock.js";
import type { MarketConfig } from "../engine/markets.js";
import type {
  Fill,
  LatencyStats,
  MarketId,
  MarketInfo,
  NewOrder,
  PlaceResult,
  TraderKey,
  TraderState,
  Venue,
  VenueStats,
} from "../engine/types.js";
import { BotOrderSecrets, originOf } from "./bot-orders.js";
import { ChainFeed } from "./chain-feed.js";
import { FundingDesk } from "./funding-desk.js";
import { nextPublishPrice } from "./price-walk.js";
import {
  FIRST_TRADER_SEAT,
  SEAT_COUNT,
  type ChainFill,
  type ChainMarket,
  type ChainPrice,
  type ChainStats,
  type DepositTarget,
  type PlaceOutcome,
  type Program,
  type ProgramTrader,
  directConnection,
  fillRoles,
  newOrderSecret,
  publicConnection,
  signedInConnection,
} from "./program.js";
import { SeatSweep, seatOfTarget, seatTarget } from "./seat-sweep.js";
import type { RollupSettings } from "./settings.js";
import type { TapeUpdate } from "./tape-tracker.js";
import {
  type MarketUnits,
  marketUnits,
  roundDownToChainPrice,
  toChainAmount,
  toChainPrice,
  toChainSize,
  toSimAmount,
  toSimPrice,
  toSimSize,
} from "./units.js";

/**
 * The program stores no decimals for a perpetual's base, and the deployment
 * description does not carry them, so they are stated here per base asset.
 */
const BASE_DECIMALS: Record<string, number> = { SOL: 9, NVDAx: 6 };
const CHAIN_TOKEN_OF: Record<string, string> = { nUSD: "nUSD", SOL: "nSOL" };
const COLLATERAL_TOKEN = "nUSD";
const SPOT_COLLATERAL_BALANCE = "nUSD (spot)";

const DAY_MS = 24 * 60 * 60 * 1000;
const CONNECTED_WITHIN_MS = 15_000;

export interface BotSpec {
  key: TraderKey;
  owner: Keypair;
  /** Holds its nUSD as perpetuals collateral. */
  tradesPerps: boolean;
  /** Holds its nUSD in the spot balance as well. */
  tradesSpot: boolean;
}

export interface RollupFill {
  fill: Fill;
  origin: FillOrigin;
  /** Already recorded by an earlier run of this service: history, not news. */
  replayed: boolean;
}

export interface RollupVenueHandlers {
  onFill(event: RollupFill): void;
  onPrice(market: MarketId, price: bigint, publishedAtMs: number): void;
  onBotOrder(trader: TraderKey, outcome: PlaceOutcome): void;
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
  latencyWindowSize: number;
  measuredFrom: string;
  /** Per market, the last fill sequence an earlier run already recorded. */
  recordedThrough: Record<MarketId, number>;
  handlers: RollupVenueHandlers;
}

export interface Readiness {
  connected: boolean;
  pricesFresh: boolean;
  botsFunded: boolean;
}

interface MarketState {
  config: MarketConfig;
  chain: ChainMarket;
  units: MarketUnits;
  scheduledFunding: boolean;
  price: ChainPrice | null;
  target: bigint | null;
  publishedAtMs: number;
  publishing: boolean;
  tapeCursor: number;
  recentFills: { atMs: number; notional: bigint }[];
  priceHistory: { atMs: number; price: bigint }[];
}

const tagOf = (receipt: Uint8Array): bigint => Buffer.from(receipt).readBigUInt64BE(0);

const percentile = (sorted: number[], p: number): number =>
  sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;

const rejected = (orderId: string, order: NewOrder, reason: string): PlaceResult => ({
  orderId,
  tag: 0n,
  status: "rejected",
  filledSize: 0n,
  remainingSize: order.size,
  reason,
});

/**
 * The real order book program behind the `Venue` interface. Prices are
 * published by the oracle key, every bot is an ordinary trader with its own
 * seat, private view and one-time order keys, and everything public (fills,
 * marks, counters) is read back from the chain, never from what this process
 * remembers having sent.
 */
export class RollupVenue implements Venue {
  private readonly states = new Map<MarketId, MarketState>();
  private readonly traders = new Map<TraderKey, ProgramTrader>();
  private readonly opening = new Map<TraderKey, Promise<ProgramTrader>>();
  private readonly funded = new Set<TraderKey>();
  private readonly secrets = new BotOrderSecrets();
  private readonly listeners = new Set<(fill: Fill) => void>();
  private readonly latencySamplesMs: number[] = [];
  private readonly sweep = new SeatSweep(FIRST_TRADER_SEAT, SEAT_COUNT);
  private readonly startedAtMs = Date.now();
  private chainStats: ChainStats | null = null;
  private publishTimer: ReturnType<typeof setInterval> | null = null;
  private orderCounter = 0;

  private constructor(
    private readonly options: RollupVenueOptions,
    private readonly oracleConnection: Connection,
    private readonly gateConnection: Connection,
    private readonly faucetConnection: Connection,
    private readonly feed: ChainFeed,
  ) {}

  static async connect(options: RollupVenueOptions): Promise<RollupVenue> {
    const { program, settings } = options;
    const feedConnection = publicConnection(settings.rollupRpcUrl, settings.rollupWsUrl);
    const [oracleConnection, gateConnection, faucetSignedIn] = await Promise.all(
      [settings.oracle, settings.gate, settings.faucet].map((key) =>
        signedInConnection(settings.rollupRpcUrl, key),
      ),
    );
    // The local query filter refuses every transaction that moves tokens into
    // custody, so deposits go to the rollup's own port where one is named.
    const faucetConnection = settings.rollupDirectRpcUrl
      ? directConnection(settings.rollupDirectRpcUrl)
      : faucetSignedIn;
    const deployed = options.markets.map((config) =>
      settings.deployment.markets.find((market) => market.symbol === config.id)!,
    );
    let venue: RollupVenue | null = null;
    const feed = new ChainFeed(
      program,
      feedConnection,
      deployed.map((market) => market.id),
      {
        onPrice: (marketId, price) => venue?.acceptPrice(marketId, price),
        onTape: (marketId, update, readAtMs) => venue?.acceptTape(marketId, update, readAtMs),
        onStats: (stats) => venue?.acceptStats(stats),
        onError: options.handlers.onError,
      },
    );
    venue = new RollupVenue(options, oracleConnection!, gateConnection!, faucetConnection!, feed);
    for (const [at, config] of options.markets.entries()) {
      const chain = await program.market(feedConnection, deployed[at]!.id);
      const baseDecimals = BASE_DECIMALS[config.base];
      if (baseDecimals === undefined) throw new Error(`no base decimals known for ${config.base}`);
      venue.states.set(config.id, {
        config,
        chain,
        units: marketUnits(chain.baseLot, baseDecimals),
        scheduledFunding: deployed[at]!.fundingTaskId !== undefined,
        price: null,
        target: null,
        publishedAtMs: 0,
        publishing: false,
        tapeCursor: 0,
        recentFills: [],
        priceHistory: [],
      });
    }
    return venue;
  }

  async start(): Promise<void> {
    await this.feed.start();
    this.publishTimer = setInterval(() => {
      for (const state of this.states.values()) void this.publishNext(state);
    }, this.options.publishIntervalMs);
  }

  async stop(): Promise<void> {
    if (this.publishTimer) clearInterval(this.publishTimer);
    this.publishTimer = null;
    await this.feed.stop();
  }

  private state(market: MarketId): MarketState {
    const state = this.states.get(market);
    if (!state) throw new Error(`unknown market ${market}`);
    return state;
  }

  private stateOfChainMarket(marketId: number): MarketState {
    for (const state of this.states.values()) {
      if (state.chain.marketId === marketId) return state;
    }
    throw new Error(`unknown market ${marketId}`);
  }

  private perpMarketIds(): number[] {
    return [...this.states.values()]
      .filter((state) => state.chain.kind === "perp")
      .map((state) => state.chain.marketId);
  }

  private acceptPrice(marketId: number, price: ChainPrice): void {
    const state = this.stateOfChainMarket(marketId);
    const changed =
      !state.price ||
      state.price.price !== price.price ||
      state.price.publishTimeSeconds !== price.publishTimeSeconds;
    state.price = price;
    if (!changed || price.price === 0n) return;
    const simPrice = toSimPrice(state.units, price.price);
    const atMs = price.publishTimeSeconds * 1000;
    state.priceHistory.push({ atMs, price: simPrice });
    while (state.priceHistory.length > 0 && state.priceHistory[0]!.atMs < atMs - DAY_MS) {
      state.priceHistory.shift();
    }
    this.options.handlers.onPrice(state.config.id, simPrice, atMs);
  }

  private acceptTape(marketId: number, update: TapeUpdate, readAtMs: number): void {
    const state = this.stateOfChainMarket(marketId);
    if (update.lost > 0n) {
      this.options.handlers.onError(
        `${state.config.id}: ${update.lost} fills left the tape before they were read`,
        null,
      );
    }
    for (const chainFill of update.fills) this.acceptFill(state, chainFill);
    this.secrets.forgetEndedBefore(state.config.id, readAtMs);
  }

  private acceptFill(state: MarketState, chainFill: ChainFill): void {
    const sequence = Number(chainFill.sequence);
    const replayed = sequence <= (this.options.recordedThrough[state.config.id] ?? 0);
    state.tapeCursor = Math.max(state.tapeCursor, sequence);
    const fill: Fill = {
      market: state.config.id,
      price: toSimPrice(state.units, chainFill.price),
      size: toSimSize(state.units, chainFill.size),
      takerSide: chainFill.takerSide,
      takerTag: tagOf(chainFill.takerReceipt),
      makerTag: tagOf(chainFill.makerReceipt),
      timestampMs: chainFill.timeSeconds * 1000,
      sequence,
    };
    state.recentFills.push({ atMs: fill.timestampMs, notional: chainFill.price * chainFill.size });
    while (state.recentFills.length > 0 && state.recentFills[0]!.atMs < Date.now() - DAY_MS) {
      state.recentFills.shift();
    }
    const origin = originOf(fillRoles(chainFill, this.secrets.of(state.config.id)));
    this.options.handlers.onFill({ fill, origin, replayed });
    if (!replayed) for (const listener of this.listeners) listener(fill);
  }

  private acceptStats(stats: ChainStats): void {
    this.chainStats = stats;
    this.options.handlers.onChainStats(stats);
  }

  private async publishNext(state: MarketState): Promise<void> {
    if (state.publishing || state.target === null || state.price === null) return;
    state.publishing = true;
    try {
      const price = nextPublishPrice({
        current: state.price.price,
        target: roundDownToChainPrice(state.units, state.target, state.chain.tick),
        maxMoveBps: state.chain.maxMoveBps,
        tick: state.chain.tick,
      });
      if (price === 0n) return;
      await this.options.program.publishPrice(
        this.oracleConnection,
        this.options.settings.oracle,
        state.chain.marketId,
        price,
      );
      state.publishedAtMs = Date.now();
    } catch (error) {
      this.options.handlers.onError(`publishing the ${state.config.id} price`, error);
    } finally {
      state.publishing = false;
    }
  }

  /** When this process saw the chain itself accept fills: the start of what the counters cover. */
  get countingSinceMs(): number {
    return this.startedAtMs;
  }

  tapeCursors(): Record<MarketId, number> {
    const cursors: Record<MarketId, number> = {};
    for (const [market, state] of this.states) cursors[market] = state.tapeCursor;
    return cursors;
  }

  readiness(): Readiness {
    const now = Date.now();
    const states = [...this.states.values()];
    return {
      connected: now - this.feed.readAtMs < CONNECTED_WITHIN_MS,
      pricesFresh: states.every((state) => {
        const maxAgeMs = state.chain.maxPriceAgeSeconds * 1000;
        return (
          state.price !== null &&
          state.price.price > 0n &&
          now - state.publishedAtMs < maxAgeMs &&
          now - state.price.publishTimeSeconds * 1000 < maxAgeMs
        );
      }),
      botsFunded: this.options.bots.every((bot) => this.funded.has(bot.key)),
    };
  }

  async markets(): Promise<MarketInfo[]> {
    const now = Date.now();
    return [...this.states.values()].map((state) => {
      const mark =
        state.price && state.price.price > 0n ? toSimPrice(state.units, state.price.price) : null;
      const reference = state.priceHistory.find((sample) => sample.atMs >= now - DAY_MS);
      const perp = state.chain.kind === "perp";
      return {
        id: state.config.id,
        kind: state.config.kind,
        base: state.config.base,
        quote: state.config.quote,
        tickSize: toSimPrice(state.units, state.chain.tick),
        lotSize: toSimSize(state.units, 1n),
        maxLeverage: perp ? Math.floor(10_000 / state.chain.imBps) : 0,
        markPrice: mark,
        markPriceUpdatedAtMs: state.price && mark ? state.price.publishTimeSeconds * 1000 : null,
        change24h:
          mark && reference
            ? (Number(mark - reference.price) / Number(reference.price)) * 100
            : null,
        volume24h: state.recentFills
          .filter((entry) => entry.atMs >= now - DAY_MS)
          .reduce((sum, entry) => sum + entry.notional, 0n),
        openInterest:
          perp && this.chainStats
            ? toSimSize(state.units, this.chainStats.openInterest[state.chain.marketId] ?? 0n)
            : null,
      };
    });
  }

  /** Sets where the mark should be. The publish loop walks the chain's price there. */
  async publishPrice(market: MarketId, price: bigint): Promise<void> {
    this.state(market).target = price;
  }

  private bot(trader: TraderKey): BotSpec | undefined {
    return this.options.bots.find((bot) => bot.key === trader);
  }

  private async traderOf(trader: TraderKey): Promise<ProgramTrader> {
    const open = this.traders.get(trader);
    if (open) return open;
    const bot = this.bot(trader);
    if (!bot) {
      throw new Error(`${trader} is not a trader of this service: users open their own account`);
    }
    let opening = this.opening.get(trader);
    if (!opening) {
      opening = this.options.program
        .openOwnTrader(
          this.options.settings.rollupRpcUrl,
          bot.owner,
          this.options.settings.gate,
          this.gateConnection,
        )
        .finally(() => this.opening.delete(trader));
      this.opening.set(trader, opening);
    }
    const opened = await opening;
    this.traders.set(trader, opened);
    return opened;
  }

  async openTrader(trader: TraderKey): Promise<void> {
    await this.traderOf(trader);
  }

  /**
   * Brings a bot's balance up to `amount` from the faucet, never above it, so
   * a restart does not pay the bots again. A bot's nUSD is held as
   * perpetuals collateral, as a spot balance, or both, by what it trades.
   */
  async deposit(trader: TraderKey, token: string, amount: bigint): Promise<void> {
    if (amount <= 0n) return;
    const bot = this.bot(trader);
    const chainSymbol = CHAIN_TOKEN_OF[token];
    const chainToken = this.options.settings.deployment.tokens.find(
      (entry) => entry.symbol === chainSymbol,
    );
    if (!bot || !chainToken) throw new Error(`no deposit of ${token} for ${trader} on this venue`);
    const programTrader = await this.traderOf(trader);
    await programTrader.sync(this.firstMarketId());
    const view = await programTrader.view();
    const wanted = toChainAmount(amount, chainToken.decimals);
    const spot = view.spot[chainToken.index]!;
    const targets: { target: DepositTarget; held: bigint }[] = [];
    if (token !== COLLATERAL_TOKEN || bot.tradesSpot) {
      targets.push({
        target: { spotToken: chainToken.index },
        held: spot.available + spot.locked,
      });
    }
    if (token === COLLATERAL_TOKEN && bot.tradesPerps) {
      targets.push({ target: "collateral", held: view.collateral });
    }
    for (const { target, held } of targets) {
      if (held >= wanted) continue;
      await this.options.program.deposit(
        this.faucetConnection,
        this.options.settings.faucet,
        chainToken.mint,
        view.seat,
        target,
        wanted - held,
      );
    }
    this.funded.add(trader);
  }

  private firstMarketId(): number {
    return [...this.states.values()][0]!.chain.marketId;
  }

  async placeOrder(trader: TraderKey, order: NewOrder): Promise<PlaceResult> {
    this.orderCounter += 1;
    const orderId = `${trader}#${this.orderCounter}`;
    const state = this.state(order.market);
    const mark = state.price?.price ?? 0n;
    if (mark === 0n) return rejected(orderId, order, "no mark price yet");

    const { chain, units } = state;
    const band = (mark * BigInt(chain.bandBps)) / 10_000n;
    const bandEdge =
      order.side === "buy"
        ? mark + band - ((mark + band) % chain.tick)
        : mark - band + ((chain.tick - ((mark - band) % chain.tick)) % chain.tick);
    const price = order.price === undefined ? bandEdge : toChainPrice(units, order.price);
    const size = toChainSize(units, order.size);
    if (price === null || price <= 0n || price % chain.tick !== 0n) {
      return rejected(orderId, order, "price is not on the tick");
    }
    if (size === null || size < chain.minSize) {
      return rejected(orderId, order, "size is below the minimum or not a whole number of lots");
    }
    if (price * size < chain.minNotional) {
      return rejected(orderId, order, "notional is below the minimum");
    }

    const rests = order.type === "limit" || order.type === "postOnly";
    const secret = newOrderSecret();
    this.secrets.add(order.market, trader, secret);
    let outcome: PlaceOutcome;
    try {
      const programTrader = await this.traderOf(trader);
      outcome = await programTrader.place(
        chain.marketId,
        {
          side: order.side,
          type: order.type,
          price,
          size,
          reduceOnly: order.reduceOnly ?? false,
          secret,
          restingExpirySeconds:
            rests && !order.reduceOnly
              ? Math.floor(Date.now() / 1000) + this.options.quoteExpirySeconds
              : undefined,
        },
        this.perpMarketIds(),
      );
    } catch (error) {
      this.secrets.retire(secret, Date.now());
      return rejected(orderId, order, error instanceof Error ? error.message : "send failed");
    }
    if (outcome.status !== "rested") this.secrets.retire(secret, Date.now());
    this.recordLatency(outcome);
    this.options.handlers.onBotOrder(trader, outcome);

    const filledSize = toSimSize(units, outcome.filled);
    const partly = outcome.filled > 0n && outcome.filled < size;
    const status = {
      filled: "filled",
      rested: partly ? "partiallyFilled" : "open",
      cancelled: outcome.filled > 0n ? "partiallyFilled" : "cancelled",
      refused: "rejected",
      expired: "rejected",
    }[outcome.status] as PlaceResult["status"];
    return {
      orderId,
      tag: 0n,
      status,
      filledSize,
      remainingSize: order.size - filledSize,
      reason:
        outcome.status === "expired"
          ? "no result before the order expired"
          : outcome.status === "refused"
            ? "post-only order would match"
            : undefined,
    };
  }

  private recordLatency(outcome: PlaceOutcome): void {
    if (outcome.status === "expired") return;
    this.latencySamplesMs.push(outcome.sendToResultMs);
    if (this.latencySamplesMs.length > this.options.latencyWindowSize) {
      this.latencySamplesMs.shift();
    }
  }

  async cancelAll(trader: TraderKey, market: MarketId): Promise<number> {
    const programTrader = await this.traderOf(trader);
    const cancelled = await programTrader.cancelAll(this.state(market).chain.marketId);
    if (cancelled === null) return 0;
    this.secrets.retireAll(market, trader, Date.now());
    return Number(cancelled);
  }

  async traderState(trader: TraderKey): Promise<TraderState> {
    const view = await (await this.traderOf(trader)).view();
    const balances: TraderState["balances"] = {
      [COLLATERAL_TOKEN]: { balance: view.collateral, locked: 0n },
    };
    for (const token of this.options.settings.deployment.tokens) {
      const simToken = Object.keys(CHAIN_TOKEN_OF).find(
        (name) => CHAIN_TOKEN_OF[name] === token.symbol,
      );
      const held = view.spot[token.index];
      if (!simToken || !held) continue;
      balances[simToken === COLLATERAL_TOKEN ? SPOT_COLLATERAL_BALANCE : simToken] = {
        balance: toSimAmount(held.available, token.decimals),
        locked: toSimAmount(held.locked, token.decimals),
      };
    }

    const positions: TraderState["positions"] = {};
    const openOrders: TraderState["openOrders"] = [];
    let equity = view.collateral;
    for (const state of this.states.values()) {
      const { chain, units } = state;
      if (chain.marketId === view.ordersMarketId) {
        for (const order of view.orders) {
          openOrders.push({
            orderId: order.sequence.toString(),
            tag: 0n,
            market: state.config.id,
            side: order.side,
            type: "limit",
            price: toSimPrice(units, order.price),
            size: toSimSize(units, order.remaining),
            remainingSize: toSimSize(units, order.remaining),
            reduceOnly: false,
          });
        }
      }
      const slot = view.perp[chain.marketId];
      if (chain.kind !== "perp" || !slot || slot.base === 0n) continue;
      const lots = slot.base < 0n ? -slot.base : slot.base;
      const paid = slot.quote < 0n ? -slot.quote : slot.quote;
      positions[state.config.id] = {
        size: slot.base * units.sizePerLot,
        entryPrice: toSimPrice(units, paid / lots),
      };
      equity += slot.base * (state.price?.price ?? 0n) + slot.quote;
    }
    return { trader, balances, positions, openOrders, equity };
  }

  /** The rollup's own scheduler advances funding. Only a market without one is called here. */
  async updateFunding(market: MarketId): Promise<void> {
    const state = this.state(market);
    if (state.scheduledFunding || state.chain.kind !== "perp") return;
    await this.options.program.updateFunding(
      this.oracleConnection,
      this.options.settings.oracle,
      state.chain.marketId,
    );
  }

  /** The seats the liquidator tries next, as targets `liquidate` accepts. */
  nextLiquidationTargets(count: number): TraderKey[] {
    return this.sweep.next(count).map(seatTarget);
  }

  async liquidate(liquidator: TraderKey, target: TraderKey, market: MarketId): Promise<boolean> {
    const seat = seatOfTarget(target);
    if (seat === null) return false;
    const outcome = await this.tryLiquidation(liquidator, seat, market);
    if (outcome !== "noResult" && outcome !== "stalePrice") {
      this.sweep.report(outcome !== "seatNotOpen");
    }
    return outcome === "liquidated";
  }

  private async tryLiquidation(liquidator: TraderKey, seat: number, market: MarketId) {
    const state = this.state(market);
    const mark = state.price?.price ?? 0n;
    if (mark === 0n) return "noResult" as const;
    const programTrader = await this.traderOf(liquidator);
    return programTrader.liquidate(state.chain.marketId, seat, mark, this.perpMarketIds());
  }

  /**
   * Whether a seat is open, learned the only way the program allows: a blind
   * liquidation attempt, whose result only the liquidator can read. Null when
   * the attempt said nothing either way.
   */
  private async seatIsOpen(prober: TraderKey, seat: number): Promise<boolean | null> {
    const perp = [...this.states.values()].find((state) => state.chain.kind === "perp");
    if (!perp) return null;
    const outcome = await this.tryLiquidation(prober, seat, perp.config.id);
    if (outcome === "noResult" || outcome === "stalePrice") return null;
    return outcome !== "seatNotOpen";
  }

  private async ownSeats(): Promise<number[]> {
    const seats: number[] = [];
    for (const trader of this.traders.values()) seats.push((await trader.view()).seat);
    return seats;
  }

  /** The desk that opens and funds users, probing seats through the bot trader `prober`. */
  fundingDesk(prober: TraderKey, amount: bigint, clock: Clock): FundingDesk {
    const { settings, program } = this.options;
    const collateral = settings.deployment.tokens.find(
      (token) => token.symbol === CHAIN_TOKEN_OF[COLLATERAL_TOKEN],
    );
    if (!collateral) throw new Error("the deployment has no nUSD token");
    return new FundingDesk({
      program,
      connection: this.faucetConnection,
      gate: settings.gate,
      faucet: settings.faucet,
      mint: collateral.mint,
      amountAtoms: toChainAmount(amount, collateral.decimals),
      clock,
      seatIsOpen: (seat) => this.seatIsOpen(prober, seat),
      knownOpenSeats: () => this.ownSeats(),
    });
  }

  onFill(listener: (fill: Fill) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  latency(): LatencyStats {
    const sorted = [...this.latencySamplesMs].sort((a, b) => a - b);
    return {
      medianMs: percentile(sorted, 0.5),
      p99Ms: percentile(sorted, 0.99),
      sampleSize: sorted.length,
      measuredFrom: this.options.measuredFrom,
    };
  }

  async stats(): Promise<VenueStats> {
    const chain = this.chainStats;
    return {
      ordersTotal: Number(chain?.orders ?? 0n),
      fillsTotal: Number(chain?.fills ?? 0n),
      volumeTotal: (chain?.volume ?? []).reduce((sum, volume) => sum + volume, 0n),
      tradersTotal: this.traders.size,
      latency: this.latency(),
      updatedAtMs: Date.now(),
    };
  }
}
