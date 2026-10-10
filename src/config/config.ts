import { z } from "zod";
import { DECIMAL_TEXT, fromDecimalString } from "../engine/money.js";

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

/** Every variable this service reads, with its default. `.env.example` documents each one. */
const envSchema = z.object({
  PORT: positiveInt(4100),
  HOST: z.string().default("0.0.0.0"),
  VENUE: z.enum(["memory", "rollup"]).default("memory"),
  DEV_TRADING: boolFlag("0"),
  NETWORK: z.string().default("devnet"),
  ALLOWED_ORIGINS: commaSeparated("http://localhost:3000"),
  DATA_DIR: z.string().default("./data"),
  SNAPSHOT_INTERVAL_MS: positiveInt(30_000),

  FUND_AMOUNT_NUSD: decimalAmount("5000"),
  FUND_IP_RATE_LIMIT: positiveInt(20),
  FUND_IP_RATE_WINDOW_MS: positiveInt(60 * 60_000),

  JUPITER_BASE_URL: z.string().default("https://lite-api.jup.ag/price/v3"),
  JUPITER_POLL_INTERVAL_MS: positiveInt(2_000),

  INSURANCE_SEED_NUSD: decimalAmount("10000000"),
  MAX_FUNDING_RATE_BPS_PER_UPDATE: positiveInt(75),
  FUNDING_INTERVAL_MS: positiveInt(60_000),

  HOUSE_MAKER_TICK_MS: positiveInt(1_000),
  HOUSE_MAKER_LEVELS: positiveInt(5),
  HOUSE_MAKER_SPREAD_BPS: positiveInt(15),
  HOUSE_MAKER_LEVEL_STEP_BPS: positiveInt(5),
  HOUSE_MAKER_REQUOTE_THRESHOLD_BPS: positiveInt(8),
  HOUSE_MAKER_REQUOTE_INTERVAL_MS: positiveInt(5_000),
  HOUSE_MAKER_POSITION_LIMIT_NUSD: decimalAmount("50000"),
  HOUSE_MAKER_MAX_SKEW_BPS: positiveInt(20),

  NOISE_TAKER_TICK_MS: positiveInt(500),
  NOISE_TAKER_COUNT: positiveInt(6),
  NOISE_TAKER_MIN_INTERVAL_MS: positiveInt(1_500),
  NOISE_TAKER_MAX_INTERVAL_MS: positiveInt(6_000),
  NOISE_TAKER_WORST_SLIPPAGE_BPS: positiveInt(50),
  NOISE_TAKER_STARTING_NUSD: decimalAmount("100000"),
  NOISE_TAKER_STARTING_BASE: decimalAmount("1000"),
  NOISE_TAKER_SEED: positiveInt(42),

  LIQUIDATOR_INTERVAL_MS: positiveInt(3_000),
  LIQUIDATOR_STARTING_NUSD: decimalAmount("1000000"),

  STATS_LATENCY_WINDOW: positiveInt(500),

  // VENUE=rollup. `rollup/settings.ts` says which are required and checks them together.
  SOLANA_RPC_URL: z.string().optional(),
  ROLLUP_RPC_URL: z.string().optional(),
  ROLLUP_WS_URL: z.string().optional(),
  DEPOSIT_RPC_URL: z.string().optional(),
  DEPLOYMENT_JSON: z.string().optional(),
  DEPLOYMENT_PATH: z.string().optional(),
  ORACLE_SECRET_KEY: z.string().optional(),
  GATE_SECRET_KEY: z.string().optional(),
  FAUCET_SECRET_KEY: z.string().optional(),
  ORACLE_SECRET_KEY_FILE: z.string().optional(),
  GATE_SECRET_KEY_FILE: z.string().optional(),
  FAUCET_SECRET_KEY_FILE: z.string().optional(),
  BOT_TRADER_SEEDS: z.string().optional(),
  PUBLIC_SOLANA_RPC_URL: z.url().optional(),
  PUBLIC_ROLLUP_RPC_URL: z.url().optional(),
  PUBLIC_ROLLUP_WS_URL: z.url().optional(),
  SERVICE_LOCATION: z.string().default("unnamed machine"),
  PRICE_PUBLISH_INTERVAL_MS: positiveInt(2_000),
  ROLLUP_QUOTE_EXPIRY_SECONDS: positiveInt(30),
  ROLLUP_MAKER_LEVEL_NUSD: decimalAmount("400"),
  ROLLUP_TAKER_MIN_NUSD: decimalAmount("5"),
  ROLLUP_TAKER_MAX_NUSD: decimalAmount("50"),
  LIQUIDATOR_SEATS_PER_TICK: positiveInt(4),
  LIQUIDATOR_EXTRA_SEATS: positiveInt(8),
});

export type Config = z.infer<typeof envSchema>;

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config => envSchema.parse(env);
