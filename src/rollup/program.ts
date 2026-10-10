/**
 * The one module that talks to the order book program and its client package.
 * Everything else in this service sees the plain types exported here, in the
 * program's own units (prices in quote atoms per lot, sizes in lots), so a
 * new client release is an edit to this file and nothing else.
 */
import { createHash, createPrivateKey, sign } from "node:crypto";
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import {
  Instructions,
  LIQUIDATION_STATUS,
  MARKET_KIND,
  MarketReader,
  ORDER_TYPE,
  OrderInvalid,
  OutcomeUnknown,
  OrderKeyManager,
  RESULT_STATUS,
  SEATS,
  SIDE,
  TraderClient,
  TransactionFailed,
  associatedTokenAddress,
  decodeMarket,
  decodeView,
  ownFills,
  privateConnection,
  randomSecret,
  sendAndConfirm,
  type OrderKeyCheckpoint,
  type OrderResult,
  type TapeFill,
  type View,
} from "@noirwire/orderbook";

export const CLIENT_RELEASE = "@noirwire/orderbook 0.4.0";
/** The program's error number for "the exchange has opened its daily limit of new seats". */
export const DAILY_SEAT_LIMIT_ERROR = 6137;
const ORDER_KEY_SEARCH_WINDOW = 4_096;

/** Where a trader's four live order keys sit in their derivation. It holds no secret. */
export type KeyCheckpoint = OrderKeyCheckpoint;
export const FIRST_TRADER_SEAT = 2;
export const SEAT_COUNT = SEATS;

const CLOCK_SYSVAR = new PublicKey("SysvarC1ock11111111111111111111111111111111");
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const LIQUIDATE_UP_TO_LOTS = 1_000_000_000n;

export type ChainSide = "buy" | "sell";
export type ChainOrderType = "limit" | "postOnly" | "ioc" | "market";

export interface ChainMarket {
  marketId: number;
  kind: "perp" | "spot";
  tick: bigint;
  baseLot: bigint;
  minSize: bigint;
  minNotional: bigint;
  bandBps: number;
  imBps: number;
  maxMoveBps: number;
  minPublishGapSeconds: number;
  maxPriceAgeSeconds: number;
  fundingIntervalSeconds: number;
  baseToken: number;
  quoteToken: number;
}

export interface PublicAddresses {
  exchange: string;
  stats: string;
  market: string;
  tape: string;
  priceFeed: string;
}

export interface ChainPrice {
  price: bigint;
  publishTimeSeconds: number;
}

export interface ChainFill {
  sequence: bigint;
  price: bigint;
  size: bigint;
  timeSeconds: number;
  takerSide: ChainSide;
  makerReceipt: Uint8Array;
  takerReceipt: Uint8Array;
}

export interface ChainTape {
  lastSequence: bigint;
  /** Newest first, as the tape account holds them. */
  fills: ChainFill[];
}

export interface ChainStats {
  orders: bigint;
  fills: bigint;
  volume: bigint[];
  openInterest: bigint[];
}

export interface ChainOrder {
  side: ChainSide;
  type: ChainOrderType;
  price: bigint;
  size: bigint;
  reduceOnly: boolean;
  secret: Uint8Array;
  /** Unix seconds after which a resting remainder is void; none when absent. */
  restingExpirySeconds?: number;
}

/**
 * `invalid`: refused before signing, by the market's public settings.
 * `failed`: the transaction landed and the program refused it; nothing changed.
 * `expired`: no result showed before the order's expiry.
 */
export type PlaceStatus =
  "filled" | "rested" | "cancelled" | "refused" | "expired" | "invalid" | "failed" | "unknown";

export interface PlaceOutcome {
  status: PlaceStatus;
  filled: bigint;
  rested: bigint;
  /** From the send to the result showing in the trader's private view, as the client timed it. */
  sendToResultMs: number;
  reason?: string;
  /**
   * Only with `unknown`: the client stopped waiting while the order could
   * still run. Resolves, once the rollup's clock is past the order's expiry
   * at the latest, to what became of it: executed after all, or `expired`.
   * The trader sends nothing else until then.
   */
  settled?: Promise<PlaceOutcome>;
}

/**
 * `nothing` covers a seat that is not open, has no position, is healthy, or is past the worst price.
 * `refused`: the program refused the liquidator itself, as when the seat is its own.
 */
