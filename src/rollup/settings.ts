import { readFileSync } from "node:fs";
import { Keypair } from "@solana/web3.js";
import { z } from "zod";

const address = z.string().min(32).max(44);

const deploymentSchema = z.object({
  network: z.string(),
  programId: address,
  gate: address,
  oracle: address,
  faucet: address,
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
      fundingTaskId: z.number().optional(),
    }),
  ),
});

/** What the order book repository's set-up prints: the addresses and markets of one deployment. */
export type Deployment = z.infer<typeof deploymentSchema>;

export interface RollupEnv {
  SOLANA_RPC_URL?: string;
  ROLLUP_RPC_URL?: string;
  ROLLUP_WS_URL?: string;
  ROLLUP_DIRECT_RPC_URL?: string;
  DEPLOYMENT_JSON?: string;
  DEPLOYMENT_PATH?: string;
  ORACLE_SECRET_KEY?: string;
  GATE_SECRET_KEY?: string;
  FAUCET_SECRET_KEY?: string;
  BOT_TRADER_SEEDS?: string;
}

export interface RollupSettings {
  solanaRpcUrl: string;
  rollupRpcUrl: string;
  rollupWsUrl: string;
  /** The rollup's own port, for deposits on a local network whose query filter refuses them. */
  rollupDirectRpcUrl?: string;
  deployment: Deployment;
  oracle: Keypair;
  gate: Keypair;
  faucet: Keypair;
  botOwners: Keypair[];
}

/** A secret key as the 64-byte JSON array a Solana keypair file holds. The value is never echoed. */
const secretKey = (name: string, value: string): Keypair => {
  try {
    const bytes = z.array(z.number().int().min(0).max(255)).length(64).parse(JSON.parse(value));
    return Keypair.fromSecretKey(Uint8Array.from(bytes));
  } catch {
    throw new Error(`${name} must be a secret key as a JSON array of 64 bytes`);
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

const deploymentFrom = (env: RollupEnv): Deployment => {
  const raw =
    env.DEPLOYMENT_JSON ??
    (env.DEPLOYMENT_PATH ? readFileSync(env.DEPLOYMENT_PATH, "utf8") : undefined);
  if (raw === undefined) throw new Error("set DEPLOYMENT_JSON or DEPLOYMENT_PATH");
  return deploymentSchema.parse(JSON.parse(raw));
};

const REQUIRED = [
  "SOLANA_RPC_URL",
  "ROLLUP_RPC_URL",
  "ROLLUP_WS_URL",
  "ORACLE_SECRET_KEY",
  "GATE_SECRET_KEY",
  "FAUCET_SECRET_KEY",
  "BOT_TRADER_SEEDS",
] as const;

/**
 * Everything VENUE=rollup needs, checked before anything is sent: every
 * value present, every key well formed and the very key the deployment names
 * for its role. Throws with the name of what is wrong, never with a secret.
 */
export const loadRollupSettings = (
  env: RollupEnv,
  botCount: number,
  marketSymbols: string[],
): RollupSettings => {
  const missing = REQUIRED.filter((name) => !env[name]);
  if (missing.length > 0) throw new Error(`VENUE=rollup needs ${missing.join(", ")}`);
  for (const name of ["SOLANA_RPC_URL", "ROLLUP_RPC_URL", "ROLLUP_WS_URL"] as const) {
    if (!URL.canParse(env[name]!)) throw new Error(`${name} must be a URL`);
  }

  const deployment = deploymentFrom(env);
  for (const symbol of marketSymbols) {
    if (!deployment.markets.some((market) => market.symbol === symbol)) {
      throw new Error(`the deployment has no market ${symbol}`);
    }
  }

  const roles = {
    oracle: secretKey("ORACLE_SECRET_KEY", env.ORACLE_SECRET_KEY!),
    gate: secretKey("GATE_SECRET_KEY", env.GATE_SECRET_KEY!),
    faucet: secretKey("FAUCET_SECRET_KEY", env.FAUCET_SECRET_KEY!),
  };
  for (const [role, key] of Object.entries(roles)) {
    if (key.publicKey.toBase58() !== deployment[role as keyof typeof roles]) {
      throw new Error(`the ${role} key is not the ${role} this deployment names`);
    }
  }

  return {
    solanaRpcUrl: env.SOLANA_RPC_URL!,
    rollupRpcUrl: env.ROLLUP_RPC_URL!,
    rollupWsUrl: env.ROLLUP_WS_URL!,
    rollupDirectRpcUrl: env.ROLLUP_DIRECT_RPC_URL || undefined,
    deployment,
    ...roles,
    botOwners: botOwnersFrom(env.BOT_TRADER_SEEDS!, botCount),
  };
};
