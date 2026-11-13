import { z } from "zod";
import { DECIMAL_TEXT, fromDecimalString } from "../engine/money.js";
import { mainnetConfig } from "./mainnet.js";
import { SIM_ROLES, type SimRole, roleProblems } from "./role.js";

const decimalAmount = (defaultValue: string) =>
  z
    .string()
    .regex(DECIMAL_TEXT, "must be a plain decimal number")
    .default(defaultValue)
    .transform((value) => fromDecimalString(value));

const boolFlag = (defaultValue: "0" | "1") =>
  z
    .enum(["0", "1"])
    .default(defaultValue)
    .transform((value) => value === "1");

const onOffFlag = (defaultValue: "on" | "off") =>
  z
    .enum(["on", "off"])
    .default(defaultValue)
    .transform((value) => value === "on");

const positiveInt = (defaultValue: number) =>
  z.coerce.number().int().positive().default(defaultValue);

const commaSeparated = (defaultValue: string) =>
  z
    .string()
    .default(defaultValue)
    .transform((value) =>
      value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean),
    );

const questNumber = () =>
  z.string().regex(/^\d*$/, "must be the quest's number on quests.magicblock.app").optional();

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** A URL a bearer key may be sent to: https, or http only on this machine. */
const keyBearingUrl = (defaultValue: string) =>
  z
    .url()
    .default(defaultValue)
    .refine((text) => {
      const url = new URL(text);
      return (
        url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname))
      );
    }, "must be https, or http on this machine");

