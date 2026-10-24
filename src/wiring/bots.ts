import { readFile } from "node:fs/promises";
import { makerTraderKey } from "../bots/bot-traders.js";
import { FundingUpdater } from "../bots/funding-updater.js";
import { HedgeController, type HedgeGate } from "../hedge/hedge-controller.js";
import type { HedgeVenue } from "../hedge/hedge-venue.js";
import { UnknownOrderStore, hedgeOrderPath } from "../hedge/unknown-order-store.js";
import { healthPing } from "../bots/health-ping.js";
import { HouseMaker } from "../bots/house-maker.js";
import { Liquidator } from "../bots/liquidator.js";
import { MakerControl, controlPath } from "../bots/maker-control.js";
import { MakerRisk, type MakerVoice } from "../bots/maker-risk.js";
import { MakerSafety } from "../bots/maker-safety.js";
import { MakerLedger, makerStatePath } from "../bots/maker-state.js";
import { NoiseTaker } from "../bots/noise-taker.js";
import { SeededRandom } from "../bots/rng.js";
import { type Config, isMainnet } from "../config/config.js";
import { systemClock } from "../engine/clock.js";
import type { MarketConfig } from "../engine/markets.js";
import type { Venue } from "../engine/types.js";
import { ReferencePrice, referenceSources } from "../prices/reference-price.js";
import { type Repeating, every } from "../scheduling/repeating.js";
import { KeeperHeartbeat } from "./keeper-heartbeat.js";
import { TradingWatch } from "./trading-watch.js";
import type { BotSizes, VenueWiring } from "./venue-wiring.js";

const MAKER_QUOTE_PER_POSITION_LIMIT = 4n;
const SPOT_MAKER_BASE_PER_TAKER_BASE = 10n;
/** The funding updater decides by its own clock whether an update is due; this is how often it looks. */
const FUNDING_CHECK_AT_MOST_EVERY_MS = 5_000;
/** The market whose price the reference sources give. */
const REFERENCE_BASE_TOKEN = "SOL";
/** A read of the venue's markets, or of the keeper's heartbeat file, that takes longer than this counts as failed. */
const MARKETS_READ_DEADLINE_MS = 10_000;
const MARKET_NOT_READ_YET = "the market has not been read yet";

