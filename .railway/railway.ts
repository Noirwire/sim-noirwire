import { execSync } from "node:child_process";
import { defineRailway, github, preserve, project, service, volume } from "railway/iac";

// The simulation service as a Railway service. Apply with `railway config apply`
// (see ../docs/deploy.md). Nothing here has been applied yet.

// This repository manages one slice of the Railway project it shares with the
// API and the relayer.
export const partial = "sim";

// Railway builds from this checkout's GitHub repository on every push to main.
const origin = execSync("git remote get-url origin", { encoding: "utf8" });
const repo = /github\.com[:/](.+?)(?:\.git)?\s*$/.exec(origin)?.[1];
if (!repo) throw new Error("The origin remote is not a GitHub repository.");

// Set by hand once, in the service's raw variable editor. Railway keeps them.
// The four below the line are secrets: seal them.
const SET_BY_HAND = [
  "ALLOWED_ORIGINS",
  "SOLANA_RPC_URL",
  "ROLLUP_RPC_URL",
  "ROLLUP_WS_URL",
  "DEPLOYMENT_JSON",
  // Secrets.
  "ORACLE_SECRET_KEY",
  "GATE_SECRET_KEY",
  "FAUCET_SECRET_KEY",
  "BOT_TRADER_SEEDS",
];

export default defineRailway(() => {
  const sim = service("sim", {
    source: github(repo),
    build: { builder: "DOCKERFILE", dockerfilePath: "Dockerfile" },
    deploy: {
      // Answers 200 only once the service is connected to the rollup, every
      // market's price on chain is fresh and the bots are funded.
      healthcheckPath: "/v1/health",
      healthcheckTimeout: 300,
      restartPolicyType: "ON_FAILURE",
      restartPolicyMaxRetries: 10,
    },
    // ONE replica, on purpose: the fund limits are counted in the memory of one
    // process, a second oracle would fight the first over the publish gap, and
    // the fund routes rely on this process being the only holder of the gate key.
    replicas: 1,
    // Candles, fund grants and the tape cursors, written every 30 seconds.
    volumeMounts: { "/app/data": volume("sim-data") },
    env: {
      VENUE: "rollup",
      NETWORK: "devnet",
      DATA_DIR: "/app/data",
      SERVICE_LOCATION: "Railway, ${{RAILWAY_REPLICA_REGION}}",
      ...Object.fromEntries(SET_BY_HAND.map((name) => [name, preserve()])),
    },
  });
  return project("noirwire-relayer", { resources: [sim] });
});
