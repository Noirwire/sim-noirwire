/**
 * Which part of the service a process runs.
 *
 * - `combined`: everything in one process, as the service has always run.
 * - `maker`: the house maker only. It holds the maker seeds and no gate key.
 * - `gate`: the account desk only. It holds the gate key and no maker seeds.
 * - `data`: the read-only market data API only. It holds no key at all.
 */
export const SIM_ROLES = ["combined", "maker", "gate", "data"] as const;

export type SimRole = (typeof SIM_ROLES)[number];

/** The process places and cancels the house maker's orders. */
export const runsMaker = (role: SimRole): boolean => role === "combined" || role === "maker";

/** The process opens accounts for users: the invite desk on mainnet, the test desk elsewhere. */
export const servesAccountDesk = (role: SimRole): boolean => role === "combined" || role === "gate";

/** The process answers the read-only market data routes and the stream. */
export const servesMarketData = (role: SimRole): boolean => role === "combined" || role === "data";

/** The process holds the gate's secret key. */
export const holdsGateKey = servesAccountDesk;

/** The process holds the maker seeds. */
export const holdsMakerSeeds = runsMaker;

type Env = NodeJS.ProcessEnv;

const isSet = (env: Env, name: string): boolean => (env[name] ?? "") !== "";

const KEEPER_SETTINGS = [
  "KEEPER_HEARTBEAT_FILE",
  "KEEPER_HEARTBEAT_URLS",
  "KEEPER_HEARTBEAT_SECRETS_FILE",
];
const GATE_KEY_SETTINGS = ["GATE_SECRET_KEY", "GATE_SECRET_KEY_FILE"];
const FAUCET_KEY_SETTINGS = ["FAUCET_SECRET_KEY", "FAUCET_SECRET_KEY_FILE"];
const MAKER_SEED_SETTINGS = ["BOT_TRADER_SEEDS", "BOT_TRADER_SEEDS_FILE"];
const GATE_RULE_SETTINGS = ["GATE_INVITES_FILE", "GATE_OPEN"];
const HEDGE_SETTINGS = ["HEDGE_ENABLED", "HEDGE_VENUE_MODULE"];

interface Refusal {
  roles: SimRole[];
  names: string[];
  why: string;
}

/**
 * What a role must not be given. A process that is not meant to hold a
 * credential refuses to start with it, rather than quietly using it: the
 * point of the split is that a stolen or confused maker has no gate key.
 */
const REFUSALS: Refusal[] = [
  {
    roles: ["maker", "data"],
    names: GATE_KEY_SETTINGS,
    why: "this role never holds the gate key",
  },
  {
    roles: ["gate", "data"],
    names: MAKER_SEED_SETTINGS,
    why: "this role never holds the maker seeds",
  },
  {
    roles: ["data"],
    names: FAUCET_KEY_SETTINGS,
    why: "the market data API signs nothing, so it holds no key",
  },
  {
    roles: ["gate", "data"],
    names: [...KEEPER_SETTINGS, ...HEDGE_SETTINGS],
    why: "only the maker reads the keeper and runs the hedge",
  },
  {
    roles: ["maker", "data"],
    names: GATE_RULE_SETTINGS,
    why: "only the gate holds the invite list and its rules",
  },
];

/**
 * The problems a role's environment has: a credential it must not hold, or a
 * venue that cannot be split. Empty when the role may start. A message names
 * the variable, never its value.
 */
export const roleProblems = (role: SimRole, env: Env): string[] => {
  if (role === "combined") return [];
  const notRollup =
    (env.VENUE ?? "memory") === "rollup"
      ? []
      : [
          `SIM_ROLE=${role} needs VENUE=rollup: the in-memory venue cannot be split across processes.`,
        ];
  const refused = REFUSALS.filter((refusal) => refusal.roles.includes(role)).flatMap(
    ({ names, why }) =>
      names
        .filter((name) => isSet(env, name))
        .map((name) => `${name} is set, but ${why} (SIM_ROLE=${role}). Remove it.`),
  );
  return [...notRollup, ...refused];
};
