/**
 * The one module that imports the order book client package. Everything else
 * in this service sees the plain types of `chain-types.ts`, so a new client
 * release is an edit to this file and nothing else.
 */
import { createHash, createPrivateKey, sign } from "node:crypto";
import { type Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import {
  INSURANCE_SEAT,
  Instructions,
  LIQUIDATION_STATUS,
  MARKET_KIND,
  MarketReader,
  ORDER_TYPE,
  OrderInvalid,
  OrderKeyManager,
  OutcomeUnknown,
  RESULT_STATUS,
  SEATS,
  SIDE,
  TraderClient,
  TransactionFailed,
  associatedTokenAddress,
  clockOf,
  decodeMarket,
  decodeView,
  ownFills,
  randomSecret,
  sendAndConfirm,
  signIn,
  websocketUrl,
  type OrderResult,
  type PriceFeed,
  type Stats,
  type Tape,
  type TapeFill,
  type Timing,
  type View,
} from "@noirwire/orderbook";
import type {
  ChainFill,
  ChainMarket,
  ChainOrder,
  ChainOrderType,
  ChainPrice,
  ChainSide,
  ChainStats,
  ChainTape,
  DepositTarget,
  KeyCheckpoint,
  PlaceOutcome,
  PlaceStatus,
  PublicAddresses,
  SeatView,
  Unsubscribe,
} from "./chain-types.js";
import { Session, connectionTo } from "./connections.js";
import { within } from "./timeouts.js";
import { sendDepositAndConfirm, sendInstructionWithin } from "./transactions.js";

export const CLIENT_RELEASE = "@noirwire/orderbook 0.5.1";
/** The program's error number for "the exchange has opened its daily limit of new seats". */
export const DAILY_SEAT_LIMIT_ERROR = 6137;
/** The fee and insurance seats come first; traders sit from here up. */
export const FIRST_TRADER_SEAT = INSURANCE_SEAT + 1;
export const SEAT_COUNT = SEATS;

const ORDER_KEY_SEARCH_WINDOW = 4_096;
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const LIQUIDATE_UP_TO_LOTS = 1_000_000_000n;
const SIGN_IN_TIMEOUT_MS = 10_000;
/** A price is stale on chain after ten seconds: a publish that takes longer is given up for the next. */
const PUBLISH_WITHIN_MS = 8_000;
const NO_RESTING_EXPIRY = 0n;

const sideOf = (code: number): ChainSide => (code === SIDE.bid ? "buy" : "sell");
const sideCode = (side: ChainSide): number => (side === "buy" ? SIDE.bid : SIDE.ask);

const ORDER_TYPE_CODE: Record<ChainOrderType, number> = {
  limit: ORDER_TYPE.limit,
  postOnly: ORDER_TYPE.postOnly,
  ioc: ORDER_TYPE.immediateOrCancel,
  market: ORDER_TYPE.market,
};

const placeStatusOf = (status: number, rested: bigint): PlaceStatus => {
  if (status === RESULT_STATUS.filled) return "filled";
  if (status === RESULT_STATUS.rested || rested > 0n) return "rested";
  if (status === RESULT_STATUS.refusedPostOnlyWouldMatch) return "refused";
  return "cancelled";
};

const NOTHING_PLACED = { filled: 0n, rested: 0n, sendToResultMs: 0 };
const EXPIRED: PlaceOutcome = { status: "expired", ...NOTHING_PLACED };

const placedAs = (result: OrderResult, timing: Timing): PlaceOutcome => ({
  status: placeStatusOf(result.status, result.rested),
  filled: result.filled,
  rested: result.rested,
  sendToResultMs: timing.resultAt - timing.sentAt,
});

const chainFillOf = (fill: TapeFill): ChainFill => ({
  sequence: fill.fillSeq,
  price: fill.price,
  size: fill.size,
  timeSeconds: Number(fill.time),
  takerSide: sideOf(fill.takerSide),
  makerReceipt: fill.makerReceipt,
  takerReceipt: fill.takerReceipt,
});

const tapeFillOf = (fill: ChainFill): TapeFill => ({
  fillSeq: fill.sequence,
  price: fill.price,
  size: fill.size,
  time: BigInt(fill.timeSeconds),
  makerReceipt: fill.makerReceipt,
  takerReceipt: fill.takerReceipt,
  takerSide: sideCode(fill.takerSide),
});

const chainTapeOf = (tape: Tape): ChainTape => ({
  lastSequence: tape.lastFillSeq,
  fills: tape.fills.map(chainFillOf),
});

const chainPriceOf = (feed: PriceFeed): ChainPrice => ({
  price: feed.price,
  publishTimeSeconds: Number(feed.publishTime),
});

const chainStatsOf = ({ orders, fills, openInterest }: Stats): ChainStats => ({
  orders,
  fills,
  openInterest,
});

const seatViewOf = (view: View): SeatView => ({
  seat: view.seat,
  collateral: view.snapshot.seat.collateral,
  spot: view.snapshot.seat.spot.map((balance) => ({ ...balance })),
  perp: view.snapshot.seat.perp.map((slot) => ({ base: slot.base, quote: slot.quote })),
  ordersMarketId: view.snapshot.marketId,
  orders: view.snapshot.orders.map((order) => ({
    side: sideOf(order.side),
    price: order.price,
    remaining: order.remaining,
    sequence: order.sequence,
  })),
});

const signerOf = (key: Keypair) => {
  const privateKey = createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, key.secretKey.subarray(0, 32)]),
    format: "der",
    type: "pkcs8",
  });
  return async (message: Uint8Array) => new Uint8Array(sign(null, message, privateKey));
};

