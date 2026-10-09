// Runs the local network inside its container: a fresh throwaway admin key on
// the shared deployment volume, then MagicBlock's three-part stack with the
// order book program loaded, the same way the order book repository's
// Makefile starts it on a machine.
//
// The Solana validator listens on every address. The rollup and the query
// filter listen on 127.0.0.1 only, so their ports are also offered on the
// container's own address and passed through, which is how the other
// containers and the published host ports reach them.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { networkInterfaces } from "node:os";
import { join } from "node:path";

const ORDERBOOK = "/orderbook";
const DEPLOYMENT_DIR = "/deployment";
const RUN_DIR = "/network";
const READY_FILE = join(RUN_DIR, "ready");
const STACK_READY = "MagicBlock stack is ready";
const LOCAL_VALIDATOR = "mAGicPQYBMvcYveUZA5F5UNNwyHvfYh5xkLS2Fr1mev";
const LOOPBACK_ONLY_PORTS = [7799, 7800, 6699, 6700];

const programId = /^noirwire_orderbook = "(.*)"$/m.exec(
  readFileSync(join(ORDERBOOK, "Anchor.toml"), "utf8"),
)?.[1];
if (!programId) {
  console.error("Anchor.toml does not declare the noirwire_orderbook program address.");
  process.exit(1);
}

const containerAddress = Object.values(networkInterfaces())
  .flat()
  .find((address) => address.family === "IPv4" && !address.internal)?.address;
if (!containerAddress) {
  console.error("This container has no network address of its own.");
  process.exit(1);
}

// A fresh network every start, so a deployment an earlier network left on
// the volume would describe accounts that no longer exist.
for (const name of readdirSync(DEPLOYMENT_DIR)) {
  rmSync(join(DEPLOYMENT_DIR, name), { recursive: true, force: true });
}
mkdirSync(RUN_DIR, { recursive: true });
rmSync(READY_FILE, { force: true });

const adminKey = join(DEPLOYMENT_DIR, "admin.json");
execFileSync("solana-keygen", ["new", "--no-bip39-passphrase", "--silent", "--outfile", adminKey]);
const admin = execFileSync("solana-keygen", ["pubkey", adminKey], { encoding: "utf8" }).trim();

for (const port of LOOPBACK_ONLY_PORTS) {
  createServer((inbound) => {
    const outbound = createConnection({ host: "127.0.0.1", port });
    inbound.pipe(outbound).pipe(inbound);
    inbound.on("error", () => outbound.destroy());
    outbound.on("error", () => inbound.destroy());
  }).listen(port, containerAddress);
}

const stack = spawn(
  process.execPath,
  [
    join(ORDERBOOK, "node_modules/.bin/mb-stack"),
    "--reset",
    "--ledger",
    join(RUN_DIR, "ledger"),
    "--account",
    LOCAL_VALIDATOR,
    join(ORDERBOOK, "tests/fixtures/local-validator-identity.json"),
    "--upgradeable-program",
    programId,
    join(ORDERBOOK, "target/deploy/noirwire_orderbook.so"),
    admin,
  ],
  { cwd: RUN_DIR, stdio: ["ignore", "pipe", "inherit"] },
);

stack.stdout.on("data", (chunk) => {
  process.stdout.write(chunk);
  if (chunk.includes(STACK_READY)) writeFileSync(READY_FILE, "");
});
stack.on("exit", () => process.exit(1));
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => stack.kill("SIGINT"));
}