/** Every variable this service reads, with its default. `.env.example` documents each one. */
const envSchema = z.object({
  /** Which part of the service this process runs (`config/role.ts`). Combined is everything in one process. */
  SIM_ROLE: z.enum(SIM_ROLES).default("combined"),
  PORT: positiveInt(4100),
  HOST: z.string().default("0.0.0.0"),
  VENUE: z.enum(["memory", "rollup"]).default("memory"),
  DEV_TRADING: boolFlag("0"),
  /** A label, except "mainnet": that runs only the maker, the gate and the market data (`mainnet.ts`). */
  NETWORK: z.string().default("devnet"),
  ALLOWED_ORIGINS: commaSeparated("http://localhost:3000"),
  /** How many reverse proxies sit in front of the service, so the per-IP limits see the caller. Required on mainnet. */
  TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).optional(),
  /** Mainnet: requests one address may make to the public API in a minute. */
  PUBLIC_RATE_LIMIT_PER_MINUTE: positiveInt(300),
  /** Mainnet: stream sockets one address may hold open at once. */
  PUBLIC_SOCKETS_PER_IP: positiveInt(5),
  DATA_DIR: z.string().default("./data"),
  SNAPSHOT_INTERVAL_MS: positiveInt(30_000),
  /** VENUE=rollup: how long the service keeps trading after the last request, with no stream socket open. */
  IDLE_AFTER_MS: positiveInt(10 * 60_000),
  /** VENUE=rollup: how long it keeps trading after the last stream socket closes, so a page reload does not stop it. */
  IDLE_AFTER_LAST_SOCKET_MS: positiveInt(15_000),

  FUND_AMOUNT_NUSD: decimalAmount("5000"),
  FUND_IP_RATE_LIMIT: positiveInt(20),
  FUND_IP_RATE_WINDOW_MS: positiveInt(60 * 60_000),

  JUPITER_BASE_URL: z.string().default("https://lite-api.jup.ag/price/v3"),
  JUPITER_POLL_INTERVAL_MS: positiveInt(4_000),

  INSURANCE_SEED_NUSD: decimalAmount("10000000"),
  MAX_FUNDING_RATE_BPS_PER_UPDATE: positiveInt(75),
  FUNDING_INTERVAL_MS: positiveInt(60_000),

  HOUSE_MAKER_TICK_MS: positiveInt(1_000),
  HOUSE_MAKER_LEVELS: positiveInt(5),
  HOUSE_MAKER_SPREAD_BPS: positiveInt(15),
  HOUSE_MAKER_LEVEL_STEP_BPS: positiveInt(5),
  HOUSE_MAKER_REQUOTE_THRESHOLD_BPS: positiveInt(12),
  HOUSE_MAKER_REQUOTE_INTERVAL_MS: positiveInt(90_000),
  HOUSE_MAKER_POSITION_LIMIT_NUSD: decimalAmount("50000"),
  HOUSE_MAKER_MAX_SKEW_BPS: positiveInt(20),
  /** The maker follows the risk rules (`bots/maker-safety.ts`). Always on, and not switchable off, on mainnet. */
  HOUSE_MAKER_RISK_RULES: boolFlag("0"),
  /** Pinged after each good requote of the house maker, so an outside monitor notices when the pings stop. */
  HEALTHCHECK_URL: z.url().optional(),
  /** File the liquidation keeper writes the time of its last healthy sweep to. Required on mainnet for trading to count as ready. */
  KEEPER_HEARTBEAT_FILE: z.string().min(1).optional(),
  /** Trading is not ready when that sweep is older than this. */
  KEEPER_HEARTBEAT_MAX_AGE_MS: positiveInt(30_000),
  /**
   * The network transport for the keeper's heartbeat, instead of the file: one `id=url` per keeper,
   * comma separated. Each keeper's status is signed with its own secret from KEEPER_HEARTBEAT_SECRETS_FILE
   * (`id=secret` per line). Setting both this and KEEPER_HEARTBEAT_FILE stops the start.
   */
  KEEPER_HEARTBEAT_URLS: z.string().min(1).optional(),
  KEEPER_HEARTBEAT_SECRETS_FILE: z.string().min(1).optional(),
  /** The keepers that must report a healthy, fresh sweep for the maker to quote. One of two copies is enough by default. */
  KEEPER_HEARTBEAT_MIN_HEALTHY: positiveInt(1),
  /** How often the maker asks each keeper; a failed ask is retried on the next readiness tick. */
  KEEPER_HEARTBEAT_POLL_MS: positiveInt(2_000),
  /**
   * On, a maker whose order key checkpoint is missing or no longer fits the chain refuses to start, and
   * never replaces its order keys by itself (`bin reset-order-keys` is the deliberate way). Unset: on for
   * mainnet, off elsewhere.
   */
  REQUIRE_KEY_CHECKPOINT: z
    .enum(["0", "1"])
    .optional()
    .transform((value) => (value === undefined ? undefined : value === "1")),

  /** Accounts are opened with a message the owner signs, not a transaction. Only valid once the deployed program has the signed instructions. */
  SIGNED_OWNER_ACTIONS: boolFlag("0"),

  /** The hedge controller offsets the maker's SOL exposure on an outside perpetuals venue. Off, nothing hedge-related runs. */
  HEDGE_ENABLED: boolFlag("0"),
  /** Absolute path of the module that supplies the hedge venue. Required with HEDGE_ENABLED=1, ignored otherwise. */
  HEDGE_VENUE_MODULE: z.string().optional(),
  /** Unhedged exposure from which the hedge is lagging and the maker quotes wider. */
  HEDGE_SOFT_UNHEDGED_NUSD: decimalAmount("100"),
  /** Unhedged exposure from which the hedge is blind and the maker only reduces. Must exceed the soft limit. */
  HEDGE_HARD_UNHEDGED_NUSD: decimalAmount("250"),
  /** No venue confirmation for this long makes the hedge lagging. */
  HEDGE_CONFIRM_TIMEOUT_SECONDS: positiveInt(60),
  /** Margin cap: the hedge position never grows past the hedge account's margin times this. */
  HEDGE_MAX_LEVERAGE: positiveInt(3),

  /** The noise takers trade at all. Off, none is opened, funded or started. */
  NOISE_TAKERS_ENABLED: boolFlag("1"),
  NOISE_TAKER_TICK_MS: positiveInt(500),
  NOISE_TAKER_COUNT: positiveInt(6),
  /** How many of the takers trade. Each one that trades keeps a client running on the rollup. */
  NOISE_TAKER_ACTIVE: positiveInt(2),
  NOISE_TAKER_MIN_INTERVAL_MS: positiveInt(3_000),
  NOISE_TAKER_MAX_INTERVAL_MS: positiveInt(5_000),
  NOISE_TAKER_WORST_SLIPPAGE_BPS: positiveInt(50),
  NOISE_TAKER_STARTING_NUSD: decimalAmount("100000"),
  NOISE_TAKER_STARTING_BASE: decimalAmount("1000"),
  NOISE_TAKER_SEED: positiveInt(42),

  /** The liquidator sweeps at all. Off, it is not opened, funded or started. */
  LIQUIDATOR_ENABLED: boolFlag("1"),
  LIQUIDATOR_INTERVAL_MS: positiveInt(60_000),
  LIQUIDATOR_STARTING_NUSD: decimalAmount("1000000"),

  /** MagicBlock quest points run only when this key and the three quest ids are all set. */
  MAGICBLOCK_QUESTS_API_KEY: z.string().optional(),
  MAGICBLOCK_QUESTS_URL: keyBearingUrl("https://quests.magicblock.app/api/validators/push"),
  QUEST_GET_STARTED_ID: questNumber(),
  QUEST_THREE_DAYS_ID: questNumber(),
  QUEST_STREAK_ID: questNumber(),

  STATS_LATENCY_WINDOW: positiveInt(500),

  // VENUE=rollup. `rollup/settings.ts` says which are required and checks them together.
  SOLANA_RPC_URL: z.string().optional(),
  ROLLUP_RPC_URL: z.string().optional(),
  ROLLUP_WS_URL: z.string().optional(),
  DEPOSIT_RPC_URL: z.string().optional(),
  DEPLOYMENT_JSON: z.string().optional(),
  DEPLOYMENT_PATH: z.string().optional(),
  GATE_SECRET_KEY: z.string().optional(),
  FAUCET_SECRET_KEY: z.string().optional(),
  GATE_SECRET_KEY_FILE: z.string().optional(),
  FAUCET_SECRET_KEY_FILE: z.string().optional(),
  BOT_TRADER_SEEDS: z.string().optional(),
  BOT_TRADER_SEEDS_FILE: z.string().optional(),
  /** Mainnet: the file of invited owner keys and invite codes the gate signs for. Required there. */
  GATE_INVITES_FILE: z.string().optional(),
  /** Mainnet: on, the gate signs for any owner key and needs no invite list. The day's limits and one seat per owner still apply. */
  GATE_OPEN: onOffFlag("off"),
  /** Mainnet: accounts the gate opens in a UTC day. The program's own `max_seats_per_day` caps it from above. */
  GATE_SEATS_PER_DAY: positiveInt(3),
  /** Mainnet: accounts the gate opens in a UTC day for one network address. */
  GATE_SEATS_PER_IP_PER_DAY: positiveInt(1),
  PUBLIC_SOLANA_RPC_URL: z.url().optional(),
  PUBLIC_ROLLUP_RPC_URL: z.url().optional(),
  PUBLIC_ROLLUP_WS_URL: z.url().optional(),
  SERVICE_LOCATION: z.string().default("unnamed machine"),
  ROLLUP_MAKER_LEVEL_NUSD: decimalAmount("400"),
  ROLLUP_TAKER_MIN_NUSD: decimalAmount("5"),
  ROLLUP_TAKER_MAX_NUSD: decimalAmount("50"),
  LIQUIDATOR_SEATS_PER_TICK: positiveInt(64),
});