export type LiquidationOutcome =
  "liquidated" | "nothing" | "stalePrice" | "liquidatorMarginInsufficient" | "refused" | "noResult";

export interface SeatView {
  seat: number;
  collateral: bigint;
  spot: { available: bigint; locked: bigint }[];
  perp: { base: bigint; quote: bigint }[];
  ordersMarketId: number;
  orders: { side: ChainSide; price: bigint; remaining: bigint; sequence: bigint }[];
}

export type DepositTarget = "collateral" | { spotToken: number };

export type Unsubscribe = () => Promise<void>;

const sideOf = (code: number): ChainSide => (code === SIDE.bid ? "buy" : "sell");

const ORDER_TYPE_CODE: Record<ChainOrderType, number> = {
  limit: ORDER_TYPE.limit,
  postOnly: ORDER_TYPE.postOnly,
  ioc: ORDER_TYPE.immediateOrCancel,
  market: ORDER_TYPE.market,
};

const LIQUIDATION_OUTCOME: Record<number, LiquidationOutcome> = {
  [LIQUIDATION_STATUS.liquidated]: "liquidated",
  [LIQUIDATION_STATUS.nothingToLiquidate]: "nothing",
  [LIQUIDATION_STATUS.stalePrice]: "stalePrice",
  [LIQUIDATION_STATUS.liquidatorMarginInsufficient]: "liquidatorMarginInsufficient",
};

const placeStatusOf = (status: number, rested: bigint): PlaceStatus => {
  if (status === RESULT_STATUS.filled) return "filled";
  if (status === RESULT_STATUS.rested || rested > 0n) return "rested";
  if (status === RESULT_STATUS.refusedPostOnlyWouldMatch) return "refused";
  return "cancelled";
};

const toChainFill = (fill: TapeFill): ChainFill => ({
  sequence: fill.fillSeq,
  price: fill.price,
  size: fill.size,
  timeSeconds: Number(fill.time),
  takerSide: sideOf(fill.takerSide),
  makerReceipt: fill.makerReceipt,
  takerReceipt: fill.takerReceipt,
});

