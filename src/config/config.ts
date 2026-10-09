import { z } from "zod";
import { fromDecimalString } from "../engine/money.js";

const decimalAmount = (defaultValue: string) =>
  z
    .string()
    .regex(/^\d+(\.\d+)?$/, "must be a plain decimal number")
    .default(defaultValue)
    .transform((value) => fromDecimalString(value));

const boolFlag = (defaultValue: "0" | "1") =>
  z
    .enum(["0", "1"])
    .default(defaultValue)
    .transform((value) => value === "1");

const intString = (defaultValue: number) =>
  z.coerce.number().int().positive().default(defaultValue);

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(4100),
  HOST: z.string().default("0.0.0.0"),
  VENUE: z.enum(["memory", "rollup"]).default("memory"),
  DEV_TRADING: boolFlag("0"),
  NETWORK: z.string().default("devnet"),
  ALLOWED_ORIGINS: z
    .string()
    .default("http://localhost:3000")
    .transform((value) =>
      value
        .split(",")
        .map((origin) => origin.trim())
        .filter(Boolean),
    ),
  DATA_DIR: z.string().default("./data"),
  SNAPSHOT_INTERVAL_MS: intString(30_000),

  FUND_AMOUNT_NUSD: decimalAmount("5000"),
  FUND_IP_RATE_LIMIT: intString(20),
  FUND_IP_RATE_WINDOW_MS: intString(60 * 60_000),

  JUPITER_BASE_URL: z.string().default("https://lite-api.jup.ag/price/v3"),
  JUPITER_POLL_INTERVAL_MS: intString(2_000),

  INSURANCE_SEED_NUSD: decimalAmount("10000000"),
  MAX_FUNDING_RATE_BPS_PER_UPDATE: intString(75),
  FUNDING_INTERVAL_MS: intString(60_000),

  HOUSE_MAKER_TICK_MS: intString(1_000),
  HOUSE_MAKER_LEVELS: intString(5),
  HOUSE_MAKER_SPREAD_BPS: intString(15),
  HOUSE_MAKER_LEVEL_STEP_BPS: intString(5),
  HOUSE_MAKER_REQUOTE_THRESHOLD_BPS: intString(8),
  HOUSE_MAKER_REQUOTE_INTERVAL_MS: intString(5_000),
  HOUSE_MAKER_POSITION_LIMIT_NUSD: decimalAmount("50000"),
  HOUSE_MAKER_MAX_SKEW_BPS: intString(20),

  NOISE_TAKER_TICK_MS: intString(500),
  NOISE_TAKER_COUNT: intString(6),
  NOISE_TAKER_MIN_INTERVAL_MS: intString(1_500),
  NOISE_TAKER_MAX_INTERVAL_MS: intString(6_000),
  NOISE_TAKER_WORST_SLIPPAGE_BPS: intString(50),
  NOISE_TAKER_STARTING_NUSD: decimalAmount("100000"),
  NOISE_TAKER_STARTING_BASE: decimalAmount("1000"),
  NOISE_TAKER_SEED: intString(42),

  LIQUIDATOR_INTERVAL_MS: intString(3_000),
  LIQUIDATOR_STARTING_NUSD: decimalAmount("1000000"),

  STATS_LATENCY_WINDOW: intString(500),
});

export type Config = z.infer<typeof envSchema>;

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config => envSchema.parse(env);
