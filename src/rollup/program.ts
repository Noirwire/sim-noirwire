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
  MARKET_STATUS,
  MarketReader,
  ORACLE_HEALTH,
  ORDER_TYPE,
  OrderInvalid,
  OrderKeyManager,
  OutcomeUnknown,
  RESULT_STATUS,
  SIDE,
  TraderClient,
  TransactionFailed,
  associatedTokenAddress,
  clockOf,
  decodeExchange,
  decodeMarket,
  decodeView,
  globalSocket,
  openSignedTransaction,
  ownFills,
  ownerActionMessage,
  ownerExpiry,
  pythPriceAccount,
  randomSecret,
  sendAndConfirm,
  verifyOwnerSignature,
  websocketUrl,
  type Exchange,
  type OwnerMessageForm,
  type MarketParams,
  type OrderResult,
  type PriceFeed,
  type Stats,
  type Tape,
  type TapeFill,
  type Timing,
  type View,
} from "@noirwire/orderbook";
import type {
  ChainExchange,
  ChainFill,
  ChainMarket,
  ChainMarketStatus,
  ChainOracleHealth,
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
  RangeLiquidation,
  SeatRange,
  SeatView,
  SweepStop,
  Unsubscribe,
} from "./chain-types.js";
import { backedOffSockets } from "./bot-socket.js";
import { Session, connectionTo } from "./connections.js";
import type { Generation } from "./generation.js";
import {
  MAKER_NOT_LISTED_ERROR,
  ORDER_NOT_FOUND_ERROR,
  programErrorLabel,
  programRefusalText,
} from "./program-errors.js";
import { fetchWithin } from "./timeouts.js";
import { sendDepositAndConfirm } from "./transactions.js";

export type { OwnerMessageForm };
export const CLIENT_RELEASE = "@noirwire/orderbook 0.9.0";
/** How long an owner's signed action stays valid, on the rollup's clock. The program allows 120 seconds. */
const OWNER_ACTION_LIFETIME_SECONDS = 100;
/** The program's error number for "the exchange has opened its daily limit of new seats". */
export const DAILY_SEAT_LIMIT_ERROR = 6137;
/** The fee and insurance seats come first; traders sit from here up. */
export const FIRST_TRADER_SEAT = INSURANCE_SEAT + 1;

/** The address of Pyth's price account for a feed id (64 hex characters): the one a market bound to that feed reads. */
export const pythPriceAccountOf = (feedIdHex: string): string =>
  pythPriceAccount(Uint8Array.from(Buffer.from(feedIdHex, "hex"))).toBase58();

const ORDER_KEY_SEARCH_WINDOW = 4_096;
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const LIQUIDATE_UP_TO_LOTS = 1_000_000_000n;
/** The most takeovers one range liquidation makes before it ends; the sweep carries on from where it stopped. */
const TAKEOVERS_PER_SWEEP = 4;
const SIGN_IN_TIMEOUT_MS = 10_000;
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

/** Why a range liquidation ended early, from the status its result records; null when it reached the end of its range. */
const sweepStopOf = (status: number): SweepStop | null => {
  if (status === 0) return null;
  if (status === LIQUIDATION_STATUS.stalePrice) return "stalePrice";
  if (status === LIQUIDATION_STATUS.liquidatorMarginInsufficient) {
    return "liquidatorMarginInsufficient";
  }
  if (status === LIQUIDATION_STATUS.liquidatorSlotsFull) return "liquidatorSlotsFull";
  return "unrecognised";
};

const NOTHING_PLACED = { filled: 0n, rested: 0n, sendToResultMs: 0 };
const EXPIRED: PlaceOutcome = { status: "expired", ...NOTHING_PLACED };

