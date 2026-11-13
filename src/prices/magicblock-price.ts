import { type AccountInfo, PublicKey } from "@solana/web3.js";
import { bpsApart } from "../bots/maker-safety.js";
import { MAKER_LIMITS } from "../bots/maker-limits.js";
import type { Clock } from "../engine/clock.js";
import { SCALE } from "../engine/money.js";
import { connectionTo, hangUp } from "../rollup/connections.js";
import { type Repeating, every } from "../scheduling/repeating.js";
import {
  type PriceReading,
  type Reference,
  type ReferenceReader,
  type ReferenceSource,
  SourceRefused,
  Throttle,
} from "./reference-price.js";

/** MagicBlock's price oracle program: the owner of every price account inside the rollup. */
export const MAGICBLOCK_ORACLE_ID = "PriCems5tHihc6UDXDjzjeawomAwBduWMGAi8ZUjppd";
/** The oracle's feed number of SOL/USD, written in decimal as the last seed of its account's address. */
export const SOL_USD_FEED_NUMBER = 6;

const MS_PER_SECOND = 1_000;
/** The first eight bytes of SHA-256 of `account:PriceUpdateV3`. */
const DISCRIMINATOR = [234, 161, 14, 36, 172, 239, 15, 232];
const ACCOUNT_LEN = 134;
const VERIFICATION_AT = 40;
const FULL = 1;
const FEED_ID_AT = 41;
const PRICE_AT = 73;
const EXPONENT_AT = 89;
const PUBLISH_TIME_AT = 93;
/** The exponent field holds the number of decimals, positive: 8 for 10^-8. */
const STORED_DECIMALS = 8;

/** The address of the oracle's price account for feed number `feed`. It lives inside the rollup only. */
export const magicblockPriceAddress = (feed: number): PublicKey =>
  PublicKey.findProgramAddressSync(
    [Buffer.from("price_feed"), Buffer.from("pyth-lazer"), Buffer.from(String(feed))],
    new PublicKey(MAGICBLOCK_ORACLE_ID),
  )[0];

export interface PriceAccount {
  data: Uint8Array;
  /** The program that owns the account, as base58. */
  owner: string;
}

/**
 * The price in a MagicBlock price account, or the reason it is not to be believed. The account is a
 * `PriceUpdateV3`, laid out like Pyth's update and read byte by byte, little endian, in the way the
 * order book program reads it: the owner must be the oracle program, the size 134 bytes, the
 * discriminator and the verification level (Full) the expected ones, the feed id the account's own
 * address, the exponent +8, and the price above zero. The confidence is always zero and is not read.
 */
