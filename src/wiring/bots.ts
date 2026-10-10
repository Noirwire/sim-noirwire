import { FundingUpdater } from "../bots/funding-updater.js";
import { HouseMaker } from "../bots/house-maker.js";
import { Liquidator } from "../bots/liquidator.js";
import { NoiseTaker } from "../bots/noise-taker.js";
import { SeededRandom } from "../bots/rng.js";
import type { Config } from "../config/config.js";
import { systemClock } from "../engine/clock.js";
import { MARKETS, type MarketConfig, PERP_MARKET_IDS } from "../engine/markets.js";
import { type Repeating, every } from "../scheduling/repeating.js";
import type { BotSizes, VenueWiring } from "./venue-wiring.js";

const MAKER_QUOTE_PER_POSITION_LIMIT = 4n;
const SPOT_MAKER_BASE_PER_TAKER_BASE = 10n;
/** The funding updater decides by its own clock whether an update is due; this is how often it looks. */
const FUNDING_CHECK_AT_MOST_EVERY_MS = 5_000;

const houseMaker = (config: Config, market: MarketConfig, sizes: BotSizes): HouseMaker =>
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
    traderCount: config.NOISE_TAKER_COUNT,
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
 * Opens and funds the makers, then starts every bot's loop: a maker and a
 * noise taker per market, one liquidator, and the funding updater where the
 * venue needs one.
 */
export const startBots = async (
  config: Config,
  wiring: VenueWiring,
  onError: (what: string, error: unknown) => void,
): Promise<Repeating[]> => {
  const { venue, botVenue } = wiring;
  const random = new SeededRandom(config.NOISE_TAKER_SEED);
  const makers: HouseMaker[] = [];
  const takers: NoiseTaker[] = [];
  for (const market of MARKETS) {
    const sizes = await wiring.botSizes(market);
    const maker = houseMaker(config, market, sizes);
    await maker.ensureOpen(botVenue);
    makers.push(maker);
    takers.push(noiseTaker(config, market, sizes, random));
  }
  await wiring.afterMakersOpen();

  const liquidator = new Liquidator({
    markets: PERP_MARKET_IDS,
    startingQuoteBalance: config.LIQUIDATOR_STARTING_NUSD,
  });
  const loop = (what: string, intervalMs: number, tick: () => Promise<void>): Repeating =>
    every(intervalMs, tick, (error) => onError(what, error));
  const loops = [
    ...makers.map((maker) =>
      loop("maker tick failed", config.HOUSE_MAKER_TICK_MS, () => maker.tick(botVenue)),
    ),
    ...takers.map((taker) =>
      loop("taker tick failed", config.NOISE_TAKER_TICK_MS, () => taker.tick(botVenue)),
    ),
    loop("liquidator tick failed", config.LIQUIDATOR_INTERVAL_MS, () =>
      liquidator.tick(botVenue, wiring.liquidationTargets()),
    ),
  ];
  if (wiring.needsFundingUpdater) {
    const fundingUpdater = new FundingUpdater({
      markets: PERP_MARKET_IDS,
      intervalMs: config.FUNDING_INTERVAL_MS,
      clock: systemClock,
    });
    loops.push(
      loop(
        "funding update failed",
        Math.min(config.FUNDING_INTERVAL_MS, FUNDING_CHECK_AT_MOST_EVERY_MS),
        () => fundingUpdater.tick(venue),
      ),
    );
  }
  return loops;
};