/** Signs `key` in to the private endpoint. The query filter accepts sends only from a signed-in caller. */
export const signedInConnection = async (rpcUrl: string, key: Keypair): Promise<Connection> => {
  const token = await within(
    signIn(rpcUrl, key.publicKey, signerOf(key)),
    SIGN_IN_TIMEOUT_MS,
    "signing in",
  );
  return connectionTo(`${rpcUrl}?token=${token}`, `${websocketUrl(rpcUrl)}?token=${token}`);
};

export const signedInSession = (rpcUrl: string, key: Keypair): Session =>
  new Session(() => signedInConnection(rpcUrl, key));

export const newOrderSecret = (): Uint8Array => randomSecret();

/** A trader's order keys all follow from this seed, which follows from its owner key alone. */
const orderKeySeedOf = (owner: Keypair): Uint8Array =>
  new Uint8Array(
    createHash("sha256")
      .update("noirwire-sim/order-key-seed/v1")
      .update(owner.secretKey.subarray(0, 32))
      .digest(),
  );

/** The four public order keys a new trader's view is opened with. */
export const firstOrderKeys = (owner: Keypair): PublicKey[] =>
  OrderKeyManager.fresh(orderKeySeedOf(owner)).publicKeys;

/** Which side of `fill`, if any, was an order placed with one of `secrets`. */
export const fillRoles = (
  fill: ChainFill,
  secrets: Uint8Array[],
): { maker: boolean; taker: boolean } => {
  const own = ownFills([tapeFillOf(fill)], secrets);
  return {
    maker: own.some((entry) => entry.role === "maker"),
    taker: own.some((entry) => entry.role === "taker"),
  };
};

export interface OpenAndFundRequest {
  gate: PublicKey;
  faucet: PublicKey;
  owner: PublicKey;
  orderKeys: PublicKey[];
  mint: string;
  amount: bigint;
}

export class Program {
  readonly programId: PublicKey;
  private readonly instructions: Instructions;

  constructor(programId: string) {
    this.programId = new PublicKey(programId);
    this.instructions = new Instructions(this.programId);
  }

  private reader(connection: Connection): MarketReader {
    return new MarketReader(connection, this.programId);
  }

  /** The rollup's own clock, in unix seconds. */
  clockSeconds(connection: Connection): Promise<number> {
    return clockOf(connection);
  }

  /** The public addresses the program derives: the exchange, the stats and one market's accounts. */
  publicAddresses(marketId: number): PublicAddresses {
    const { addresses } = this.instructions;
    return {
      exchange: addresses.exchange.toBase58(),
      stats: addresses.stats.toBase58(),
      market: addresses.market(marketId).toBase58(),
      tape: addresses.tape(marketId).toBase58(),
      priceFeed: addresses.priceFeed(marketId).toBase58(),
    };
  }

