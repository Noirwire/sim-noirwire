import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/config.js";

const PRIVATE_KEY_PART = "SECRETKEY1";

const mainnetEnv = (over: Record<string, string | undefined> = {}): NodeJS.ProcessEnv => {
  const env: Record<string, string | undefined> = {
    NETWORK: "mainnet",
    VENUE: "rollup",
    TRUSTED_PROXY_HOPS: "1",
    SOLANA_RPC_URL: `https://solana.example/?api-key=${PRIVATE_KEY_PART}`,
    ROLLUP_RPC_URL: `https://rollup.example/${PRIVATE_KEY_PART}`,
    ROLLUP_WS_URL: `wss://rollup.example/${PRIVATE_KEY_PART}`,
    PUBLIC_SOLANA_RPC_URL: "https://api.mainnet-beta.solana.com",
    PUBLIC_ROLLUP_RPC_URL: "https://rollup-public.example",
    PUBLIC_ROLLUP_WS_URL: "wss://rollup-public.example",
    DEPLOYMENT_PATH: "/run/secrets/deployment.json",
    GATE_SECRET_KEY_FILE: "/run/secrets/gate.json",
    BOT_TRADER_SEEDS_FILE: "/run/secrets/maker-seeds",
    ...over,
  };
  return Object.fromEntries(
    Object.entries(env).filter(([, value]) => value !== undefined),
  ) as NodeJS.ProcessEnv;
};

const problemsOf = (env: NodeJS.ProcessEnv): string[] => {
  try {
    loadConfig(env);
  } catch (error) {
    return (error as Error).message.split("\n").slice(1);
  }
  return [];
};

