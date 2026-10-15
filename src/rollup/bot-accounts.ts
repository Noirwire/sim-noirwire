import type { Keypair } from "@solana/web3.js";
import type { TraderKey } from "../engine/types.js";
import type { DepositTarget, KeyCheckpoint } from "./chain-types.js";
import type { Session } from "./connections.js";
import type { Generation } from "./generation.js";
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

/** The longest a signed call can still land: the program takes an expiry 60 s ahead at most, and a margin. */
const SIGNED_CALL_LANDS_WITHIN_MS = 65_000;

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
  /** The generation now current; a trader is made for it and ends with it. */
  life: () => Generation | undefined;
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
  /** Where the order keys of the traders let go of stood, by owner address. */
  private readonly letGo: Record<string, KeyCheckpoint> = {};
  /** Until when a bot's order keys may not be signed with again, by owner address. */
  private readonly heldUntilMs: Record<string, number> = {};

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
    const address = bot.owner.publicKey.toBase58();
    const heldFor = (this.heldUntilMs[address] ?? 0) - Date.now();
    if (heldFor > 0) {
      throw new Error(
        `${key} left a call unsettled when it was let go: its order keys wait ${Math.ceil(heldFor / 1_000)} s more`,
      );
    }
    const life = this.options.life();
    let opening = this.opening.get(key);
    if (!opening) {
      const { program, settings, gate, keyCheckpoints } = this.options;
      const attempt: Promise<ProgramTrader> = gate
        .use((gateConnection) =>
          program.openOwnTrader(
            settings.rollupRpcUrl,
            bot.owner,
            settings.gate,
            gateConnection,
            this.letGo[address] ?? keyCheckpoints[address],
            life,
          ),
        )
        .finally(() => {
          // A retire may have cleared the map, and a new wake started another opening of this bot.
          if (this.opening.get(key) === attempt) this.opening.delete(key);
        });
      opening = attempt;
      this.opening.set(key, attempt);
    }
    const opened = await opening;
    if (life?.ended) {
      // The service went to sleep while the trader was being opened: it belongs to a dead generation.
      opened.close();
      throw new Error("the service went to sleep while a bot was being opened");
    }
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
    const checkpoints = { ...this.options.keyCheckpoints, ...this.letGo };
    for (const trader of this.traders.values()) checkpoints[trader.address] = trader.checkpoint;
    return checkpoints;
  }

  /**
   * Lets go of every open trader, keeping where its order keys stand. The
   * next call for a bot opens a new trader, for the generation then current,
   * from that checkpoint: nothing of an old trader, a call still waiting on
   * its result included, is resumed.
   */
  retire(): void {
    for (const trader of this.traders.values()) {
      this.letGo[trader.address] = trader.checkpoint;
      // The checkpoint does not say which of the four order keys a signed call still holds, and
      // that call may land until its expiry: until then no trader may sign with this bot's keys.
      if (trader.hasUnsettled) {
        this.heldUntilMs[trader.address] = Date.now() + SIGNED_CALL_LANDS_WITHIN_MS;
      }
      trader.close();
    }
    this.traders.clear();
    this.opening.clear();
  }

  close(): void {
    for (const trader of this.traders.values()) trader.close();
  }
}
