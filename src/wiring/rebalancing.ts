import { join } from "node:path";
import type { MakerVoice } from "../bots/maker-risk.js";
import type { MakerLedger } from "../bots/maker-state.js";
import type { Config } from "../config/config.js";
import { systemClock } from "../engine/clock.js";
import type { MarketConfig } from "../engine/markets.js";
import type { FlowFence } from "../rebalance/flow-adjust.js";
import { Rebalancer } from "../rebalance/rebalancer.js";
import { RequestSender } from "../rebalance/request-sender.js";
import type { RebalanceSettings } from "../rebalance/settings.js";
import type { VenueWiring } from "./venue-wiring.js";

const REFUSED_BACKOFF_MS = 60_000;

export class RebalanceNotAvailable extends Error {
  constructor(reason: string) {
    super(`REBALANCE_URL cannot start: ${reason}`);
    this.name = "RebalanceNotAvailable";
  }
}

/** The rebalancer of one maker: the bridge requests, the journal and the chain side, all kept in the data directory. */
export const openRebalancer = async (
  config: Config,
  settings: RebalanceSettings,
  wiring: VenueWiring,
  market: MarketConfig,
  ledger: MakerLedger,
  fence: FlowFence,
  voice: MakerVoice,
): Promise<Rebalancer> => {
  if (!wiring.rebalanceChain) {
    throw new RebalanceNotAvailable("this venue has no book to withdraw from. Set VENUE=rollup.");
  }
  const ladderNotional =
    config.HOUSE_MAKER_POSITION_LIMIT_NUSD +
    BigInt(config.HOUSE_MAKER_LEVELS) * config.ROLLUP_MAKER_LEVEL_NUSD;
  const sender = await RequestSender.open({
    path: join(config.DATA_DIR, `rebalance-requests-${market.id}.json`),
    url: settings.url,
    token: settings.token,
    label: market.id,
    clock: systemClock,
    cooldownMs: settings.cooldownMs,
    refusedBackoffMs: REFUSED_BACKOFF_MS,
  });
  const rebalancer = new Rebalancer({
    settings,
    sender,
    chain: wiring.rebalanceChain(market, settings, ladderNotional),
    journalPath: join(config.DATA_DIR, `rebalance-out-${market.id}.json`),
    ledger,
    fence,
    clock: systemClock,
    voice,
    market: market.id,
  });
  await rebalancer.start();
  return rebalancer;
};
