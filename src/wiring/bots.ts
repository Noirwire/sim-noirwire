import { makerTraderKey } from "../bots/bot-traders.js";
import { FundingUpdater } from "../bots/funding-updater.js";
import { HedgeController, type HedgeGate } from "../hedge/hedge-controller.js";
import type { HedgeVenue } from "../hedge/hedge-venue.js";
import { healthPing } from "../bots/health-ping.js";
import { HouseMaker } from "../bots/house-maker.js";
import { Liquidator } from "../bots/liquidator.js";
import { MakerControl, controlPath } from "../bots/maker-control.js";
import { MakerRisk, type MakerVoice } from "../bots/maker-risk.js";
import { MakerSafety } from "../bots/maker-safety.js";
import { MakerLedger, makerStatePath } from "../bots/maker-state.js";
import { NoiseTaker } from "../bots/noise-taker.js";
import { SeededRandom } from "../bots/rng.js";
import type { Config } from "../config/config.js";
import { systemClock } from "../engine/clock.js";
import type { MarketConfig } from "../engine/markets.js";
import type { Venue } from "../engine/types.js";
import { ReferencePrice, referenceSources } from "../prices/reference-price.js";
import { type Repeating, every } from "../scheduling/repeating.js";
import type { BotSizes, VenueWiring } from "./venue-wiring.js";

const MAKER_QUOTE_PER_POSITION_LIMIT = 4n;
const SPOT_MAKER_BASE_PER_TAKER_BASE = 10n;
/** The funding updater decides by its own clock whether an update is due; this is how often it looks. */
const FUNDING_CHECK_AT_MOST_EVERY_MS = 5_000;
/** The market whose price the reference sources give. */
const REFERENCE_BASE_TOKEN = "SOL";

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
      "this build has no client for a hedge venue. Unset HEDGE_ENABLED to run the maker unhedged.",
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
    makerMode: () => ledger.state.mode,
    voice: makerVoice(problems),
    market: market.id,
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

export interface OpenedBots {
  /** Starts every bot's loop. */
  start(): Repeating[];
  /** Takes every maker's quotes off the venue. Call it once the loops have stopped. */
  withdrawQuotes(): Promise<void>;
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
        ? await MakerLedger.open(makerStatePath(config.DATA_DIR, market.id))
        : undefined;
    const hedge =
      config.HEDGE_ENABLED && reference && ledger
        ? hedgeController(config, market, ledger, reference, botVenue, hedgeVenue, problems)
        : undefined;
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
  return { start, withdrawQuotes };
};