  async market(connection: Connection, marketId: number): Promise<ChainMarket> {
    const account = await connection.getAccountInfo(this.instructions.addresses.market(marketId));
    if (!account) throw new Error(`market ${marketId} is not on this network`);
    const { params } = decodeMarket(account.data);
    return {
      marketId: params.marketId,
      kind: params.kind === MARKET_KIND.perp ? "perp" : "spot",
      tick: params.tick,
      baseLot: params.baseLot,
      minNotional: params.minNotional,
      bandBps: params.bandBps,
      initialMarginBps: params.imBps,
      maxMoveBps: params.maxMoveBps,
      maxPriceAgeSeconds: Number(params.maxPriceAge),
      fundingIntervalSeconds: Number(params.fundingInterval),
      baseToken: params.baseToken,
      quoteToken: params.quoteToken,
    };
  }

  async price(connection: Connection, marketId: number): Promise<ChainPrice> {
    return chainPriceOf(await this.reader(connection).priceFeed(marketId));
  }

  async tape(connection: Connection, marketId: number): Promise<ChainTape> {
    return chainTapeOf(await this.reader(connection).tape(marketId));
  }

  async stats(connection: Connection): Promise<ChainStats> {
    return chainStatsOf(await this.reader(connection).stats());
  }

  subscribeTape(
    connection: Connection,
    marketId: number,
    onChange: (tape: ChainTape) => void,
  ): Unsubscribe {
    return this.reader(connection).subscribeTape(marketId, (tape) => onChange(chainTapeOf(tape)));
  }

  subscribePrice(
    connection: Connection,
    marketId: number,
    onChange: (price: ChainPrice) => void,
  ): Unsubscribe {
    return this.reader(connection).subscribePriceFeed(marketId, (feed) =>
      onChange(chainPriceOf(feed)),
    );
  }

  subscribeStats(connection: Connection, onChange: (stats: ChainStats) => void): Unsubscribe {
    return this.reader(connection).subscribeStats((stats) => onChange(chainStatsOf(stats)));
  }

  /**
   * `publishTimeSeconds` is the rollup's own clock: the program refuses a
   * time ahead of it, and one that is not after the feed's last.
   */
  async publishPrice(
    connection: Connection,
    oracle: Keypair,
    marketId: number,
    price: bigint,
    publishTimeSeconds: number,
  ): Promise<void> {
    await sendInstructionWithin(
      connection,
      this.instructions.publishPrice(oracle.publicKey, marketId, price, BigInt(publishTimeSeconds)),
      oracle,
      PUBLISH_WITHIN_MS,
    );
  }

  async updateFunding(connection: Connection, payer: Keypair, marketId: number): Promise<void> {
    await sendInstructionWithin(
      connection,
      this.instructions.updateFunding(marketId),
      payer,
      PUBLISH_WITHIN_MS,
    );
  }

  /** Credits the seat of `owner` from the faucet. The program finds the seat through the owner's view. */
  async deposit(
    connection: Connection,
    faucet: Keypair,
    mint: string,
    owner: string,
    target: DepositTarget,
    amount: bigint,
  ): Promise<string> {
    const latest = await connection.getLatestBlockhash("confirmed");
    const transaction = new Transaction({ feePayer: faucet.publicKey, ...latest }).add(
      this.depositInstruction(faucet.publicKey, mint, new PublicKey(owner), target, amount),
    );
    transaction.sign(faucet);
    return sendDepositAndConfirm(connection, transaction);
  }

  private depositInstruction(
    faucet: PublicKey,
    mint: string,
    owner: PublicKey,
    target: DepositTarget,
    amount: bigint,
  ) {
    const mintKey = new PublicKey(mint);
    return this.instructions.deposit(
      faucet,
      associatedTokenAddress(faucet, mintKey),
      mintKey,
      owner,
      target === "collateral" ? { collateral: true } : { spot: target.spotToken },
      amount,
    );
  }

  /**
   * One transaction that opens a seat for `owner` and credits it from the
   * faucet, so the two happen together or not at all. It carries no signature yet.
   */
  async openAndFundTransaction(
    connection: Connection,
    request: OpenAndFundRequest,
  ): Promise<Transaction> {
    const { gate, faucet, owner, orderKeys, mint, amount } = request;
    const latest = await connection.getLatestBlockhash("confirmed");
    return new Transaction({ feePayer: gate, ...latest }).add(
      this.instructions.openTrader(gate, owner, orderKeys),
      this.depositInstruction(faucet, mint, owner, "collateral", amount),
    );
  }

