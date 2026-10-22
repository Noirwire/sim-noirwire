import { readFileSync } from "node:fs";
import { Keypair } from "@solana/web3.js";
import { z } from "zod";
import type { Config } from "../config/config.js";
import type { MarketConfig } from "../engine/markets.js";

const address = z.string().min(32).max(44);

/**
 * Only what this service reads of the description the order book
 * repository's set-up writes. A test network's names a faucet; a
 * mainnet-profile deployment has none, and prices its markets from Pyth.
 */
const deploymentSchema = z.object({
  network: z.string(),
  programId: address,
  gate: address,
  faucet: address.optional(),
  depositUrl: z.url(),
  tokens: z.array(
    z.object({
      index: z.number().int().nonnegative(),
      symbol: z.string(),
      decimals: z.number().int().nonnegative(),
      mint: address,
      /** The nonce of the token's custody authority, as decimal text: every deposit names it. */
      custodyNonce: z.string().regex(/^\d+$/, "must be decimal text"),
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
const ROLE_KEYS = ["GATE_SECRET_KEY", "FAUCET_SECRET_KEY"] as const;
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
  | "BOT_TRADER_SEEDS_FILE"
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
  gate: Keypair;
  /** Null on a deployment without a faucet: this service then deposits nothing. */
  faucet: Keypair | null;
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

/** The bot seeds: the value itself, or the file `BOT_TRADER_SEEDS_FILE` points at. Security: the value is never echoed. */
const botSeedsText = (
  env: Pick<RollupEnv, "BOT_TRADER_SEEDS" | "BOT_TRADER_SEEDS_FILE">,
): string => {
  if (env.BOT_TRADER_SEEDS) return env.BOT_TRADER_SEEDS;
  if (!env.BOT_TRADER_SEEDS_FILE) return "";
  try {
    return readFileSync(env.BOT_TRADER_SEEDS_FILE, "utf8");
  } catch {
    throw new Error("BOT_TRADER_SEEDS_FILE must be a readable file of hex seeds");
  }
};

const botOwnersFrom = (value: string, needed: number): Keypair[] => {
  const seeds = value
    .split(/[\s,]+/)
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

const issuesOf = (error: z.ZodError): string =>
  error.issues
    .map((issue) => `${issue.path.join(".") || "the description"}: ${issue.message}`)
    .join("; ");

/**
 * The deployment description, from DEPLOYMENT_JSON or the file DEPLOYMENT_PATH
 * names. One this service cannot read is refused with every field that is
 * wrong, and one without custody nonces (written before the client release
 * that names them in every deposit) is called the stale description it is.
 */
export const loadDeployment = (
  env: Pick<RollupEnv, "DEPLOYMENT_JSON" | "DEPLOYMENT_PATH">,
): Deployment => {
  const raw =
    env.DEPLOYMENT_JSON ??
    (env.DEPLOYMENT_PATH ? readFileSync(env.DEPLOYMENT_PATH, "utf8") : undefined);
  if (raw === undefined) throw new Error("set DEPLOYMENT_JSON or DEPLOYMENT_PATH");
  const parsed = deploymentSchema.safeParse(JSON.parse(raw));
  if (parsed.success) return parsed.data;
  const noNonce = parsed.error.issues.some((issue) => issue.path.at(-1) === "custodyNonce");
  if (noNonce) {
    throw new Error(
      "the deployment description names no custody nonce for its tokens: it was written by an " +
        "order book set-up older than this service's client, and that deployment is retired here. " +
        "Point DEPLOYMENT_PATH or DEPLOYMENT_JSON at a description a current set-up wrote " +
        `(docs/deploy.md). What does not fit: ${issuesOf(parsed.error)}`,
    );
  }
  throw new Error(`the deployment description does not fit: ${issuesOf(parsed.error)}`);
};

/**
 * The symbols a deployment may give a market of this service: a test
 * network's own, and the mainnet profile's SOL perpetual.
 */
const CHAIN_SYMBOLS_OF: Record<string, string[]> = { "NSOL-PERP": ["NSOL-PERP", "SOL-PERP"] };

const findDeployedMarket = (
  deployment: Deployment,
  symbol: string,
): Deployment["markets"][number] | undefined => {
  const symbols = CHAIN_SYMBOLS_OF[symbol] ?? [symbol];
  return deployment.markets.find((entry) => symbols.includes(entry.symbol));
};

export const deployedMarket = (
  deployment: Deployment,
  symbol: string,
): Deployment["markets"][number] => {
  const market = findDeployedMarket(deployment, symbol);
  if (!market) throw new Error(`the deployment has no market ${symbol}`);
  return market;
};

/** The markets of this service that the deployment has, in this service's order. Throws when it has none. */
export const deployedMarkets = (
  deployment: Deployment,
  markets: readonly MarketConfig[],
): MarketConfig[] => {
  const found = markets.filter((market) => findDeployedMarket(deployment, market.id));
  if (found.length === 0) {
    throw new Error(
      `the deployment has none of the markets ${markets.map((market) => market.id).join(", ")}`,
    );
  }
  return found;
};

/**
 * Everything VENUE=rollup needs, checked before anything is sent: every
 * value present, every key well formed and the very key the deployment names
 * for its role. The faucet key is needed only when the deployment names a
 * faucet. Security: throws with the name of what is wrong, never with a secret.
 */
export const loadRollupSettings = (
  env: RollupEnv,
  deployment: Deployment,
  botCount: number,
): RollupSettings => {
  const [solanaRpcUrl, rollupRpcUrl, rollupWsUrl] = URLS.map((name) => env[name] ?? "");
  const botSeeds = botSeedsText(env);
  const neededKeys = deployment.faucet ? ROLE_KEYS : (["GATE_SECRET_KEY"] as const);
  const missing = [
    ...URLS.filter((name) => !env[name]),
    ...(botSeeds ? [] : ["BOT_TRADER_SEEDS"]),
    ...neededKeys.filter((name) => !env[name] && !env[`${name}_FILE`]),
  ];
  if (missing.length > 0) throw new Error(`VENUE=rollup needs ${missing.join(", ")}`);
  for (const name of URLS) {
    if (!URL.canParse(env[name] ?? "")) throw new Error(`${name} must be a URL`);
  }

  const gate = roleKey(env, "GATE_SECRET_KEY");
  if (gate.publicKey.toBase58() !== deployment.gate) {
    throw new Error("the gate key is not the gate this deployment names");
  }
  const faucet = deployment.faucet ? roleKey(env, "FAUCET_SECRET_KEY") : null;
  if (faucet && faucet.publicKey.toBase58() !== deployment.faucet) {
    throw new Error("the faucet key is not the faucet this deployment names");
  }

  return {
    solanaRpcUrl,
    rollupRpcUrl,
    rollupWsUrl,
    depositRpcUrl: env.DEPOSIT_RPC_URL || deployment.depositUrl,
    deployment,
    gate,
    faucet,
    botOwners: botOwnersFrom(botSeeds, botCount),
  };
};