const toSeatView = (view: View): SeatView => ({
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

/** A connection for public accounts only: the tape, the price feeds, the stats, the markets. */
export const publicConnection = (rpcUrl: string, wsUrl: string): Connection =>
  new Connection(rpcUrl, { commitment: "confirmed", wsEndpoint: wsUrl });

/** The rollup's own port, which takes any transaction without a sign-in. Reachable on a local network only. */
export const directConnection = (rpcUrl: string): Connection => new Connection(rpcUrl, "confirmed");

/** Signs `key` in to the private endpoint. The query filter accepts sends only from a signed-in caller. */
export const signedInConnection = (rpcUrl: string, key: Keypair): Promise<Connection> =>
  privateConnection(rpcUrl, key.publicKey, signerOf(key));

const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";

/** This service moves test tokens only. It stops before sending anything if Solana is mainnet. */
export const refuseMainnet = async (solanaRpcUrl: string): Promise<void> => {
  const genesis = await new Connection(solanaRpcUrl, "confirmed").getGenesisHash();
  if (genesis === MAINNET_GENESIS) {
    throw new Error("SOLANA_RPC_URL is mainnet. This service never runs there.");
  }
};

const CONFIRM_TIMEOUT_MS = 30_000;
const CONFIRM_POLL_MS = 100;

/** The endpoint did not take a transaction that moves tokens: the HTTP status and body it answered with. */
export class DepositRefused extends Error {
  constructor(endpoint: string, cause: unknown) {
    const answer = cause instanceof Error ? cause.message.split("\n")[0] : String(cause);
    super(`${new URL(endpoint).origin} refused the deposit transaction: ${answer}`);
    this.name = "DepositRefused";
  }
}

/** The transaction executed and the program refused it, with the program's error number when it gave one. */
export class ProgramRefused extends Error {
  readonly code: number | null;

  constructor(err: unknown) {
    super(`the transaction failed: ${JSON.stringify(err)}`);
    this.name = "ProgramRefused";
    const detail = (err as { InstructionError?: [number, { Custom?: number }] })
      ?.InstructionError?.[1];
    this.code = typeof detail?.Custom === "number" ? detail.Custom : null;
  }
}

/**
 * Sends a fully signed transaction that carries a deposit and waits until the
 * rollup reports it executed. A refusal at the door is a `DepositRefused`, a
 * refusal by the program a `ProgramRefused`.
 */
export const sendDepositAndConfirm = async (
  connection: Connection,
  transaction: Transaction,
): Promise<string> => {
  const signature = await connection
    .sendRawTransaction(transaction.serialize(), { skipPreflight: true })
    .catch((error: unknown) => {
      throw new DepositRefused(connection.rpcEndpoint, error);
    });
  const deadline = Date.now() + CONFIRM_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const { value } = await connection.getSignatureStatus(signature);
    if (value && value.confirmationStatus !== "processed") {
      if (value.err) throw new ProgramRefused(value.err);
      return signature;
    }
    await new Promise((resolve) => setTimeout(resolve, CONFIRM_POLL_MS));
  }
  throw new Error(`transaction ${signature} was not confirmed in ${CONFIRM_TIMEOUT_MS} ms`);
};

export const newOrderSecret = (): Uint8Array => randomSecret();

/** A trader's order keys all follow from this seed, which follows from its owner key alone. */
export const orderKeySeedOf = (owner: Keypair): Uint8Array =>
  new Uint8Array(
    createHash("sha256")
      .update("noirwire-sim/order-key-seed/v1")
      .update(owner.secretKey.subarray(0, 32))
      .digest(),
  );

/** Which side of `fill`, if any, was an order placed with one of `secrets`. */
export const fillRoles = (
  fill: ChainFill,
  secrets: Uint8Array[],
): { maker: boolean; taker: boolean } => {
  const asTapeFill: TapeFill = {
    fillSeq: fill.sequence,
    price: fill.price,
    size: fill.size,
    time: BigInt(fill.timeSeconds),
    makerReceipt: fill.makerReceipt,
    takerReceipt: fill.takerReceipt,
    takerSide: fill.takerSide === "buy" ? SIDE.bid : SIDE.ask,
  };
  const own = ownFills([asTapeFill], secrets);
  return {
    maker: own.some((entry) => entry.role === "maker"),
    taker: own.some((entry) => entry.role === "taker"),
  };
};

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

  async clockSeconds(connection: Connection): Promise<number> {
    const clock = await connection.getAccountInfo(CLOCK_SYSVAR);
    if (!clock) throw new Error("the rollup serves no clock");
    return Number(new DataView(clock.data.buffer, clock.data.byteOffset).getBigInt64(32, true));
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
      minSize: params.minSize,
      minNotional: params.minNotional,
      bandBps: params.bandBps,
      imBps: params.imBps,
      maxMoveBps: params.maxMoveBps,
      minPublishGapSeconds: params.minPublishGap,
      maxPriceAgeSeconds: Number(params.maxPriceAge),
      fundingIntervalSeconds: Number(params.fundingInterval),
      baseToken: params.baseToken,
      quoteToken: params.quoteToken,
    };
  }

  async price(connection: Connection, marketId: number): Promise<ChainPrice> {
    const feed = await this.reader(connection).priceFeed(marketId);
    return { price: feed.price, publishTimeSeconds: Number(feed.publishTime) };
  }

  async tape(connection: Connection, marketId: number): Promise<ChainTape> {
    const tape = await this.reader(connection).tape(marketId);
    return { lastSequence: tape.lastFillSeq, fills: tape.fills.map(toChainFill) };
  }

  async stats(connection: Connection): Promise<ChainStats> {
    const { orders, fills, volume, openInterest } = await this.reader(connection).stats();
    return { orders, fills, volume, openInterest };
  }

  subscribeTape(
    connection: Connection,
    marketId: number,
    onChange: (tape: ChainTape) => void,
  ): Unsubscribe {
    return this.reader(connection).subscribeTape(marketId, (tape) =>
      onChange({ lastSequence: tape.lastFillSeq, fills: tape.fills.map(toChainFill) }),
    );
  }

  subscribePrice(
    connection: Connection,
    marketId: number,
    onChange: (price: ChainPrice) => void,
  ): Unsubscribe {
    return this.reader(connection).subscribePriceFeed(marketId, (feed) =>
      onChange({ price: feed.price, publishTimeSeconds: Number(feed.publishTime) }),
    );
  }

  subscribeStats(connection: Connection, onChange: (stats: ChainStats) => void): Unsubscribe {
    return this.reader(connection).subscribeStats(({ orders, fills, volume, openInterest }) =>
      onChange({ orders, fills, volume, openInterest }),
    );
  }

  /** The publish time is the rollup's own clock: the program refuses one ahead of it. */
  async publishPrice(
    connection: Connection,
    oracle: Keypair,
    marketId: number,
    price: bigint,
  ): Promise<void> {
    const publishTime = BigInt(await this.clockSeconds(connection));
    await sendAndConfirm(
      connection,
      [this.instructions.publishPrice(oracle.publicKey, marketId, price, publishTime)],
      oracle,
    );
  }

  async updateFunding(connection: Connection, payer: Keypair, marketId: number): Promise<void> {
    await sendAndConfirm(connection, [this.instructions.updateFunding(marketId)], payer);
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
    request: {
      gate: PublicKey;
      faucet: PublicKey;
      owner: PublicKey;
      orderKeys: PublicKey[];
      mint: string;
      amount: bigint;
    },
  ): Promise<Transaction> {
    const latest = await connection.getLatestBlockhash("confirmed");
    return new Transaction({ feePayer: request.gate, ...latest }).add(
      this.instructions.openTrader(request.gate, request.owner, request.orderKeys),
      this.depositInstruction(
        request.faucet,
        request.mint,
        request.owner,
        "collateral",
        request.amount,
      ),
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
    let keys: OrderKeyManager | null = null;
    if (checkpoint) {
      try {
        const view = decodeView(account.data);
        keys = OrderKeyManager.restore(seed, view, checkpoint, ORDER_KEY_SEARCH_WINDOW);
      } catch {
        keys = null;
      }
    }
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
    const keys = OrderKeyManager.fresh(orderKeySeedOf(owner));
    await sendAndConfirm(
      gateConnection,
      [this.instructions.openTrader(gate.publicKey, owner.publicKey, keys.publicKeys)],
      gate,
      [owner],
    );
    const connection = await signedInConnection(rpcUrl, owner);
    return new ProgramTrader(rpcUrl, owner, keys, this.programId, connection);
  }

  /** A trader just opened with `firstOrderKeys(owner)`, before it sent anything. */
  async newTrader(rpcUrl: string, owner: Keypair): Promise<ProgramTrader> {
    const connection = await signedInConnection(rpcUrl, owner);
    const keys = OrderKeyManager.fresh(orderKeySeedOf(owner));
    return new ProgramTrader(rpcUrl, owner, keys, this.programId, connection);
  }
}

