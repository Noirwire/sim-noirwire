import { loadConfig } from "./config/config.js";
import { SnapshotStore } from "./data/snapshot.js";
import { MARKETS } from "./engine/markets.js";
import { requireNetwork } from "./rollup/connections.js";
import { Program } from "./rollup/program.js";
import { type ResetCandidate, describeReset, resetOrderKeys } from "./rollup/reset-order-keys.js";
import { deployedMarkets, loadDeployment, loadRollupSettings } from "./rollup/settings.js";

const USAGE_EXIT = 2;

const confirmedOwners = (args: string[]): Set<string> => {
  const owners = new Set<string>();
  for (let at = 0; at < args.length; at += 1) {
    if (args[at] === "--confirm" && args[at + 1]) owners.add(args[(at += 1)]);
  }
  return owners;
};

const main = async (): Promise<void> => {
  const config = loadConfig(process.env, "maker");
  const deployment = loadDeployment(config);
  const markets = deployedMarkets(deployment, MARKETS);
  const settings = loadRollupSettings(config, deployment, markets.length, "maker");
  const candidates: ResetCandidate[] = markets.map((market, at) => ({
    market: market.id,
    owner: settings.botOwners[at],
  }));
  const confirmed = confirmedOwners(process.argv.slice(2));
  if (confirmed.size === 0) {
    console.log(describeReset(candidates));
    process.exit(USAGE_EXIT);
  }
  await requireNetwork(config.NETWORK === "mainnet", settings.solanaRpcUrl);

  const program = new Program(deployment.programId);
  const store = new SnapshotStore(config.DATA_DIR);
  const outcomes = await resetOrderKeys(candidates, confirmed, {
    reset: (owner) => program.resetOrderKeys(settings.rollupRpcUrl, owner),
    saveCheckpoint: async (owner, checkpoint) => {
      const kept = await store.load();
      await store.save({
        savedAtMs: Date.now(),
        network: config.NETWORK,
        candles: [],
        fundedAddresses: [],
        ...kept,
        orderKeyCheckpoints: { ...kept?.orderKeyCheckpoints, [owner]: checkpoint },
      });
    },
  });
  let failed = false;
  for (const outcome of outcomes) {
    const line = `${outcome.market} owner ${outcome.owner}: ${outcome.status}`;
    if (outcome.status === "failed") {
      failed = true;
      console.error(`${line}: ${outcome.reason}`);
    } else {
      console.log(line);
    }
  }
  process.exit(failed ? 1 : 0);
};

main().catch((error) => {
  console.error(
    `The order keys were not reset: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