export const readMagicblockAccount = (account: PriceAccount, address: PublicKey): PriceReading => {
  const refused = (why: string): SourceRefused =>
    new SourceRefused(`the MagicBlock price account ${why}`);
  const { data } = account;
  if (account.owner !== MAGICBLOCK_ORACLE_ID) throw refused("is not owned by the oracle program");
  if (data.length !== ACCOUNT_LEN) throw refused(`is ${data.length} bytes, not ${ACCOUNT_LEN}`);
  if (DISCRIMINATOR.some((byte, at) => data[at] !== byte)) throw refused("is not a price update");
  if (data[VERIFICATION_AT] !== FULL) throw refused("is not fully verified");
  if (!Buffer.from(data.subarray(FEED_ID_AT, FEED_ID_AT + 32)).equals(address.toBuffer())) {
    throw refused("is not the SOL/USD feed");
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (view.getInt32(EXPONENT_AT, true) !== STORED_DECIMALS) {
    throw refused("has an exponent other than 8 decimals");
  }
  const price = (view.getBigInt64(PRICE_AT, true) * SCALE) / 10n ** BigInt(STORED_DECIMALS);
  if (price <= 0n) throw refused("holds a price that is not above zero");
  return {
    source: "MagicBlock",
    exchange: false,
    price,
    atMs: Number(view.getBigInt64(PUBLISH_TIME_AT, true)) * MS_PER_SECOND,
  };
};

/** One account on the rollup, as the websocket and a plain read see it. */
export interface PriceAccountLink {
  read(): Promise<PriceAccount | null>;
  onChange(listener: (account: PriceAccount) => void): void;
  close(): void;
}

/** The price account on the rollup at `rpcUrl`, followed over its websocket at `wsUrl`. */
export const rollupPriceLink = (
  rpcUrl: string,
  wsUrl: string,
  address: PublicKey,
): PriceAccountLink => {
  const connection = connectionTo(rpcUrl, wsUrl);
  const accountOf = ({ data, owner }: AccountInfo<Buffer>): PriceAccount => ({
    data,
    owner: owner.toBase58(),
  });
  return {
    read: async () => {
      const info = await connection.getAccountInfo(address);
      return info && accountOf(info);
    },
    onChange: (listener) => {
      connection.onAccountChange(address, (info) => listener(accountOf(info)));
    },
    close: () => hangUp(connection),
  };
};

/**
 * The oracle publishes about ten times a second, so a socket that has said nothing for this long
 * has dropped (or the oracle has stopped, which a read tells just as well).
 */
const SILENT_AFTER_MS = 1_000;
const POLL_EVERY_MS = 500;

/**
 * The newest price in the oracle's account, kept current by the websocket's notifications. While
 * the socket is silent the account is read by hand every `POLL_EVERY_MS` instead, until the
 * socket speaks again. An update that is refused (wrong owner, size, feed, exponent, a price of
 * zero) clears the price: nothing older is trusted over it.
 */
export class MagicblockPrice {
  private reading: PriceReading | null = null;
  private refusal = "no MagicBlock price has arrived yet";
  private lastPushAtMs = -Infinity;
  private pushes = 0;

  constructor(
    private readonly address: PublicKey,
    private readonly connect: () => PriceAccountLink,
    private readonly clock: Clock,
  ) {}

  /** The newest good price, or a refusal saying why there is none. */
  latest(): PriceReading {
    if (!this.reading) throw new SourceRefused(this.refusal);
    return this.reading;
  }

  /** Opens the socket and watches it, until the returned loop is stopped. */
  follow(): Repeating {
    const link = this.connect();
    link.onChange((account) => {
      this.lastPushAtMs = this.clock.nowMs();
      this.pushes += 1;
      this.accept(account);
    });
    const poll = every(
      POLL_EVERY_MS,
      () => this.pollIfSilent(link),
      () => {},
      () => {},
      { pauseAfterFailure: false },
    );
    return {
      stop: () => {
        poll.stop();
        link.close();
      },
      idle: poll.idle,
    };
  }

  private async pollIfSilent(link: PriceAccountLink): Promise<void> {
    if (this.clock.nowMs() - this.lastPushAtMs <= SILENT_AFTER_MS) return;
    const pushesBefore = this.pushes;
    const account = await link.read();
    if (this.pushes !== pushesBefore) return;
    if (account) this.accept(account);
    else this.refuse("the MagicBlock price account does not exist");
  }

  private accept(account: PriceAccount): void {
    try {
      const reading = readMagicblockAccount(account, this.address);
      if (this.reading && reading.atMs < this.reading.atMs) return;
      this.reading = reading;
    } catch (error) {
      if (!(error instanceof SourceRefused)) throw error;
      this.refuse(error.message);
    }
  }

  private refuse(why: string): void {
    this.reading = null;
    this.refusal = why;
  }
}

export interface MagicblockLimits {
  /** The oldest MagicBlock price the maker quotes from. */
  maxAgeMs: number;
  /** The most the MagicBlock and a fresh Pyth price may differ by. */
  maxPythBps: number;
}

/**
 * The reference price when the rollup's own oracle is the source: its newest price, or the reason
 * there is none. There is none when no good price is held, when it is more than `maxAgeMs` old
 * (or dated that far ahead), or when a Pyth price no older than the exchanges may be is more
 * than `maxPythBps` away from it. A Pyth price that is older than that, or cannot be read, checks
 * nothing and pulls nothing: Pyth's feed pushes about once a minute, so it is a sanity check
 * and never the clock the quotes keep.
 */
export class MagicblockReference implements ReferenceReader {
  private readonly throttle: Throttle;

  constructor(
    private readonly feed: Pick<MagicblockPrice, "latest">,
    private readonly pyth: ReferenceSource,
    private readonly clock: Clock,
    private readonly limits: MagicblockLimits,
    monotonicMs?: () => number,
  ) {
    this.throttle = new Throttle(monotonicMs);
  }

  async read(): Promise<Reference> {
    let price: PriceReading;
    try {
      price = this.feed.latest();
    } catch (error) {
      if (error instanceof SourceRefused) return { ok: false, reason: error.message };
      throw error;
    }
    const now = this.clock.nowMs();
    const ageMs = Math.abs(now - price.atMs);
    if (ageMs > this.limits.maxAgeMs) {
      const seconds = Math.round((now - price.atMs) / MS_PER_SECOND);
      return { ok: false, reason: `the MagicBlock price is ${seconds} s old` };
    }
    const pyth = await this.throttle.read(this.pyth).catch(() => null);
    if (pyth && Math.abs(now - pyth.atMs) <= MAKER_LIMITS.maxSourceAgeMs) {
      const apart = bpsApart(price.price, pyth.price);
      if (apart > this.limits.maxPythBps) {
        return {
          ok: false,
          reason: `the MagicBlock and Pyth prices are ${apart.toFixed(1)} bps apart, past the ${this.limits.maxPythBps} bps allowed`,
        };
      }
    }
    return { ok: true, price: price.price };
  }
}