/** The four public order keys a new trader's view is opened with. */
export const firstOrderKeys = (owner: Keypair): PublicKey[] =>
  OrderKeyManager.fresh(orderKeySeedOf(owner)).publicKeys;

/** One trader: signs in as its owner, trades with one-time order keys, reads its own view. */
export class ProgramTrader {
  private client: TraderClient;
  private signInAgain = false;
  private queue: Promise<unknown> = Promise.resolve();
  private unsettled: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly rpcUrl: string,
    private readonly owner: Keypair,
    private readonly keys: OrderKeyManager,
    private readonly programId: PublicKey,
    connection: Connection,
  ) {
    this.client = new TraderClient(connection, connection, owner.publicKey, keys, programId);
  }

  get address(): string {
    return this.owner.publicKey.toBase58();
  }

  get checkpoint(): KeyCheckpoint {
    return this.keys.checkpoint;
  }

  /**
   * A call whose outcome the client could not tell in time. The instruction
   * may still run until the rollup's clock passes its expiry, so nothing else
   * of this trader is sent until `settled` says what became of it.
   */
  private async afterUnknown<T>(unknown: OutcomeUnknown): Promise<T | null> {
    if (unknown.cause !== undefined) this.signInAgain = true;
    return (await unknown.settled) as T | null;
  }

  /**
   * One instruction at a time per trader, and none while an earlier one's
   * outcome is still unknown; a failure on the wire signs in again before the next.
   */
  private run<T>(operation: (client: TraderClient) => Promise<T>): Promise<T> {
    const next = this.queue.then(async () => {
      await this.unsettled;
      if (this.signInAgain) {
        const connection = await signedInConnection(this.rpcUrl, this.owner);
        this.client = new TraderClient(
          connection,
          connection,
          this.owner.publicKey,
          this.keys,
          this.programId,
        );
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
    });
    this.queue = next.catch(() => undefined);
    return next;
  }

  view(): Promise<SeatView> {
    return this.run(async (client) => toSeatView(await client.view()));
  }

  place(
    marketId: number,
    order: ChainOrder,
    riskMarkets: number[],
    expirySeconds?: number,
  ): Promise<PlaceOutcome> {
    const nothing = { filled: 0n, rested: 0n, sendToResultMs: 0 };
    const placedAs = (result: OrderResult, timing: { sentAt: number; resultAt: number }) => ({
      status: placeStatusOf(result.status, result.rested),
      filled: result.filled,
      rested: result.rested,
      sendToResultMs: timing.resultAt - timing.sentAt,
    });
    const unknownUntil = (settled: Promise<PlaceOutcome>): PlaceOutcome => {
      this.unsettled = settled.catch(() => undefined);
      return { status: "unknown", ...nothing, settled };
    };
    return this.run(async (client): Promise<PlaceOutcome> => {
      const placed = await client.placeOrder(
        marketId,
        {
          side: order.side === "buy" ? SIDE.bid : SIDE.ask,
          orderType: ORDER_TYPE_CODE[order.type],
          price: order.price,
          size: order.size,
          reduceOnly: order.reduceOnly,
          secret: order.secret,
          expiry:
            order.restingExpirySeconds === undefined ? 0n : BigInt(order.restingExpirySeconds),
        },
        { riskMarkets, expirySeconds },
      );
      if (placed.outcome === "expired") return { status: "expired", ...nothing };
      if (placed.outcome === "placed") return placedAs(placed.result, placed);
      return unknownUntil(
        placed.settled.then((settled) =>
          settled.outcome === "placed"
            ? placedAs(settled.result, settled)
            : { status: "expired", ...nothing },
        ),
      );
    }).catch((error: unknown): PlaceOutcome => {
      if (error instanceof OutcomeUnknown) {
        if (error.cause !== undefined) this.signInAgain = true;
        return unknownUntil(
          error.settled.then((result) =>
            result ? placedAs(result, result) : { status: "expired", ...nothing },
          ),
        );
      }
      if (error instanceof OrderInvalid) {
        return { status: "invalid", ...nothing, reason: error.reason };
      }
      if (error instanceof TransactionFailed) {
        return { status: "failed", ...nothing, reason: `program error ${error.code ?? "unknown"}` };
      }
      throw error;
    });
  }

  /**
   * Resolves to how many orders were cancelled, or null when the instruction
   * never ran. Throws when the program refused the transaction.
   */
  cancelAll(marketId: number): Promise<bigint | null> {
    return this.run(async (client) => {
      const result = await client.cancelAll(marketId).catch((error: unknown) => {
        if (error instanceof OutcomeUnknown) return this.afterUnknown<OrderResult>(error);
        throw error;
      });
      return result?.cancelled ?? null;
    });
  }

  /** Brings the view's seat copy up to date. False when the instruction never ran. */
  sync(marketId: number): Promise<boolean> {
    return this.run(async (client) => {
      const result = await client.syncView(marketId).catch((error: unknown) => {
        if (error instanceof OutcomeUnknown) return this.afterUnknown<OrderResult>(error);
        throw error;
      });
      return result !== null;
    });
  }

  /**
   * Tried blind against a seat number. `worstPrice` set to the mark accepts a
   * liquidation in either direction: below the mark from a long, above it
   * from a short.
   */
  liquidate(
    marketId: number,
    seat: number,
    worstPrice: bigint,
    riskMarkets: number[],
  ): Promise<LiquidationOutcome> {
    return this.run(async (client) => {
      const result = await client
        .liquidate(marketId, seat, LIQUIDATE_UP_TO_LOTS, worstPrice, riskMarkets)
        .catch((error: unknown) => {
          if (error instanceof OutcomeUnknown) return this.afterUnknown<OrderResult>(error);
          throw error;
        });
      if (!result) return "noResult" as const;
      return LIQUIDATION_OUTCOME[result.status] ?? ("noResult" as const);
    }).catch((error: unknown): LiquidationOutcome => {
      if (error instanceof TransactionFailed) return "refused";
      throw error;
    });
  }
}
