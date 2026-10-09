/**
 * The one module that talks to the order book program and its client package.
 * Everything else in this service sees the plain types exported here, in the
 * program's own units (prices in quote atoms per lot, sizes in lots), so a
 * new client release is an edit to this file and nothing else.
 */
import { createPrivateKey, randomBytes, sign } from "node:crypto";
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import {
  Instructions,
  LIQUIDATION_STATUS,
  MARKET_KIND,
  MarketReader,
  ORDER_TYPE,
  OrderKeyManager,
  RESULT_STATUS,
  SEATS,
  SIDE,
  TraderClient,
  associatedTokenAddress,
  decodeMarket,
  ownFills,
  privateConnection,
  randomSecret,
  sendAndConfirm,
  type TapeFill,
  type View,
} from "@noirwire/orderbook";

export const CLIENT_RELEASE = "@noirwire/orderbook 0.2.0";
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
  baseToken: number;
  quoteToken: number;
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

export type PlaceStatus = "filled" | "rested" | "cancelled" | "refused" | "expired";

export interface PlaceOutcome {
  status: PlaceStatus;
  filled: bigint;
  rested: bigint;
  /** From the send to the result showing in the trader's private view. */
  sendToResultMs: number;
}

export type LiquidationOutcome =
  | "liquidated"
  | "seatNotOpen"
  | "noPosition"
  | "notLiquidatable"
  | "stalePrice"
  | "worstPriceExceeded"
  | "liquidatorMarginInsufficient"
  | "noResult";

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
  [LIQUIDATION_STATUS.targetSeatNotOpen]: "seatNotOpen",
  [LIQUIDATION_STATUS.noPosition]: "noPosition",
  [LIQUIDATION_STATUS.notLiquidatable]: "notLiquidatable",
  [LIQUIDATION_STATUS.stalePrice]: "stalePrice",
  [LIQUIDATION_STATUS.worstPriceExceeded]: "worstPriceExceeded",
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

/** Sends a fully signed transaction and waits until the rollup reports it executed. Throws when it failed. */
export const sendSignedAndConfirm = async (
  connection: Connection,
  transaction: Transaction,
): Promise<string> => {
  const signature = await connection.sendRawTransaction(transaction.serialize(), {
    skipPreflight: true,
  });
  const deadline = Date.now() + CONFIRM_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const { value } = await connection.getSignatureStatus(signature);
    if (value && value.confirmationStatus !== "processed") {
      if (value.err) throw new Error(`the transaction failed: ${JSON.stringify(value.err)}`);
      return signature;
    }
    await new Promise((resolve) => setTimeout(resolve, CONFIRM_POLL_MS));
  }
  throw new Error(`transaction ${signature} was not confirmed in ${CONFIRM_TIMEOUT_MS} ms`);
};

export const newOrderSecret = (): Uint8Array => randomSecret();

