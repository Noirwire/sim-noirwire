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
  globalSocket,
  ownFills,
  randomSecret,
  sendAndConfirm,
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
import { backedOffSockets } from "./bot-socket.js";
import { Session, connectionTo } from "./connections.js";
import type { Generation } from "./generation.js";
import { fetchWithin } from "./timeouts.js";
import { sendDepositAndConfirm, sendInstructionsWithin } from "./transactions.js";

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

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

const base58Of = (bytes: Uint8Array): string => {
  let number = 0n;
  for (const byte of bytes) number = number * 256n + BigInt(byte);
  let text = "";
  for (; number > 0n; number /= 58n) text = BASE58[Number(number % 58n)] + text;
  for (const byte of bytes) {
    if (byte !== 0) break;
    text = `1${text}`;
  }
  return text;
};

/**
 * The endpoint's sign-in: a challenge, signed by the key, exchanged for a
 * token. It is the order book client's own sign-in written out so that its
 * two requests go through a fetch the generation can abort: a sign-in under
 * way when the service goes to sleep sends nothing more.
 */
const signInTo = async (rpcUrl: string, key: Keypair, life?: Generation): Promise<string> => {
  const send = fetchWithin(SIGN_IN_TIMEOUT_MS, undefined, life);
  const pubkey = key.publicKey.toString();
  const challengeResponse = await send(
    `${rpcUrl}/auth/challenge?${new URLSearchParams({ pubkey })}`,
  );
  const { challenge } = (await challengeResponse.json()) as { challenge?: unknown };
  if (typeof challenge !== "string" || challenge.length === 0) {
    throw new Error("sign-in: no challenge received");
  }
  const signature = await signerOf(key)(new Uint8Array(Buffer.from(challenge, "utf-8")));
  const loginResponse = await send(`${rpcUrl}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pubkey, challenge, signature: base58Of(signature) }),
  });
  const { token } = (await loginResponse.json()) as { token?: unknown };
  if (loginResponse.status !== 200 || typeof token !== "string" || token.length === 0) {
    throw new Error("sign-in: the endpoint did not accept the signature");
  }
  return token;
};

/** Signs `key` in to the private endpoint. The query filter accepts sends only from a signed-in caller. */
export const signedInConnection = async (
  rpcUrl: string,
  key: Keypair,
  life?: Generation,
  hangWhenEnded = false,
): Promise<Connection> => {
  const token = await signInTo(rpcUrl, key, life);
  return connectionTo(
    `${rpcUrl}?token=${token}`,
    `${websocketUrl(rpcUrl)}?token=${token}`,
    life,
    hangWhenEnded,
  );
};

/** A key's session; each connection it opens belongs to the generation `life` names at that moment. */
export const signedInSession = (
  rpcUrl: string,
  key: Keypair,
  life: () => Generation | undefined,
): Session => new Session(() => signedInConnection(rpcUrl, key, life()));

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
  async publishPrices(
    connection: Connection,
    oracle: Keypair,
    prices: { marketId: number; price: bigint }[],
    publishTimeSeconds: number,
    /** The whole publish, send and confirmation, is given up after this long. */
    timeoutMs: number,
  ): Promise<void> {
    await sendInstructionsWithin(
      connection,
      prices.map(({ marketId, price }) =>
        this.instructions.publishPrice(
          oracle.publicKey,
          marketId,
          price,
          BigInt(publishTimeSeconds),
        ),
      ),
      oracle,
      timeoutMs,
      true,
    );
  }

  async updateFunding(connection: Connection, payer: Keypair, marketId: number): Promise<void> {
    await sendInstructionsWithin(
      connection,
      [this.instructions.updateFunding(marketId)],
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
    life?: Generation,
  ): Promise<ProgramTrader | null> {
    const connection = await signedInConnection(rpcUrl, owner, life, true);
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
    return new ProgramTrader(rpcUrl, owner, keys, this.programId, connection, life);
  }

  /** As `ownTrader`, and opens the seat with the gate's signature when there is none. */
  async openOwnTrader(
    rpcUrl: string,
    owner: Keypair,
    gate: Keypair,
    gateConnection: Connection,
    checkpoint?: KeyCheckpoint,
    life?: Generation,
  ): Promise<ProgramTrader> {
    const existing = await this.ownTrader(rpcUrl, owner, checkpoint, life);
    if (existing) return existing;
    await sendAndConfirm(
      gateConnection,
      [this.instructions.openTrader(gate.publicKey, owner.publicKey, firstOrderKeys(owner))],
      gate,
      [owner],
    );
    return this.newTrader(rpcUrl, owner, life);
  }

  /** A trader just opened with `firstOrderKeys(owner)`, before it sent anything. */
  async newTrader(rpcUrl: string, owner: Keypair, life?: Generation): Promise<ProgramTrader> {
    const connection = await signedInConnection(rpcUrl, owner, life, true);
    const keys = OrderKeyManager.fresh(orderKeySeedOf(owner));
    return new ProgramTrader(rpcUrl, owner, keys, this.programId, connection, life);
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

const nativeSocket = globalSocket();
/**
 * What every bot's view subscription opens its websocket through, so that
 * all ten share one backoff when the endpoint refuses them. Kept, rather than
 * turning the subscription off (`push: false`), because without it each
 * order polls the view every 50 ms until its result shows.
 */
const BOT_VIEW_SOCKETS = nativeSocket && backedOffSockets(nativeSocket);

/** One trader: signs in as its owner, trades with one-time order keys, reads its own view. */
export class ProgramTrader {
  private client: TraderClient;
  private signInAgain = false;
  private closed = false;
  private queue: Promise<unknown> = Promise.resolve();
  private unsettled: Promise<unknown> = Promise.resolve();
  /** Calls that may have signed and are under way, and calls whose outcome was unknown and not yet settled. */
  private signingCalls = 0;
  private unknownOutcomes = 0;

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
    /** The generation it was made for: once it ends the trader sends nothing and refuses every call. */
    private readonly life?: Generation,
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
      { socket: BOT_VIEW_SOCKETS },
    );
  }

  /**
   * Lets go of the websocket and the timer the client holds once it has made
   * a call, for good: the client starts both again on its next call, so a
   * closed trader refuses every later one. What the client still polls for,
   * a result or a quarantined order key, stops with its generation.
   */
  close(): void {
    this.closed = true;
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
  private run<T>(operation: (client: TraderClient) => Promise<T>, signs = true): Promise<T> {
    if (this.inFlightLimit > 1) return this.runNow(operation, signs);
    const next = this.queue.then(() => this.unsettled).then(() => this.runNow(operation, signs));
    this.queue = next.catch(() => undefined);
    return next;
  }

  private assertAlive(): void {
    if (this.closed) throw new Error("this trader was closed");
    if (this.life?.ended) throw new Error("this trader belongs to a generation that went to sleep");
  }

  /**
   * A failure on the wire signs in again before the next instruction. Only a
   * call that `signs` counts as one that may still land when the service
   * sleeps: a read that is cut short signed nothing, so its keys are free.
   */
  private async runNow<T>(
    operation: (client: TraderClient) => Promise<T>,
    signs: boolean,
  ): Promise<T> {
    this.assertAlive();
    if (this.signInAgain) {
      const connection = await signedInConnection(this.rpcUrl, this.owner, this.life, true);
      // The service may have gone to sleep while it signed in.
      this.assertAlive();
      // The old client holds a websocket on the old token: results are pushed over it.
      this.client.close();
      this.client = this.clientOn(connection);
      this.signInAgain = false;
    }
    if (signs) this.signingCalls += 1;
    try {
      return await operation(this.client);
    } catch (error) {
      const answered =
        error instanceof TransactionFailed ||
        error instanceof OrderInvalid ||
        error instanceof OutcomeUnknown;
      if (!answered) this.signInAgain = true;
      throw error;
    } finally {
      if (signs) this.signingCalls -= 1;
    }
  }

  /**
   * Whether a call it signed may still land: one under way, or one whose
   * outcome was unknown and is not settled. The order key it holds is not
   * free until that call's expiry has passed.
   */
  get hasUnsettled(): boolean {
    return this.signingCalls > 0 || this.unknownOutcomes > 0;
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
    this.unknownOutcomes += 1;
    this.unsettled = settled.catch(() => undefined);
    void this.unsettled.then(() => (this.unknownOutcomes -= 1));
    return { status: "unknown", ...NOTHING_PLACED, settled };
  }

  view(): Promise<SeatView> {
    return this.run(async (client) => seatViewOf(await client.view()), false);
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