export type Config = z.infer<typeof envSchema>;

export interface QuestSettings {
  apiKey: string;
  url: string;
  questIds: { getStarted: string; threeDays: string; streak: string };
}

/** The quest settings, or null unless the key and all three quest ids are set. */
export const questSettings = (config: Config): QuestSettings | null => {
  const apiKey = config.MAGICBLOCK_QUESTS_API_KEY;
  const getStarted = config.QUEST_GET_STARTED_ID;
  const threeDays = config.QUEST_THREE_DAYS_ID;
  const streak = config.QUEST_STREAK_ID;
  if (!apiKey || !getStarted || !threeDays || !streak) return null;
  return {
    apiKey,
    url: config.MAGICBLOCK_QUESTS_URL,
    questIds: { getStarted, threeDays, streak },
  };
};

export const isMainnet = (config: Pick<Config, "NETWORK">): boolean => config.NETWORK === "mainnet";

/** Whether a missing or unusable order key checkpoint stops the maker instead of resetting its keys. */
export const requiresKeyCheckpoint = (
  config: Pick<Config, "NETWORK" | "REQUIRE_KEY_CHECKPOINT">,
): boolean => config.REQUIRE_KEY_CHECKPOINT ?? isMainnet(config);

/**
 * The service's settings from the environment. An entry point that runs one
 * part of the service names its role; the environment may not contradict it.
 */
export const loadConfig = (env: NodeJS.ProcessEnv = process.env, entryRole?: SimRole): Config => {
  if (entryRole && isSet(env, "SIM_ROLE") && env.SIM_ROLE !== entryRole) {
    throw new Error(
      `this entry point runs the ${entryRole} role, but SIM_ROLE=${env.SIM_ROLE}. Remove SIM_ROLE or set it to ${entryRole}.`,
    );
  }
  const config = envSchema.parse(entryRole ? { ...env, SIM_ROLE: entryRole } : env);
  const problems = [...roleProblems(config.SIM_ROLE, env), ...keeperTransportProblems(config, env)];
  if (problems.length > 0) {
    throw new Error(
      `SIM_ROLE=${config.SIM_ROLE} cannot start. What to fix:\n${problems.map((line) => `- ${line}`).join("\n")}`,
    );
  }
  return isMainnet(config) ? mainnetConfig(config, env) : config;
};

const isSet = (env: NodeJS.ProcessEnv, name: string): boolean => (env[name] ?? "") !== "";

const keeperTransportProblems = (config: Config, env: NodeJS.ProcessEnv): string[] => [
  ...(isSet(env, "KEEPER_HEARTBEAT_FILE") && config.KEEPER_HEARTBEAT_URLS
    ? [
        "KEEPER_HEARTBEAT_FILE and KEEPER_HEARTBEAT_URLS are both set. Pick one transport for the keeper's heartbeat.",
      ]
    : []),
  ...(config.KEEPER_HEARTBEAT_URLS && !config.KEEPER_HEARTBEAT_SECRETS_FILE
    ? [
        "KEEPER_HEARTBEAT_URLS is set without KEEPER_HEARTBEAT_SECRETS_FILE. A keeper's status counts only when it is signed.",
      ]
    : []),
  ...(!config.KEEPER_HEARTBEAT_URLS && config.KEEPER_HEARTBEAT_SECRETS_FILE
    ? ["KEEPER_HEARTBEAT_SECRETS_FILE is set without KEEPER_HEARTBEAT_URLS."]
    : []),
];
