// Starts the service inside the local compose stack. The order book
// repository's set-up wrote the deployment description and its throwaway
// keys to a folder that is mounted read-only at /deployment; this reads them
// into the environment the service validates, makes the bot seeds once and
// keeps them on the data volume, then hands over to the service itself.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const DEPLOYMENT_DIR = "/deployment";
const SEEDS_FILE = join(process.env.DATA_DIR ?? "/app/data", "local-bot-seeds");
const BOT_SEED_COUNT = 32;

const held = (name) => {
  const path = join(DEPLOYMENT_DIR, name);
  if (!existsSync(path)) {
    console.error(
      `${name} is missing. Run 'make docker-up': it starts the local network and sets it up first.`,
    );
    process.exit(1);
  }
  return readFileSync(path, "utf8").trim();
};

if (!existsSync(SEEDS_FILE)) {
  mkdirSync(dirname(SEEDS_FILE), { recursive: true });
  const seeds = Array.from({ length: BOT_SEED_COUNT }, () => randomBytes(32).toString("hex"));
  writeFileSync(SEEDS_FILE, seeds.join(","), { mode: 0o600 });
}

process.env.DEPLOYMENT_JSON = held("deployment.json");
process.env.ORACLE_SECRET_KEY = held("localnet-oracle.json");
process.env.GATE_SECRET_KEY = held("localnet-gate.json");
process.env.FAUCET_SECRET_KEY = held("localnet-faucet.json");
process.env.BOT_TRADER_SEEDS = readFileSync(SEEDS_FILE, "utf8").trim();

await import("/app/dist/main.js");