const placedAs = (result: OrderResult, timing: Timing): PlaceOutcome => ({
  status: placeStatusOf(result.status, result.rested),
  filled: result.filled,
  rested: result.rested,
  ...(result.rested > 0n ? { orderSeq: result.orderSeq } : {}),
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

const MARKET_STATUS_OF: Record<number, ChainMarketStatus> = {
  [MARKET_STATUS.active]: "active",
  [MARKET_STATUS.paused]: "paused",
  [MARKET_STATUS.reduceOnly]: "reduceOnly",
};

const ORACLE_HEALTH_OF: Record<number, ChainOracleHealth> = {
  [ORACLE_HEALTH.healthy]: "healthy",
  [ORACLE_HEALTH.dislocated]: "dislocated",
  [ORACLE_HEALTH.settling]: "settling",
};

/** A status this release does not know is taken as the strictest: no new exposure. */
const chainMarketOf = (params: MarketParams): ChainMarket => ({
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
  positionCap: params.positionCap,
  status: MARKET_STATUS_OF[params.status] ?? "paused",
  oracleHealth: ORACLE_HEALTH_OF[params.oracleHealth] ?? "dislocated",
});

const chainExchangeOf = (exchange: Exchange): ChainExchange => ({
  paused: exchange.paused,
  quoteGuardOkUntilSeconds: exchange.quote.account.equals(PublicKey.default)
    ? null
    : Number(exchange.quote.okUntil),
  maxSeatsPerDay: exchange.maxSeatsPerDay,
  seatCapacity: exchange.seatCapacity,
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
  perp: view.snapshot.seat.positions.map(({ marketId, base, quote }) => ({
    marketId,
    base,
    quote,
  })),
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

/** A deployed token as a deposit names it: its mint and the nonce of its custody authority. */
export interface CustodyTokenRef {
  mint: string;
  /** Decimal text, as the deployment description records it. */
  custodyNonce: string;
}

const custodyTokenOf = ({ mint, custodyNonce }: CustodyTokenRef) => ({
  mint: new PublicKey(mint),
  custodyNonce: BigInt(custodyNonce),
});

export interface OpenAndFundRequest {
  gate: PublicKey;
  faucet: PublicKey;
  owner: PublicKey;
  orderKeys: PublicKey[];
  token: CustodyTokenRef;
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
    return chainMarketOf(decodeMarket(account.data).params);
  }

  async exchange(connection: Connection): Promise<ChainExchange> {
    const account = await connection.getAccountInfo(this.instructions.addresses.exchange);
    if (!account) throw new Error("the exchange is not on this network");
    return chainExchangeOf(decodeExchange(account.data));
  }

  subscribeMarket(
    connection: Connection,
    marketId: number,
    onChange: (market: ChainMarket) => void,
  ): Unsubscribe {
    return this.subscribeAccount(connection, this.instructions.addresses.market(marketId), (data) =>
      onChange(chainMarketOf(decodeMarket(data).params)),
    );
  }

  subscribeExchange(
    connection: Connection,
    onChange: (exchange: ChainExchange) => void,
  ): Unsubscribe {
    return this.subscribeAccount(connection, this.instructions.addresses.exchange, (data) =>
      onChange(chainExchangeOf(decodeExchange(data))),
    );
  }

  private subscribeAccount(
    connection: Connection,
    address: PublicKey,
    onChange: (data: Uint8Array) => void,
  ): Unsubscribe {
    const id = connection.onAccountChange(address, (account) => onChange(account.data), {
      commitment: "confirmed",
    });
    return () => connection.removeAccountChangeListener(id);
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

  /** Credits the seat of `owner` from the faucet. The program finds the seat through the owner's view. */
  async deposit(
    connection: Connection,
    faucet: Keypair,
    token: CustodyTokenRef,
    owner: string,
    target: DepositTarget,
    amount: bigint,
  ): Promise<string> {
    const latest = await connection.getLatestBlockhash("confirmed");
    const transaction = new Transaction({ feePayer: faucet.publicKey, ...latest }).add(
      this.depositInstruction(faucet.publicKey, token, new PublicKey(owner), target, amount),
    );
    transaction.sign(faucet);
    return sendDepositAndConfirm(connection, transaction);
  }

  private depositInstruction(
    faucet: PublicKey,
    token: CustodyTokenRef,
    owner: PublicKey,
    target: DepositTarget,
    amount: bigint,
  ) {
    const custodyToken = custodyTokenOf(token);
    return this.instructions.deposit(
      faucet,
      associatedTokenAddress(faucet, custodyToken.mint),
      custodyToken,
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
    const { gate, faucet, owner, orderKeys, token, amount } = request;
    const latest = await connection.getLatestBlockhash("confirmed");
    return new Transaction({ feePayer: gate, ...latest }).add(
      this.instructions.openTrader(gate, owner, orderKeys),
      this.depositInstruction(faucet, token, owner, "collateral", amount),
    );
  }

  /**
   * One transaction that opens a seat for `owner` and nothing else, with the
   * gate paying. It carries no signature yet: the owner's and the gate's come later.
   */
  async openTransaction(
    connection: Connection,
    request: Pick<OpenAndFundRequest, "gate" | "owner" | "orderKeys">,
  ): Promise<Transaction> {
    const { gate, owner, orderKeys } = request;
    const latest = await connection.getLatestBlockhash("confirmed");
    return new Transaction({ feePayer: gate, ...latest }).add(
      this.instructions.openTrader(gate, owner, orderKeys),
    );
  }

  /** The unix time, on the rollup's clock, an owner action prepared now expires at. */
  ownerExpiryFrom(rollupClockSeconds: number): number {
    return Number(ownerExpiry(rollupClockSeconds, OWNER_ACTION_LIFETIME_SECONDS));
  }

  /** The text an owner signs to open a seat with these order keys, until `expiresAt`. */
  openMessage(owner: PublicKey, orderKeys: PublicKey[], expiresAt: number): Uint8Array {
    return ownerActionMessage("open", this.programId, owner, orderKeys, BigInt(expiresAt));
  }

  /** How the owner signed `message` (as plain text or in an off-chain envelope, with or without this program's id in its header), or null if `signature` is not theirs. */
  ownerSignatureForm(
    message: Uint8Array,
    signature: Uint8Array,
    owner: PublicKey,
  ): OwnerMessageForm | null {
    return verifyOwnerSignature(message, signature, owner, this.programId);
  }

  /**
   * The whole `open_trader_signed` transaction, signed by the gate alone, which also pays:
   * the owner's proof first and then the open. `lastValidBlockHeight` is the last block at
   * which it can still land, and `signature` its id on the chain, in base58.
   */
  async openSignedTransaction(
    connection: Connection,
    request: {
      gate: Keypair;
      owner: PublicKey;
      orderKeys: PublicKey[];
      expiresAt: number;
      signature: Uint8Array;
      form: OwnerMessageForm;
    },
  ): Promise<{ raw: Buffer; signature: string; lastValidBlockHeight: number }> {
    const { gate, owner, orderKeys, expiresAt, signature, form } = request;
    const blockhash = await connection.getLatestBlockhash("confirmed");
    const built = await openSignedTransaction(
      connection,
      this.instructions,
      gate,
      { owner, orderKeys, expiresAt: BigInt(expiresAt), signature, form },
      blockhash,
    );
    return {
      raw: built.raw,
      signature: base58Of(Buffer.from(built.signature, "base64")),
      lastValidBlockHeight: blockhash.lastValidBlockHeight,
    };
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

  /** The client names every perp market the exchange has in each order, for the margin check. */
  place(marketId: number, order: ChainOrder): Promise<PlaceOutcome> {
    return this.run(async (client): Promise<PlaceOutcome> => {
      const placed = await client.placeOrder(marketId, {
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
      });
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
        const { code } = error;
        const label = code === null ? "program error, unnumbered" : programErrorLabel(code);
        const plain = code === null ? null : programRefusalText(code);
        return {
          status: "failed",
          ...NOTHING_PLACED,
          reason:
            code === MAKER_NOT_LISTED_ERROR
              ? `${label}: the seat is not listed as a maker on this market`
              : plain === null
                ? label
                : `${label}: ${plain}`,
          programError: code ?? undefined,
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

  /**
   * Whether the resting order with sequence number `orderSeq` was cancelled: false when the
   * program no longer had the order (filled, expired or cancelled). Throws when the instruction
   * never ran, since the order may still stand, and when the program refused it for any other reason.
   */
  async cancelOrder(marketId: number, orderSeq: bigint): Promise<boolean> {
    const ended = await this.run(async (client) =>
      (await this.resultOf(client.cancelOrder(marketId, orderSeq))) === null
        ? "never ran"
        : "cancelled",
    ).catch((error: unknown) => {
      if (error instanceof TransactionFailed && error.code === ORDER_NOT_FOUND_ERROR) return "gone";
      throw error;
    });
    if (ended === "never ran")
      throw new Error("the cancel never ran, so the order may still stand");
    return ended === "cancelled";
  }

  /** Brings the view's seat copy up to date. False when the instruction never ran. */
  sync(marketId: number): Promise<boolean> {
    return this.run(async (client) => (await this.resultOf(client.syncView(marketId))) !== null);
  }

  /**
   * Tries the seats of `range` for liquidation in one call, or null when the
   * instruction never ran. Nobody can read another seat, so this is blind: a
   * seat that is empty, healthy or without a position all answer the same.
   * `worstPrice` set to the mark accepts a liquidation in either direction:
   * below the mark from a long, above it from a short. The sweep ends early at
   * a stale price, at a takeover the liquidator's margin cannot carry, or at
   * one its four market slots cannot hold; `nextSeat` is then where it stopped.
   */
  liquidateRange(
    marketId: number,
    range: SeatRange,
    worstPrice: bigint,
  ): Promise<RangeLiquidation | null> {
    return this.run(async (client) => {
      const result = await this.resultOf(
        client.liquidateRange(marketId, {
          start: range.start,
          count: range.count,
          size: LIQUIDATE_UP_TO_LOTS,
          worstPrice,
          maxTakeovers: TAKEOVERS_PER_SWEEP,
        }),
      );
      if (result === null) return null;
      return {
        taken: result.code,
        nextSeat: Number(result.orderSeq),
        stopped: sweepStopOf(result.status),
      };
    }).catch((error: unknown) => {
      if (error instanceof TransactionFailed) return null;
      throw error;
    });
  }
}