  /**
   * A trader whose owner key this process holds and whose seat exists, or
   * null when it has none. Its order keys are picked up from `checkpoint`.
   * Without one, or when the keys moved further than it reaches, all four
   * are replaced by the first four of the derivation, signed by the owner.
   */
  async ownTrader(
    rpcUrl: string,
    owner: Keypair,
    checkpoint?: KeyCheckpoint,
  ): Promise<ProgramTrader | null> {
    const connection = await signedInConnection(rpcUrl, owner);
    const account = await connection.getAccountInfo(
      this.instructions.addresses.view(owner.publicKey),
    );
    if (!account) return null;
    const seed = orderKeySeedOf(owner);
    let keys = checkpoint ? restoredKeys(seed, account.data, checkpoint) : null;
    if (!keys) {
      keys = OrderKeyManager.fresh(seed);
      await sendAndConfirm(
        connection,
        [this.instructions.setOrderKeys(owner.publicKey, keys.publicKeys)],
        owner,
      );
    }
    return new ProgramTrader(rpcUrl, owner, keys, this.programId, connection);
  }

  /** As `ownTrader`, and opens the seat with the gate's signature when there is none. */
  async openOwnTrader(
    rpcUrl: string,
    owner: Keypair,
    gate: Keypair,
    gateConnection: Connection,
    checkpoint?: KeyCheckpoint,
  ): Promise<ProgramTrader> {
    const existing = await this.ownTrader(rpcUrl, owner, checkpoint);
    if (existing) return existing;
    await sendAndConfirm(
      gateConnection,
      [this.instructions.openTrader(gate.publicKey, owner.publicKey, firstOrderKeys(owner))],
      gate,
      [owner],
    );
    return this.newTrader(rpcUrl, owner);
  }

  /** A trader just opened with `firstOrderKeys(owner)`, before it sent anything. */
  async newTrader(rpcUrl: string, owner: Keypair): Promise<ProgramTrader> {
    const connection = await signedInConnection(rpcUrl, owner);
    const keys = OrderKeyManager.fresh(orderKeySeedOf(owner));
    return new ProgramTrader(rpcUrl, owner, keys, this.programId, connection);
  }
}

/** Null when the view's keys are not where the checkpoint says, nor within reach of it. */
const restoredKeys = (
  seed: Uint8Array,
  viewData: Buffer,
  checkpoint: KeyCheckpoint,
): OrderKeyManager | null => {
  try {
    return OrderKeyManager.restore(seed, decodeView(viewData), checkpoint, ORDER_KEY_SEARCH_WINDOW);
  } catch {
    return null;
  }
};

/** One trader: signs in as its owner, trades with one-time order keys, reads its own view. */
export class ProgramTrader {
  private client: TraderClient;
  private signInAgain = false;
  private queue: Promise<unknown> = Promise.resolve();
  private unsettled: Promise<unknown> = Promise.resolve();

  /**
   * How many instructions the caller keeps in flight at once: one unless
   * set, four at most, since a view has four order key slots. With more than
   * one, an unknown outcome holds back only its own slot, which the client
   * keeps out of use until it settles.
   */
  inFlightLimit = 1;

  constructor(
    private readonly rpcUrl: string,
    private readonly owner: Keypair,
    private readonly keys: OrderKeyManager,
    private readonly programId: PublicKey,
    connection: Connection,
  ) {
    this.client = this.clientOn(connection);
  }

  private clientOn(connection: Connection): TraderClient {
    return new TraderClient(
      connection,
      connection,
      this.owner.publicKey,
      this.keys,
      this.programId,
    );
  }

  /** Lets go of the websocket and the timer the client holds once it has made a call. */
  close(): void {
    this.client.close();
  }

  get address(): string {
    return this.owner.publicKey.toBase58();
  }

  get checkpoint(): KeyCheckpoint {
    return this.keys.checkpoint;
  }

