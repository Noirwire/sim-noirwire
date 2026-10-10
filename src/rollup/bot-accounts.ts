import type { Keypair } from "@solana/web3.js";
import type { TraderKey } from "../engine/types.js";
import type { DepositTarget, KeyCheckpoint } from "./chain-types.js";
import type { Session } from "./connections.js";
import type { Program, ProgramTrader } from "./program.js";
import type { RollupSettings } from "./settings.js";
import { COLLATERAL_TOKEN, deployedToken } from "./tokens.js";
import { toChainAmount } from "./units.js";

export interface BotSpec {
  key: TraderKey;
  owner: Keypair;
  /** Holds its nUSD as perpetuals collateral. */
  tradesPerps: boolean;
  /** Holds its nUSD in the spot balance as well. */
  tradesSpot: boolean;
}

export interface BotAccountsOptions {
  program: Program;
  settings: RollupSettings;
  bots: BotSpec[];
  gate: Session;
  faucet: Session;
  /** Per bot owner address, where its order keys stood when an earlier run last saved. */
  keyCheckpoints: Record<string, KeyCheckpoint>;
  /** Any market: a sync on it brings a bot's own view of its balances up to date. */
  syncMarketId: number;
}

/**
 * The bots as ordinary traders on the program: each with its own seat, its
 * own private view and one-time order keys, opened with the gate's signature
 * and funded from the faucet.
 */
export class BotAccounts {
  private readonly traders = new Map<TraderKey, ProgramTrader>();
  private readonly opening = new Map<TraderKey, Promise<ProgramTrader>>();
  private readonly funded = new Set<TraderKey>();

  constructor(private readonly options: BotAccountsOptions) {}

  get count(): number {
    return this.options.bots.length;
  }

  private spec(trader: TraderKey): BotSpec | undefined {
    return this.options.bots.find((bot) => bot.key === trader);
  }

  /** The bot's trader, opened on first use. Concurrent callers share one opening. */
  async trader(key: TraderKey): Promise<ProgramTrader> {
    const open = this.traders.get(key);
    if (open) return open;
    const bot = this.spec(key);
    if (!bot) {
      throw new Error(`${key} is not a trader of this service: users open their own account`);
    }
    let opening = this.opening.get(key);
    if (!opening) {
      const { program, settings, gate, keyCheckpoints } = this.options;
      opening = gate
        .use((gateConnection) =>
          program.openOwnTrader(
            settings.rollupRpcUrl,
            bot.owner,
            settings.gate,
            gateConnection,
            keyCheckpoints[bot.owner.publicKey.toBase58()],
          ),
        )
        .finally(() => this.opening.delete(key));
      this.opening.set(key, opening);
    }
    const opened = await opening;
    this.traders.set(key, opened);
    return opened;
  }

  /**
   * Brings a bot's balance up to `amount` from the faucet, never above it, so
   * a restart does not pay the bots again. A bot's nUSD is held as
   * perpetuals collateral, as a spot balance, or both, by what it trades.
   */
  async topUp(key: TraderKey, token: string, amount: bigint): Promise<void> {
    if (amount <= 0n) return;
    const { program, settings, faucet, syncMarketId } = this.options;
    const bot = this.spec(key);
    const chainToken = deployedToken(settings.deployment, token);
    if (!bot || !chainToken) throw new Error(`no deposit of ${token} for ${key} on this venue`);

    const trader = await this.trader(key);
    await trader.sync(syncMarketId);
    const view = await trader.view();
    const spot = view.spot[chainToken.index];
    const held: { target: DepositTarget; amount: bigint }[] = [];
    if (token !== COLLATERAL_TOKEN || bot.tradesSpot) {
      held.push({ target: { spotToken: chainToken.index }, amount: spot.available + spot.locked });
    }
    if (token === COLLATERAL_TOKEN && bot.tradesPerps) {
      held.push({ target: "collateral", amount: view.collateral });
    }

    const wanted = toChainAmount(amount, chainToken.decimals);
    for (const { target, amount: has } of held) {
      if (has >= wanted) continue;
      await faucet.use((connection) =>
        program.deposit(
          connection,
          settings.faucet,
          chainToken.mint,
          trader.address,
          target,
          wanted - has,
        ),
      );
    }
    this.funded.add(key);
  }

  allFunded(): boolean {
    return this.options.bots.every((bot) => this.funded.has(bot.key));
  }

  /** Where every bot's order keys stand, by owner address, to save and restore from. */
  keyCheckpoints(): Record<string, KeyCheckpoint> {
    const checkpoints = { ...this.options.keyCheckpoints };
    for (const trader of this.traders.values()) checkpoints[trader.address] = trader.checkpoint;
    return checkpoints;
  }

  close(): void {
    for (const trader of this.traders.values()) trader.close();
  }
}
