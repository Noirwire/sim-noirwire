import { MAKER_LIMITS } from "../bots/maker-limits.js";
import { SCALE } from "../engine/money.js";
import type { Config } from "./config.js";

type Env = NodeJS.ProcessEnv;

const isSet = (env: Env, name: string): boolean => (env[name] ?? "") !== "";

/** Switches that start test machinery. Mainnet never runs it: set to 1, they stop the start. */
const TEST_SWITCHES = [
  { name: "DEV_TRADING", what: "the test trading endpoints" },
  { name: "NOISE_TAKERS_ENABLED", what: "the noise takers" },
  { name: "LIQUIDATOR_ENABLED", what: "the test liquidator" },
];

interface TestSettings {
  what: string;
  names: string[];
  /** Every variable that starts with this, bar `except`. */
  prefix?: string;
  except?: string;
}

/** Settings of test machinery. Mainnet never runs it: set at all, they stop the start. */
const TEST_SETTINGS: TestSettings[] = [
  {
    what: "the test faucet",
    names: ["FAUCET_SECRET_KEY", "FAUCET_SECRET_KEY_FILE", "FUND_AMOUNT_NUSD"],
  },
  { what: "a price publisher", names: ["ORACLE_SECRET_KEY", "ORACLE_SECRET_KEY_FILE"] },
  {
    what: "the noise takers",
    names: ["ROLLUP_TAKER_MIN_NUSD", "ROLLUP_TAKER_MAX_NUSD"],
    prefix: "NOISE_TAKER_",
  },
  { what: "the test liquidator", names: [], prefix: "LIQUIDATOR_", except: "LIQUIDATOR_ENABLED" },
];

/** What mainnet reads from a mounted file only, so it never sits in an environment variable. */
const FROM_A_FILE = [
  {
    inline: "GATE_SECRET_KEY",
    file: "GATE_SECRET_KEY_FILE",
    why: "the gate key is a secret, so it is read from a file mounted into the service",
  },
  {
    inline: "BOT_TRADER_SEEDS",
    file: "BOT_TRADER_SEEDS_FILE",
    why: "the maker seeds are secrets, so they are read from a file mounted into the service",
  },
  {
    inline: "DEPLOYMENT_JSON",
    file: "DEPLOYMENT_PATH",
    why: "the deployment description is read from a file mounted into the service, so what runs is a file you can check",
  },
];

/** Hosts whose rollup endpoint signs each user in with their own token and carries no operator key. */
const KEYLESS_ROLLUP_HOSTS = ["mainnet-tee.magicblock.app"];

/**
 * Each address a browser is told, and the private one it must not be. A rollup address may be
 * shared only when it is exactly `<sharedScheme>://<keyless host>`, with no trailing slash.
 */
const PUBLIC_URLS: {
  name: string;
  private: string;
  sharedScheme?: "https" | "wss";
}[] = [
  { name: "PUBLIC_SOLANA_RPC_URL", private: "SOLANA_RPC_URL" },
  { name: "PUBLIC_ROLLUP_RPC_URL", private: "ROLLUP_RPC_URL", sharedScheme: "https" },
  { name: "PUBLIC_ROLLUP_WS_URL", private: "ROLLUP_WS_URL", sharedScheme: "wss" },
];

const sameAddress = (a: string, b: string): boolean =>
  URL.canParse(a) && URL.canParse(b) && new URL(a).href === new URL(b).href;

const carriesAKey = (value: string): boolean => {
  const url = new URL(value);
  return Boolean(url.username || url.password || url.search || url.hash);
};

const isKnownKeylessOrigin = (value: string, scheme: string | undefined): boolean =>
  scheme !== undefined && KEYLESS_ROLLUP_HOSTS.some((host) => value === `${scheme}://${host}`);

const settingsInUse = (group: TestSettings, env: Env): string[] => {
  const prefixed = group.prefix
    ? Object.keys(env).filter(
        (name) => name.startsWith(group.prefix ?? "") && name !== group.except,
      )
    : [];
  return [...group.names, ...prefixed].filter((name) => isSet(env, name));
};

const testMachinery = (config: Config, env: Env): string[] => [
  ...TEST_SWITCHES.filter(({ name }) => env[name] === "1").map(
    ({ name, what }) =>
      `${name}=1 turns on ${what}, which never runs on mainnet. Remove it or set ${name}=0.`,
  ),
  ...TEST_SETTINGS.flatMap((group) =>
    settingsInUse(group, env).map(
      (name) =>
        `${name} is set. It configures ${group.what}, which never runs on mainnet. Remove it.`,
    ),
  ),
  ...(config.VENUE === "rollup"
    ? []
    : [
        "VENUE is not rollup. The in-memory venue is a simulation and never runs on mainnet. Set VENUE=rollup.",
      ]),
];

const secretsFromFiles = (env: Env): string[] =>
  FROM_A_FILE.flatMap(({ inline, file, why }) => {
    if (isSet(env, inline)) {
      return [
        `${inline} is set, but on mainnet ${why}. Remove it and set ${file} to the file's path.`,
      ];
    }
    return isSet(env, file)
      ? []
      : [`${file} is not set. On mainnet ${why}. Set it to the file's path.`];
  });