export const newOrderKeySeed = (): Uint8Array => new Uint8Array(randomBytes(32));

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

  async market(connection: Connection, marketId: number): Promise<ChainMarket> {
    const account = await connection.getAccountInfo(this.instructions.addresses.market(marketId));
    if (!account) throw new Error(`market ${marketId} is not on this network`);
    const { params } = decodeMarket(account.data);
    return {
      marketId,
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

  async deposit(
    connection: Connection,
    faucet: Keypair,
    mint: string,
    seat: number,
    target: DepositTarget,
    amount: bigint,
  ): Promise<string> {
    return sendAndConfirm(
      connection,
      [this.depositInstruction(faucet.publicKey, mint, seat, target, amount)],
      faucet,
    );
  }

  private depositInstruction(
    faucet: PublicKey,
    mint: string,
    seat: number,
    target: DepositTarget,
    amount: bigint,
  ) {
    const mintKey = new PublicKey(mint);
    return this.instructions.deposit(
      faucet,
      associatedTokenAddress(faucet, mintKey),
      mintKey,
      seat,
      target === "collateral" ? { collateral: true } : { spot: target.spotToken },
      amount,
    );
  }

  /**
   * One transaction that opens a seat for `owner` and credits `seat` from the
   * faucet. It carries no signature yet. The program gives a new trader the
   * lowest free seat, so when `seat` is not that seat the deposit fails and
   * the whole transaction changes nothing.
   */
  async openAndFundTransaction(
    connection: Connection,
    request: {
      gate: PublicKey;
      faucet: PublicKey;
      owner: PublicKey;
      orderKeys: PublicKey[];
      seat: number;
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
        request.seat,
        "collateral",
        request.amount,
      ),
    );
  }

  /**
   * A trader this service holds the owner key of. Its order keys are drawn
   * fresh for this process and written to the view, so nothing about them has
   * to survive a restart.
   */
  async openOwnTrader(
    rpcUrl: string,
    owner: Keypair,
    gate: Keypair,
    gateConnection: Connection,
  ): Promise<ProgramTrader> {
    const connection = await signedInConnection(rpcUrl, owner);
    const keys = OrderKeyManager.fresh(newOrderKeySeed());
    const view = this.instructions.addresses.view(owner.publicKey);
    if (await connection.getAccountInfo(view)) {
      await sendAndConfirm(
        connection,
        [this.instructions.setOrderKeys(owner.publicKey, keys.publicKeys)],
        owner,
      );
    } else {
      await sendAndConfirm(
        gateConnection,
        [this.instructions.openTrader(gate.publicKey, owner.publicKey, keys.publicKeys)],
        gate,
        [owner],
      );
    }
    return new ProgramTrader(rpcUrl, owner, keys, this.programId, connection);
  }

  /** A trader whose seat already exists, with the four order keys its view was opened with. */
  async existingTrader(
    rpcUrl: string,
    owner: Keypair,
    orderKeySeed: Uint8Array,
  ): Promise<ProgramTrader> {
    const connection = await signedInConnection(rpcUrl, owner);
    return new ProgramTrader(
      rpcUrl,
      owner,
      OrderKeyManager.fresh(orderKeySeed),
      this.programId,
      connection,
    );
  }
}

/** The four public order keys a new trader's view is opened with. */
export const firstOrderKeys = (orderKeySeed: Uint8Array): PublicKey[] =>
  OrderKeyManager.fresh(orderKeySeed).publicKeys;

/** One trader: signs in as its owner, trades with one-time order keys, reads its own view. */
export class ProgramTrader {
  private client: TraderClient;
  private signInAgain = false;
  private queue: Promise<unknown> = Promise.resolve();

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

  /** One instruction at a time per trader; a failure signs in again before the next. */
  private run<T>(operation: (client: TraderClient) => Promise<T>): Promise<T> {
    const next = this.queue.then(async () => {
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
        this.signInAgain = true;
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
    return this.run(async (client) => {
      const sentAt = performance.now();
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
      const sendToResultMs = performance.now() - sentAt;
      if (placed.outcome === "expired") {
        return { status: "expired", filled: 0n, rested: 0n, sendToResultMs };
      }
      const { status, filled, rested } = placed.result;
      return { status: placeStatusOf(status, rested), filled, rested, sendToResultMs };
    });
  }

  /** Resolves to how many orders were cancelled, or null when no result showed before the expiry. */
  cancelAll(marketId: number): Promise<bigint | null> {
    return this.run(async (client) => (await client.cancelAll(marketId))?.cancelled ?? null);
  }

  /** Brings the view's seat copy up to date. False when no result showed before the expiry. */
  sync(marketId: number): Promise<boolean> {
    return this.run(async (client) => (await client.syncView(marketId)) !== null);
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
      const result = await client.liquidate(
        marketId,
        seat,
        LIQUIDATE_UP_TO_LOTS,
        worstPrice,
        riskMarkets,
      );
      if (!result) return "noResult";
      return LIQUIDATION_OUTCOME[result.status] ?? "noResult";
    });
  }
}
