import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Instructions, clockOf, decodePriceFeed, sendAndConfirm } from "@noirwire/orderbook";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";

const PUBLISH_EVERY_MS = 1_000;
const ROLLUP_PORT_URL = "http://127.0.0.1:7799";

/**
 * Keeps the marks of a local network's markets fresh, as the oracle key the
 * local set-up created: nothing in the service sets a mark, and the program
 * refuses orders on one that is older than its market takes. Each round
 * publishes every listed market's current mark again at the rollup's clock.
 * Resolves once the first round has landed, to a function that stops it.
 */
export const startPricePublisher = async (
  localnetDir: string,
  programId: string,
  marketIds: number[],
): Promise<() => void> => {
  const oracle = Keypair.fromSecretKey(
    Uint8Array.from(
      JSON.parse(readFileSync(join(localnetDir, "localnet-oracle.json"), "utf8")) as number[],
    ),
  );
  const connection = new Connection(ROLLUP_PORT_URL, "confirmed");
  const instructions = new Instructions(new PublicKey(programId));
  const publishOnce = async (): Promise<void> => {
    const time = BigInt(await clockOf(connection));
    for (const marketId of marketIds) {
      const account = await connection.getAccountInfo(instructions.addresses.priceFeed(marketId));
      if (!account) throw new Error(`market ${marketId} has no price feed`);
      const feed = decodePriceFeed(account.data);
      if (feed.publishTime >= time || feed.acceptedAt >= time) continue;
      await sendAndConfirm(
        connection,
        [instructions.publishPrice(oracle.publicKey, marketId, feed.price, time)],
        oracle,
      );
    }
  };
  await publishOnce();
  let publishing = false;
  const timer = setInterval(() => {
    if (publishing) return;
    publishing = true;
    publishOnce()
      .catch((error: unknown) => {
        process.stderr.write(`price publish failed: ${String(error).slice(0, 120)}\n`);
      })
      .finally(() => {
        publishing = false;
      });
  }, PUBLISH_EVERY_MS);
  return () => clearInterval(timer);
};