const publicUrls = (env: Env): string[] =>
  PUBLIC_URLS.flatMap(({ name, private: privateName, sharedScheme }) => {
    const value = env[name];
    if (!value) {
      return [
        `${name} is not set. On mainnet the service tells browsers only the addresses you name, ` +
          `never the private ${privateName}. Set it to a public endpoint that needs no key.`,
      ];
    }
    const sharedExactly = value === env[privateName] && isKnownKeylessOrigin(value, sharedScheme);
    if (sameAddress(value, env[privateName] ?? "") && !sharedExactly) {
      return [
        `${name} is the same address as ${privateName}, which may carry a key. ` +
          "Browsers are shown this one, so set it to a separate public endpoint that needs no key.",
      ];
    }
    if (URL.canParse(value) && carriesAKey(value)) {
      return [
        `${name} has a user name, password, query string or fragment, which is where a key goes. ` +
          "Browsers are shown this address, so set it to an endpoint that needs no key.",
      ];
    }
    return [];
  });

const proxyHops = (config: Config): string[] =>
  config.TRUSTED_PROXY_HOPS === undefined
    ? [
        "TRUSTED_PROXY_HOPS is not set. The per-IP limits need to know how many reverse proxies sit " +
          "in front of the service (0 if callers reach it directly), or they count the proxy as one caller.",
      ]
    : [];

const gateSettings = (config: Config, env: Env): string[] => [
  ...(isSet(env, "GATE_INVITES_FILE")
    ? []
    : [
        "GATE_INVITES_FILE is not set. On mainnet the gate signs only for the people on an invite list, " +
          "read from a file mounted into the service. Set it to the file's path (an empty file admits nobody).",
      ]),
  ...(config.GATE_SEATS_PER_IP_PER_DAY > config.GATE_SEATS_PER_DAY
    ? [
        "GATE_SEATS_PER_IP_PER_DAY is more than GATE_SEATS_PER_DAY, so the per-address limit could never be reached. " +
          "Lower it to GATE_SEATS_PER_DAY or less.",
      ]
    : []),
];

/**
 * What the house maker uses on mainnet when its setting is not given: small
 * enough for a maker of about 1,000 USDC. The testnet defaults would quote
 * far more than that.
 */
const MAINNET_MAKER_DEFAULTS = {
  HOUSE_MAKER_LEVELS: 3,
  HOUSE_MAKER_REQUOTE_THRESHOLD_BPS: 6,
  HOUSE_MAKER_REQUOTE_INTERVAL_MS: 10_000,
  HOUSE_MAKER_POSITION_LIMIT_NUSD: 250n * SCALE,
  ROLLUP_MAKER_LEVEL_NUSD: 50n * SCALE,
} satisfies Partial<Config>;

const withMakerDefaults = (config: Config, env: Env): Config => {
  const given = (name: string) => isSet(env, name);
  const chosen = Object.fromEntries(
    Object.entries(MAINNET_MAKER_DEFAULTS).filter(([name]) => !given(name)),
  );
  return { ...config, ...chosen };
};

/** The maker's settings against the risk rules' limits: a value outside them stops the start. */
const makerLimits = (config: Config, env: Env): string[] => [
  ...(env.HOUSE_MAKER_RISK_RULES === "0"
    ? [
        "HOUSE_MAKER_RISK_RULES=0 turns the maker's risk rules off, which never happens on mainnet. Remove it or set it to 1.",
      ]
    : []),
  ...(config.HOUSE_MAKER_SPREAD_BPS < MAKER_LIMITS.minHalfSpreadBps
    ? [
        `HOUSE_MAKER_SPREAD_BPS is under the ${MAKER_LIMITS.minHalfSpreadBps} bps floor on each side. Raise it to ${MAKER_LIMITS.minHalfSpreadBps} or more.`,
      ]
    : []),
  ...(config.HOUSE_MAKER_REQUOTE_INTERVAL_MS > MAKER_LIMITS.maxRequoteIntervalMs
    ? [
        `HOUSE_MAKER_REQUOTE_INTERVAL_MS is over ${MAKER_LIMITS.maxRequoteIntervalMs} ms. Quotes expire a little after it, so a long interval leaves them standing. Lower it.`,
      ]
    : []),
  ...(config.ROLLUP_MAKER_LEVEL_NUSD > MAKER_LIMITS.maxQuoteSizeNusd
    ? [
        `ROLLUP_MAKER_LEVEL_NUSD is over ${MAKER_LIMITS.maxQuoteSizeNusd / SCALE} nUSD, the most one quote level may hold. Lower it.`,
      ]
    : []),
  ...(config.HOUSE_MAKER_POSITION_LIMIT_NUSD > MAKER_LIMITS.maxPositionLimitNusd
    ? [
        `HOUSE_MAKER_POSITION_LIMIT_NUSD is over ${MAKER_LIMITS.maxPositionLimitNusd / SCALE} nUSD, the most the maker may hold. Lower it.`,
      ]
    : []),
];

/**
 * NETWORK=mainnet runs only the house maker, the gate and the read-only
 * market data. Anything that belongs to a test network stops the start with
 * every problem named at once, and the test machinery that has an on switch
 * is switched off. The maker's risk rules are always on, its settings are
 * kept inside their limits, and the ones left unset get small mainnet
 * values. Security: no message echoes a value, only the name of what is
 * wrong.
 */
export const mainnetConfig = (config: Config, env: Env): Config => {
  const sized = withMakerDefaults(config, env);
  const problems = [
    ...testMachinery(sized, env),
    ...makerLimits(sized, env),
    ...secretsFromFiles(env),
    ...gateSettings(sized, env),
    ...publicUrls(env),
    ...proxyHops(sized),
  ];
  if (problems.length > 0) {
    throw new Error(
      `NETWORK=mainnet cannot start. What to fix:\n${problems.map((line) => `- ${line}`).join("\n")}`,
    );
  }
  return {
    ...sized,
    DEV_TRADING: false,
    NOISE_TAKERS_ENABLED: false,
    LIQUIDATOR_ENABLED: false,
    HOUSE_MAKER_RISK_RULES: true,
  };
};