  /**
   * One instruction at a time per trader, and none while an earlier one's
   * outcome is still unknown: the instruction may run until the rollup's
   * clock passes its expiry.
   */
  private run<T>(operation: (client: TraderClient) => Promise<T>): Promise<T> {
    if (this.inFlightLimit > 1) return this.runOne(operation);
    const next = this.queue.then(() => this.unsettled).then(() => this.runOne(operation));
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** A failure on the wire signs in again before the next instruction. */
  private async runOne<T>(operation: (client: TraderClient) => Promise<T>): Promise<T> {
    if (this.signInAgain) {
      const connection = await signedInConnection(this.rpcUrl, this.owner);
      // The old client holds a websocket on the old token: results are pushed over it.
      this.client.close();
      this.client = this.clientOn(connection);
      this.signInAgain = false;
    }
    try {
      return await operation(this.client);
    } catch (error) {
      const answered =
        error instanceof TransactionFailed ||
        error instanceof OrderInvalid ||
        error instanceof OutcomeUnknown;
      if (!answered) this.signInAgain = true;
      throw error;
    }
  }

  /**
   * The result of a call other than an order, or null when the instruction
   * never ran. A call whose outcome the client could not tell in time is
   * waited for until it settles.
   */
  private async resultOf(call: Promise<OrderResult>): Promise<OrderResult | null> {
    try {
      return await call;
    } catch (error) {
      if (!(error instanceof OutcomeUnknown)) throw error;
      if (error.cause !== undefined) this.signInAgain = true;
      return error.settled;
    }
  }

  private unknownUntil(settled: Promise<PlaceOutcome>): PlaceOutcome {
    this.unsettled = settled.catch(() => undefined);
    return { status: "unknown", ...NOTHING_PLACED, settled };
  }

  view(): Promise<SeatView> {
    return this.run(async (client) => seatViewOf(await client.view()));
  }

  place(marketId: number, order: ChainOrder, riskMarkets: number[]): Promise<PlaceOutcome> {
    return this.run(async (client): Promise<PlaceOutcome> => {
      const placed = await client.placeOrder(
        marketId,
        {
          side: sideCode(order.side),
          orderType: ORDER_TYPE_CODE[order.type],
          price: order.price,
          size: order.size,
          reduceOnly: order.reduceOnly,
          secret: order.secret,
          expiry:
            order.restingExpirySeconds === undefined
              ? NO_RESTING_EXPIRY
              : BigInt(order.restingExpirySeconds),
        },
        { riskMarkets },
      );
      if (placed.outcome === "expired") return EXPIRED;
      if (placed.outcome === "placed") return placedAs(placed.result, placed);
      return this.unknownUntil(
        placed.settled.then((settled) =>
          settled.outcome === "placed" ? placedAs(settled.result, settled) : EXPIRED,
        ),
      );
    }).catch((error: unknown): PlaceOutcome => {
      if (error instanceof OutcomeUnknown) {
        if (error.cause !== undefined) this.signInAgain = true;
        return this.unknownUntil(
          error.settled.then((result) => (result ? placedAs(result, result) : EXPIRED)),
        );
      }
      if (error instanceof OrderInvalid) {
        return { status: "invalid", ...NOTHING_PLACED, reason: error.reason };
      }
      if (error instanceof TransactionFailed) {
        return {
          status: "failed",
          ...NOTHING_PLACED,
          reason: `program error ${error.code ?? "unknown"}`,
        };
      }
      throw error;
    });
  }

  /**
   * Resolves to how many orders were cancelled, or null when the instruction
   * never ran. Throws when the program refused the transaction.
   */
  cancelAll(marketId: number): Promise<bigint | null> {
    return this.run(
      async (client) => (await this.resultOf(client.cancelAll(marketId)))?.cancelled ?? null,
    );
  }

  /** Brings the view's seat copy up to date. False when the instruction never ran. */
  sync(marketId: number): Promise<boolean> {
    return this.run(async (client) => (await this.resultOf(client.syncView(marketId))) !== null);
  }

  /**
   * Whether seat `seat` was liquidated. Nobody can read another seat, so
   * this is tried blind: a seat that is empty, healthy or without a position
   * all answer the same. `worstPrice` set to the mark accepts a liquidation
   * in either direction: below the mark from a long, above it from a short.
   */
  liquidate(
    marketId: number,
    seat: number,
    worstPrice: bigint,
    riskMarkets: number[],
  ): Promise<boolean> {
    return this.run(async (client) => {
      const result = await this.resultOf(
        client.liquidate(marketId, seat, LIQUIDATE_UP_TO_LOTS, worstPrice, riskMarkets),
      );
      return result?.status === LIQUIDATION_STATUS.liquidated;
    }).catch((error: unknown) => {
      if (error instanceof TransactionFailed) return false;
      throw error;
    });
  }
}