describe("NETWORK=mainnet", () => {
  it("starts with only the maker, the gate and the market data, whatever the test switches default to", () => {
    const config = loadConfig(mainnetEnv());

    expect(config.NETWORK).toBe("mainnet");
    expect(config.NOISE_TAKERS_ENABLED).toBe(false);
    expect(config.LIQUIDATOR_ENABLED).toBe(false);
    expect(config.DEV_TRADING).toBe(false);
  });

  it("accepts the test switches set to 0", () => {
    const config = loadConfig(
      mainnetEnv({ NOISE_TAKERS_ENABLED: "0", LIQUIDATOR_ENABLED: "0", DEV_TRADING: "0" }),
    );

    expect(config.NOISE_TAKERS_ENABLED).toBe(false);
  });

  it("refuses the in-memory venue", () => {
    expect(problemsOf(mainnetEnv({ VENUE: "memory" }))).toEqual([
      expect.stringContaining("VENUE is not rollup"),
    ]);
  });

  it("refuses every test switch that is on, naming each and what to do", () => {
    const problems = problemsOf(
      mainnetEnv({ NOISE_TAKERS_ENABLED: "1", LIQUIDATOR_ENABLED: "1", DEV_TRADING: "1" }),
    );

    expect(problems).toHaveLength(3);
    expect(problems.join("\n")).toContain("NOISE_TAKERS_ENABLED=1 turns on the noise takers");
    expect(problems.join("\n")).toContain("LIQUIDATOR_ENABLED=1");
    expect(problems.join("\n")).toContain("DEV_TRADING=1 turns on the test trading endpoints");
    expect(problems.join("\n")).toContain("set NOISE_TAKERS_ENABLED=0");
  });

  it.each([
    ["FAUCET_SECRET_KEY_FILE", "the test faucet"],
    ["FAUCET_SECRET_KEY", "the test faucet"],
    ["FUND_AMOUNT_NUSD", "the test faucet"],
    ["ORACLE_SECRET_KEY_FILE", "a price publisher"],
    ["ORACLE_SECRET_KEY", "a price publisher"],
    ["NOISE_TAKER_COUNT", "the noise takers"],
    ["ROLLUP_TAKER_MAX_NUSD", "the noise takers"],
    ["LIQUIDATOR_INTERVAL_MS", "the test liquidator"],
  ])("refuses %s, which configures %s", (name, what) => {
    const problems = problemsOf(mainnetEnv({ [name]: "5" }));

    expect(problems).toEqual([expect.stringContaining(`${name} is set. It configures ${what}`)]);
  });

  it("refuses a key, seeds or deployment held in an environment variable, and asks for a file", () => {
    const problems = problemsOf(
      mainnetEnv({
        GATE_SECRET_KEY: "[1,2,3]",
        GATE_SECRET_KEY_FILE: undefined,
        BOT_TRADER_SEEDS: "ab".repeat(32),
        BOT_TRADER_SEEDS_FILE: undefined,
        DEPLOYMENT_JSON: "{}",
        DEPLOYMENT_PATH: undefined,
      }),
    ).join("\n");

    expect(problems).toContain("GATE_SECRET_KEY is set");
    expect(problems).toContain("set GATE_SECRET_KEY_FILE to the file's path");
    expect(problems).toContain("BOT_TRADER_SEEDS is set");
    expect(problems).toContain("DEPLOYMENT_JSON is set");
    expect(problems).not.toContain("[1,2,3]");
    expect(problems).not.toContain("ab".repeat(32));
  });

  it("asks for the file of each secret that has none", () => {
    const problems = problemsOf(
      mainnetEnv({
        GATE_SECRET_KEY_FILE: undefined,
        BOT_TRADER_SEEDS_FILE: undefined,
        DEPLOYMENT_PATH: undefined,
      }),
    );

    expect(problems).toEqual([
      expect.stringContaining("GATE_SECRET_KEY_FILE is not set"),
      expect.stringContaining("BOT_TRADER_SEEDS_FILE is not set"),
      expect.stringContaining("DEPLOYMENT_PATH is not set"),
    ]);
  });

  it("requires a public address for each of the three a browser is told, with no fallback", () => {
    const problems = problemsOf(
      mainnetEnv({
        PUBLIC_SOLANA_RPC_URL: undefined,
        PUBLIC_ROLLUP_RPC_URL: undefined,
        PUBLIC_ROLLUP_WS_URL: undefined,
      }),
    );

    expect(problems).toHaveLength(3);
    expect(problems[0]).toContain("PUBLIC_SOLANA_RPC_URL is not set");
    expect(problems[0]).toContain("never the private SOLANA_RPC_URL");
  });

  it("refuses a public address that is the private one, or carries a key", () => {
    const sameAsPrivate = problemsOf(
      mainnetEnv({ PUBLIC_ROLLUP_RPC_URL: `https://rollup.example/${PRIVATE_KEY_PART}` }),
    );
    expect(sameAsPrivate).toEqual([
      expect.stringContaining("PUBLIC_ROLLUP_RPC_URL is the same address as ROLLUP_RPC_URL"),
    ]);

    const withQuery = problemsOf(
      mainnetEnv({ PUBLIC_SOLANA_RPC_URL: "https://public.example/?api-key=abc" }),
    );
    expect(withQuery).toEqual([expect.stringContaining("PUBLIC_SOLANA_RPC_URL has a user name")]);

    const withPassword = problemsOf(
      mainnetEnv({ PUBLIC_SOLANA_RPC_URL: "https://user:pass@public.example" }),
    );
    expect(withPassword).toHaveLength(1);
  });

  it("asks how many proxies are in front, and accepts none", () => {
    expect(problemsOf(mainnetEnv({ TRUSTED_PROXY_HOPS: undefined }))).toEqual([
      expect.stringContaining("TRUSTED_PROXY_HOPS is not set"),
    ]);
    expect(loadConfig(mainnetEnv({ TRUSTED_PROXY_HOPS: "0" })).TRUSTED_PROXY_HOPS).toBe(0);
  });

  it("names every problem at once and never repeats a private address or a secret", () => {
    let message = "";
    try {
      loadConfig(
        mainnetEnv({
          VENUE: "memory",
          NOISE_TAKERS_ENABLED: "1",
          FAUCET_SECRET_KEY: "SECRET-FAUCET-VALUE",
          PUBLIC_SOLANA_RPC_URL: undefined,
          PUBLIC_ROLLUP_RPC_URL: `https://rollup.example/${PRIVATE_KEY_PART}`,
          PUBLIC_ROLLUP_WS_URL: `wss://x.example/?key=SECRET-QUERY`,
        }),
      );
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message.startsWith("NETWORK=mainnet cannot start. What to fix:")).toBe(true);
    expect(message.split("\n").length).toBeGreaterThan(5);
    expect(message).not.toContain(PRIVATE_KEY_PART);
    expect(message).not.toContain("SECRET-FAUCET-VALUE");
    expect(message).not.toContain("SECRET-QUERY");
  });
});

describe("any other NETWORK", () => {
  it("is a label, and the test machinery keeps its defaults", () => {
    const config = loadConfig({ NETWORK: "localnet" } as NodeJS.ProcessEnv);

    expect(config.NETWORK).toBe("localnet");
    expect(config.NOISE_TAKERS_ENABLED).toBe(true);
    expect(config.LIQUIDATOR_ENABLED).toBe(true);
    expect(config.TRUSTED_PROXY_HOPS).toBeUndefined();
  });

  it("still takes the faucet and inline keys that mainnet refuses", () => {
    const config = loadConfig({
      VENUE: "rollup",
      FAUCET_SECRET_KEY: "[1]",
      GATE_SECRET_KEY: "[1]",
      DEPLOYMENT_JSON: "{}",
      BOT_TRADER_SEEDS: "ab",
    } as NodeJS.ProcessEnv);

    expect(config.FAUCET_SECRET_KEY).toBe("[1]");
  });
});