/** `read`'s answer, or an error once the deadline passes. An answer that comes later is dropped. */
const readWithinDeadline = <T>(
  read: () => Promise<T>,
  what = "the venue did not list its markets",
): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${what} within ${MARKETS_READ_DEADLINE_MS} ms`));
    }, MARKETS_READ_DEADLINE_MS);
    read().then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });

export interface BotProblems {
  onError(what: string, error: unknown): void;
  onRecovered(what: string): void;
}

/** What the maker says to an operator goes to the log, as an event with no error behind it. */
const makerVoice = (problems: BotProblems): MakerVoice => ({
  alert: (message) => problems.onError(message, null),
  notice: (message) => problems.onError(message, null),
});

/** HEDGE_ENABLED is set but the service cannot hedge as configured. It cannot start. */
export class HedgeNotAvailable extends Error {
  constructor(reason: string) {
    super(`HEDGE_ENABLED=1 cannot start: ${reason}`);
    this.name = "HedgeNotAvailable";
  }
}

/** The hedge controller for one maker, or nothing while hedging is off. */
const hedgeController = (
  config: Config,
  market: MarketConfig,
  ledger: MakerLedger,
  reference: ReferencePrice,
  botVenue: Venue,
  hedgeVenue: HedgeVenue | undefined,
  problems: BotProblems,
): HedgeController => {
  if (!hedgeVenue) {
    throw new HedgeNotAvailable(
      "no hedge venue was supplied. Set HEDGE_VENUE_MODULE, or unset HEDGE_ENABLED to run the maker unhedged.",
    );
  }
  if (config.HEDGE_SOFT_UNHEDGED_NUSD >= config.HEDGE_HARD_UNHEDGED_NUSD) {
    throw new HedgeNotAvailable("HEDGE_SOFT_UNHEDGED_NUSD must be below HEDGE_HARD_UNHEDGED_NUSD.");
  }
  const trader = makerTraderKey(market.id);
  return new HedgeController({
    venue: hedgeVenue,
    clock: systemClock,
    reference,
    makerPosition: async () =>
      (await botVenue.traderState(trader)).positions[market.id]?.size ?? 0n,
    makerMode: () => ledger.hedgeMode,
    voice: makerVoice(problems),
    market: market.id,
    unknownOrders: new UnknownOrderStore(hedgeOrderPath(config.DATA_DIR, market.id)),
    settings: {
      softUnhedgedNotional: config.HEDGE_SOFT_UNHEDGED_NUSD,
      hardUnhedgedNotional: config.HEDGE_HARD_UNHEDGED_NUSD,
      confirmTimeoutMs: config.HEDGE_CONFIRM_TIMEOUT_SECONDS * 1_000,
      maxLeverage: config.HEDGE_MAX_LEVERAGE,
    },
  });
};

/** The risk rules for one maker. They know the SOL price only, so they cover SOL perpetuals only. */
const makerSafety = (
  market: MarketConfig,
  ledger: MakerLedger,
  reference: ReferencePrice,
  control: MakerControl,
  problems: BotProblems,
  hedge?: HedgeGate,
): MakerSafety => {
  if (market.kind !== "perp" || market.base !== REFERENCE_BASE_TOKEN) {
    throw new Error(
      `HOUSE_MAKER_RISK_RULES cannot cover ${market.id}: the risk rules need a reference price, ` +
        "and this service has one for SOL perpetuals only. Leave the market out of the deployment.",
    );
  }
  const voice = makerVoice(problems);
  return new MakerSafety({
    reference,
    risk: new MakerRisk(ledger, systemClock, market.id, voice),
    control,
    clock: systemClock,
    voice,
    market: market.id,
    hedge,
  });
};

const houseMaker = (
  config: Config,
  market: MarketConfig,
  sizes: BotSizes,
  extras: { safety?: MakerSafety; ledger?: MakerLedger; afterRequote?: () => void },
): HouseMaker =>
  new HouseMaker({
    market: market.id,
    kind: market.kind,
    baseToken: market.base,
    quoteToken: market.quote,
    levels: config.HOUSE_MAKER_LEVELS,
    spreadBps: config.HOUSE_MAKER_SPREAD_BPS,
    levelStepBps: config.HOUSE_MAKER_LEVEL_STEP_BPS,
    baseSizePerLevel: sizes.makerLevel,
    requoteThresholdBps: config.HOUSE_MAKER_REQUOTE_THRESHOLD_BPS,
    requoteIntervalMs: config.HOUSE_MAKER_REQUOTE_INTERVAL_MS,
    positionLimitNotional: config.HOUSE_MAKER_POSITION_LIMIT_NUSD,
    maxSkewBps: config.HOUSE_MAKER_MAX_SKEW_BPS,
    lotSize: sizes.lotSize,
    startingQuoteBalance: config.HOUSE_MAKER_POSITION_LIMIT_NUSD * MAKER_QUOTE_PER_POSITION_LIMIT,
    startingBaseBalance: config.NOISE_TAKER_STARTING_BASE * SPOT_MAKER_BASE_PER_TAKER_BASE,
    clock: systemClock,
    ...extras,
  });

const noiseTaker = (
  config: Config,
  market: MarketConfig,
  sizes: BotSizes,
  random: SeededRandom,
): NoiseTaker =>
  new NoiseTaker({
    market: market.id,
    baseToken: market.base,
    traderCount: Math.min(config.NOISE_TAKER_ACTIVE, config.NOISE_TAKER_COUNT),
    minSize: sizes.takerMin,
    maxSize: sizes.takerMax,
    lotSize: sizes.lotSize,
    minIntervalMs: config.NOISE_TAKER_MIN_INTERVAL_MS,
    maxIntervalMs: config.NOISE_TAKER_MAX_INTERVAL_MS,
    worstPriceSlippageBps: config.NOISE_TAKER_WORST_SLIPPAGE_BPS,
    startingQuoteBalance: config.NOISE_TAKER_STARTING_NUSD,
    startingBaseBalance: sizes.takerStartingBase,
    clock: systemClock,
    random,
  });

/**
 * Whether the makers are quoting under a working hedge. Not the same as the process being alive. A
 * hedge that is only `lagging` counts as ready (the maker already quotes wider for it). A venue that
 * would refuse the maker's quotes counts as not ready too, which covers a stale mark (a price crank
 * that is down) and a dislocated or paused market. The liquidation keeper runs outside this
 * process, so it is covered through its heartbeat file (`KEEPER_HEARTBEAT_FILE`): a stale, missing
 * or malformed heartbeat is not ready, and so is no file configured on mainnet.
 */
export interface TradingReadiness {
  ready: boolean;
  /** What is wrong, in words, when it is not ready. */
  reason?: string;
}

export interface OpenedBots {
  /** Starts every bot's loop. */
  start(): Repeating[];
  /** Not ready while a maker is stopped, its hedge is blind or the venue would refuse its quotes. */
  trading(): TradingReadiness;
  /** Asleep nothing quotes, so the only thing wrong can be a hedge position left open with no maker to manage it. */
  tradingWhileAsleep(): TradingReadiness;
  /** Takes every maker's quotes off the venue. Call it once the loops have stopped. */
  withdrawQuotes(): Promise<void>;
  /**
   * Reads every hedge account once, with the venue call deadlines, for the asleep readiness answer. Call it
   * once the loops have stopped. A read that fails leaves that hedge unconfirmed, which is not ready.
   */
  confirmHedgesBeforeSleep(): Promise<void>;
}

/**
 * Opens and funds the makers, and returns what starts every bot's loop: a
 * maker per market, a noise taker per market and one liquidator where they
 * are enabled, and the funding updater where the venue needs one. Starting is
 * separate from opening so that the loops can be stopped and started again
 * without opening anything twice. Opening is safe to repeat after a failure.
 */
export const openBots = async (
  config: Config,
  wiring: VenueWiring,
  problems: BotProblems,
  hedgeVenue?: HedgeVenue,
): Promise<OpenedBots> => {
  const { venue, botVenue, botMarkets } = wiring;
  const random = new SeededRandom(config.NOISE_TAKER_SEED);
  const makers: HouseMaker[] = [];
  const takers: NoiseTaker[] = [];
  const hedges: { market: string; controller: HedgeController }[] = [];
  const ledgers: { market: string; ledger: MakerLedger }[] = [];
  const rules = config.HOUSE_MAKER_RISK_RULES;
  if (config.HEDGE_ENABLED && !rules) {
    throw new HedgeNotAvailable(
      "the hedge couples to the maker's risk rules, so set HOUSE_MAKER_RISK_RULES=1.",
    );
  }
  const reference = rules ? new ReferencePrice(referenceSources(), systemClock) : null;
  const control = new MakerControl(controlPath(config.DATA_DIR));
  const afterRequote = config.HEALTHCHECK_URL
    ? healthPing(config.HEALTHCHECK_URL, problems)
    : undefined;
  for (const market of botMarkets) {
    const sizes = await wiring.botSizes(market);
    // What a maker must remember lives beside the snapshot; the in-memory venue forgets it all at a restart.
    const ledger =
      rules || config.VENUE === "rollup"
        ? await MakerLedger.open(makerStatePath(config.DATA_DIR, market.id), {
            requireSavedState: isMainnet(config),
          })
        : undefined;
    if (ledger?.startedWithoutState) {
      problems.onError(
        `ALERT ${market.id} maker: no saved state was found on mainnet, so it starts stopped and reduce-only for the hedge. ` +
          `If this is the right data directory, run "node dist/kill-switch.js resume" to start it.`,
        null,
      );
    }
    const hedge =
      config.HEDGE_ENABLED && reference && ledger
        ? hedgeController(config, market, ledger, reference, botVenue, hedgeVenue, problems)
        : undefined;
    if (ledger) ledgers.push({ market: market.id, ledger });
    if (hedge) hedges.push({ market: market.id, controller: hedge });
    const safety =
      reference && ledger
        ? makerSafety(market, ledger, reference, control, problems, hedge)
        : undefined;
    const maker = houseMaker(config, market, sizes, { safety, ledger, afterRequote });
    await maker.ensureOpen(botVenue);
    makers.push(maker);
    if (config.NOISE_TAKERS_ENABLED) takers.push(noiseTaker(config, market, sizes, random));
  }
  await wiring.afterMakersOpen();

  const perpMarkets = botMarkets.filter((market) => market.kind === "perp").map(({ id }) => id);
  const liquidator = config.LIQUIDATOR_ENABLED
    ? new Liquidator({
        markets: perpMarkets,
        startingQuoteBalance: config.LIQUIDATOR_STARTING_NUSD,
      })
    : null;
  const fundingUpdater = new FundingUpdater({
    markets: perpMarkets,
    intervalMs: config.FUNDING_INTERVAL_MS,
    clock: systemClock,
  });
  const loop = (what: string, intervalMs: number, tick: () => Promise<void>): Repeating =>
    every(
      intervalMs,
      tick,
      (error) => problems.onError(what, error),
      () => problems.onRecovered(what),
    );
  /**
   * Why the venue would refuse each maker's quotes, as the last read found. Every market starts as
   * not read yet and goes back to it on a wake, so trading is not ready before a read has said it is.
   */
  const quotesRefused = new Map<string, string>();
  const markNotRead = (): void => {
    for (const { id } of botMarkets) quotesRefused.set(id, MARKET_NOT_READ_YET);
  };
  markNotRead();
  const keeperFile = config.KEEPER_HEARTBEAT_FILE;
  // Readiness is a synchronous function of cached state, so the file is read by the readiness loop, not by `trading()`.
  const keeper = new KeeperHeartbeat(
    keeperFile
      ? () =>
          readWithinDeadline(
            () => readFile(keeperFile, "utf8"),
            "the keeper heartbeat file was not read",
          )
      : undefined,
    isMainnet(config),
    config.KEEPER_HEARTBEAT_MAX_AGE_MS,
    systemClock,
  );
  const readQuotesRefused = async (): Promise<void> => {
    let infos: Awaited<ReturnType<typeof botVenue.markets>>;
    try {
      infos = await readWithinDeadline(() => botVenue.markets());
    } catch (error) {
      for (const { id } of botMarkets) quotesRefused.set(id, "the market could not be read");
      throw error;
    }
    for (const { id } of botMarkets) {
      const info = infos.find((entry) => entry.id === id);
      const refused = info ? info.quotesRefusedBecause : "the venue does not list the market";
      if (refused !== undefined && info?.takesReduceOnlyOrders !== true)
        quotesRefused.set(id, refused);
      else quotesRefused.delete(id);
    }
  };
  // With no maker there is nothing to quote and trading has nothing to be not ready about, so there is nothing to watch.
  const watch =
    botMarkets.length > 0
      ? new TradingWatch(() => trading(), makerVoice(problems), systemClock)
      : null;
  const start = (): Repeating[] => {
    const loops = [
      ...makers.map((maker, at) =>
        loop(`${botMarkets[at].id} maker tick`, config.HOUSE_MAKER_TICK_MS, () =>
          maker.tick(botVenue),
        ),
      ),
      ...hedges.map(({ market, controller }) =>
        loop(`${market} hedge tick`, config.HOUSE_MAKER_TICK_MS, () => controller.tick()),
      ),
      ...takers.map((taker, at) =>
        loop(`${botMarkets[at].id} taker tick`, config.NOISE_TAKER_TICK_MS, () =>
          taker.tick(botVenue),
        ),
      ),
    ];
    if (watch) {
      watch.resume();
      markNotRead();
      keeper.reset();
      loops.push(
        loop("trading readiness", config.HOUSE_MAKER_TICK_MS, async () => {
          const keeperRead = keeper.poll();
          try {
            await readQuotesRefused();
          } finally {
            await keeperRead;
            watch.check();
          }
        }),
      );
    }
    if (liquidator) {
      loops.push(
        loop("liquidator tick", config.LIQUIDATOR_INTERVAL_MS, () =>
          liquidator.tick(botVenue, wiring.liquidationTargets()),
        ),
      );
    }
    if (wiring.needsFundingUpdater) {
      loops.push(
        loop(
          "funding update",
          Math.min(config.FUNDING_INTERVAL_MS, FUNDING_CHECK_AT_MOST_EVERY_MS),
          () => fundingUpdater.tick(venue),
        ),
      );
    }
    return loops;
  };
  const withdrawQuotes = async (): Promise<void> => {
    const withdrawn = await Promise.allSettled(makers.map((maker) => maker.withdraw(botVenue)));
    withdrawn.forEach((result, at) => {
      if (result.status === "rejected") {
        problems.onError(
          `${botMarkets[at].id} maker could not cancel its quotes; they expire by themselves`,
          result.reason,
        );
      }
    });
  };
  const confirmHedgesBeforeSleep = async (): Promise<void> => {
    await Promise.all(hedges.map(({ controller }) => controller.confirmBeforeSleep()));
  };
  const unmanagedHedges = (): string[] => [
    ...hedges
      .filter(({ controller }) => controller.hasUnmanagedPosition)
      .map(({ market }) => `${market} maker is stopped with an open hedge position`),
    ...hedges
      .filter(({ controller }) => controller.unconfirmedWhileAsleep)
      .map(({ market }) => `${market} hedge position could not be confirmed before sleep`),
  ];
  const unconfirmedCancels = (): string[] =>
    makers.flatMap((maker, at) =>
      maker.cancelUnconfirmed
        ? [`${botMarkets[at].id} maker's cancel is not confirmed, so its quotes may still stand`]
        : [],
    );
  const readinessOf = (problems: string[]): TradingReadiness =>
    problems.length === 0 ? { ready: true } : { ready: false, reason: problems.join("; ") };
  // With no maker nothing polls the heartbeat and there is nothing to quote, so it is not asked.
  const keeperProblems = (): string[] => {
    const problem = botMarkets.length > 0 ? keeper.problem() : undefined;
    return problem === undefined ? [] : [problem];
  };
  const trading = (): TradingReadiness =>
    readinessOf([
      ...ledgers
        .filter(({ ledger }) => ledger.state.mode === "stopped")
        .map(({ market }) => `${market} maker is stopped`),
      ...makers.flatMap((maker, at) =>
        maker.quarantinedSinceMs === null
          ? []
          : [`${botMarkets[at].id} maker is held by an order of unknown outcome`],
      ),
      ...unconfirmedCancels(),
      ...hedges
        .filter(({ controller }) => controller.status() === "blind")
        .map(({ market }) => `${market} hedge is blind`),
      ...unmanagedHedges(),
      ...[...quotesRefused].map(([market, why]) => `${market} quotes would be refused: ${why}`),
      ...keeperProblems(),
    ]);
  const tradingWhileAsleep = (): TradingReadiness =>
    readinessOf([...unmanagedHedges(), ...unconfirmedCancels()]);
  return { start, trading, tradingWhileAsleep, withdrawQuotes, confirmHedgesBeforeSleep };
};
