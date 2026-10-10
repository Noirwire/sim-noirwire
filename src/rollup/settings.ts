import { readFileSync } from "node:fs";
import { Keypair } from "@solana/web3.js";
import { z } from "zod";
import type { Config } from "../config/config.js";

const address = z.string().min(32).max(44);

const deploymentSchema = z.object({
  network: z.string(),
  programId: address,
  gate: address,
  oracle: address,
  faucet: address,
  depositUrl: z.url(),
  tokens: z.array(
    z.object({
      index: z.number().int().nonnegative(),
      symbol: z.string(),
      decimals: z.number().int().nonnegative(),
      mint: address,
    }),
  ),
  markets: z.array(
    z.object({
      id: z.number().int().nonnegative(),
      symbol: z.string(),
      kind: z.enum(["spot", "perp"]),
      baseDecimals: z.number().int().nonnegative(),
    }),
  ),
});

/** What the order book repository's set-up prints: the addresses and markets of one deployment. */
export type Deployment = z.infer<typeof deploymentSchema>;

const URLS = ["SOLANA_RPC_URL", "ROLLUP_RPC_URL", "ROLLUP_WS_URL"] as const;
const ROLE_KEYS = ["ORACLE_SECRET_KEY", "GATE_SECRET_KEY", "FAUCET_SECRET_KEY"] as const;
type RoleKey = (typeof ROLE_KEYS)[number];

export type RollupEnv = Pick<
  Config,
  | (typeof URLS)[number]
  | RoleKey
  | `${RoleKey}_FILE`
  | "DEPOSIT_RPC_URL"
  | "DEPLOYMENT_JSON"
  | "DEPLOYMENT_PATH"
  | "BOT_TRADER_SEEDS"
>;

export interface RollupSettings {
  solanaRpcUrl: string;
  rollupRpcUrl: string;
  rollupWsUrl: string;
  /**
   * Where deposits are sent: the deployment's `depositUrl` (the rollup's own
   * port on the local stack, the private endpoint on a hosted one) unless
   * DEPOSIT_RPC_URL names another.
   */
  depositRpcUrl: string;
  deployment: Deployment;
  oracle: Keypair;
  gate: Keypair;
  faucet: Keypair;
  botOwners: Keypair[];
}

/** A secret key as the 64-byte JSON array a Solana keypair file holds. Security: the value is never echoed. */
const secretKey = (name: string, value: string): Keypair => {
  try {
    const bytes = z.array(z.number().int().min(0).max(255)).length(64).parse(JSON.parse(value));
    return Keypair.fromSecretKey(Uint8Array.from(bytes));
  } catch {
    throw new Error(`${name} must be a secret key as a JSON array of 64 bytes`);
  }
};

/** A role's secret key: the value itself, or the keypair file `<NAME>_FILE` points at. */
export const roleKey = (
  env: Pick<RollupEnv, RoleKey | `${RoleKey}_FILE`>,
  name: RoleKey,
): Keypair => {
  const inline = env[name];
  if (inline) return secretKey(name, inline);
  try {
    return secretKey(`${name}_FILE`, readFileSync(env[`${name}_FILE`] ?? "", "utf8"));
  } catch {
    throw new Error(`${name}_FILE must be a readable keypair file`);
  }
};

const botOwnersFrom = (value: string, needed: number): Keypair[] => {
  const seeds = value
    .split(",")
    .map((seed) => seed.trim())
    .filter(Boolean);
  if (seeds.some((seed) => !/^[0-9a-fA-F]{64}$/.test(seed))) {
    throw new Error("BOT_TRADER_SEEDS must be 32-byte seeds in hex, separated by commas");
  }
  if (new Set(seeds).size !== seeds.length) {
    throw new Error("BOT_TRADER_SEEDS repeats a seed: every bot trader needs its own");
  }
  if (seeds.length < needed) {
    throw new Error(
      `BOT_TRADER_SEEDS holds ${seeds.length} seeds and ${needed} bots need one each`,
    );
  }
  return seeds.slice(0, needed).map((seed) => Keypair.fromSeed(Buffer.from(seed, "hex")));
};

/** The deployment description, checked to hold every market in `marketSymbols`. */
export const loadDeployment = (
  env: Pick<RollupEnv, "DEPLOYMENT_JSON" | "DEPLOYMENT_PATH">,
  marketSymbols: string[],
): Deployment => {
  const raw =
    env.DEPLOYMENT_JSON ??
    (env.DEPLOYMENT_PATH ? readFileSync(env.DEPLOYMENT_PATH, "utf8") : undefined);
  if (raw === undefined) throw new Error("set DEPLOYMENT_JSON or DEPLOYMENT_PATH");
  const deployment = deploymentSchema.parse(JSON.parse(raw));
  for (const symbol of marketSymbols) deployedMarket(deployment, symbol);
  return deployment;
};

export const deployedMarket = (
  deployment: Deployment,
  symbol: string,
): Deployment["markets"][number] => {
  const market = deployment.markets.find((entry) => entry.symbol === symbol);
  if (!market) throw new Error(`the deployment has no market ${symbol}`);
  return market;
};

/**
 * Everything VENUE=rollup needs, checked before anything is sent: every
 * value present, every key well formed and the very key the deployment names
 * for its role. Security: throws with the name of what is wrong, never with a secret.
 */
export const loadRollupSettings = (
  env: RollupEnv,
  botCount: number,
  marketSymbols: string[],
): RollupSettings => {
  const [solanaRpcUrl, rollupRpcUrl, rollupWsUrl] = URLS.map((name) => env[name] ?? "");
  const botSeeds = env.BOT_TRADER_SEEDS ?? "";
  const missing = [
    ...URLS.filter((name) => !env[name]),
    ...(botSeeds ? [] : ["BOT_TRADER_SEEDS"]),
    ...ROLE_KEYS.filter((name) => !env[name] && !env[`${name}_FILE`]),
  ];
  if (missing.length > 0) throw new Error(`VENUE=rollup needs ${missing.join(", ")}`);
  for (const name of URLS) {
    if (!URL.canParse(env[name] ?? "")) throw new Error(`${name} must be a URL`);
  }

  const deployment = loadDeployment(env, marketSymbols);
  const roles = {
    oracle: roleKey(env, "ORACLE_SECRET_KEY"),
    gate: roleKey(env, "GATE_SECRET_KEY"),
    faucet: roleKey(env, "FAUCET_SECRET_KEY"),
  };
  for (const role of ["oracle", "gate", "faucet"] as const) {
    if (roles[role].publicKey.toBase58() !== deployment[role]) {
      throw new Error(`the ${role} key is not the ${role} this deployment names`);
    }
  }

  return {
    solanaRpcUrl,
    rollupRpcUrl,
    rollupWsUrl,
    depositRpcUrl: env.DEPOSIT_RPC_URL || deployment.depositUrl,
    deployment,
    ...roles,
    botOwners: botOwnersFrom(botSeeds, botCount),
  };
};
