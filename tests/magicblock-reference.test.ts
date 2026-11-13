import { PublicKey } from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ManualClock } from "../src/engine/clock.js";
import {
  MAGICBLOCK_ORACLE_ID,
  MagicblockPrice,
  MagicblockReference,
  type PriceAccount,
  type PriceAccountLink,
  SOL_USD_FEED_NUMBER,
  magicblockPriceAddress,
  readMagicblockAccount,
} from "../src/prices/magicblock-price.js";
import type { PriceReading, ReferenceSource } from "../src/prices/reference-price.js";
import { dollars } from "./helpers.js";

/** The mainnet SOL/USD account as the rollup served it: price 80.02901727, published at second 1_794_592_456. */
const SOL = Uint8Array.from([
  234, 161, 14, 36, 172, 239, 15, 232, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 198, 173, 62, 132, 29, 156, 15, 36, 138, 223, 249, 12, 247,
  118, 248, 57, 253, 89, 241, 203, 216, 255, 188, 143, 148, 2, 136, 62, 161, 110, 132, 32, 223, 150,
  2, 221, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 8, 0, 0, 0, 200, 78, 247, 106, 0, 0, 0, 0, 200, 78,
  247, 106, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 85, 42, 17, 26, 0, 0, 0, 0,
  0,
]);
const SOL_ADDRESS = "ENYwebBThHzmzwPLAQvCucUTsjyfBSZdD9ViXksS4jPu";
const USDC_ADDRESS = "Ekug3x6hs37Mf4XKCDptvRVCSCjJCAD7LKmKQXBAa541";
const PUBLISHED_AT_MS = 1_794_592_456_000;
const address = new PublicKey(SOL_ADDRESS);

const goodAccount = (change: (bytes: Uint8Array) => void = () => {}): PriceAccount => {
  const data = Uint8Array.from(SOL);
  change(data);
  return { data, owner: MAGICBLOCK_ORACLE_ID };
};
const view = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
/** An account as the oracle would publish it: `price` at `seconds`. */
const published = (price: bigint, seconds: number): PriceAccount =>
  goodAccount((bytes) => {
    view(bytes).setBigInt64(73, price, true);
    view(bytes).setBigInt64(93, BigInt(seconds), true);
  });

describe("the MagicBlock price account", () => {
  it("derives the oracle's addresses for SOL/USD and USDC/USD", () => {
    expect(SOL_USD_FEED_NUMBER).toBe(6);
    expect(magicblockPriceAddress(6).toBase58()).toBe(SOL_ADDRESS);
    expect(magicblockPriceAddress(7).toBase58()).toBe(USDC_ADDRESS);
  });

  it("reads the account the rollup served as a price of 80.029017 dollars dated by its publish time", () => {
    expect(SOL).toHaveLength(134);
    expect(readMagicblockAccount(goodAccount(), address)).toEqual({
      source: "MagicBlock",
      exchange: false,
      price: dollars(80.029017),
      atMs: PUBLISHED_AT_MS,
    });
  });

  it("does not read the write authority, the confidence or the bytes after the publish time", () => {
    const other = goodAccount((bytes) => {
      bytes.fill(7, 8, 40);
      bytes.fill(255, 81, 89);
      bytes.fill(9, 101, 134);
    });
    expect(readMagicblockAccount(other, address)).toEqual(
      readMagicblockAccount(goodAccount(), address),
    );
  });

  const refused = (account: PriceAccount, address_ = address) =>
    expect(() => readMagicblockAccount(account, address_));

  it("refuses an account another program owns, Pyth's receiver included", () => {
    refused({ ...goodAccount(), owner: PublicKey.default.toBase58() }).toThrow(
      "not owned by the oracle",
    );
    refused({ ...goodAccount(), owner: "rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ" }).toThrow(
      "not owned by the oracle",
    );
  });

  it("refuses an account of any other size", () => {
    refused({ ...goodAccount(), data: SOL.subarray(0, 133) }).toThrow("133 bytes, not 134");
    refused({ ...goodAccount(), data: new Uint8Array([...SOL, 0]) }).toThrow("135 bytes");
    refused({ ...goodAccount(), data: new Uint8Array(0) }).toThrow("0 bytes");
  });

  it("refuses another discriminator", () => {
    refused(goodAccount((bytes) => (bytes[0] ^= 1))).toThrow("not a price update");
    refused(goodAccount((bytes) => bytes.set([34, 241, 35, 99, 157, 126, 244, 205]))).toThrow(
      "not a price update",
    );
  });

  it("refuses an update that is not fully verified", () => {
    for (const level of [0, 2, 255]) {
      refused(goodAccount((bytes) => (bytes[40] = level))).toThrow("not fully verified");
    }
  });

  it("refuses a feed id that is not the account's own address", () => {
    refused(goodAccount((bytes) => (bytes[41] ^= 1))).toThrow("not the SOL/USD feed");
    refused(goodAccount(), new PublicKey(USDC_ADDRESS)).toThrow("not the SOL/USD feed");
  });

  it("refuses every exponent but 8 decimals, stored positive", () => {
    for (const stored of [-8, 0, 7, 9, 2 ** 31 - 1]) {
      refused(goodAccount((bytes) => view(bytes).setInt32(89, stored, true))).toThrow("exponent");
    }
  });

  it("refuses a price that is zero or negative", () => {
    for (const price of [0n, -1n, -8_002_901_727n]) {
      refused(published(price, 1)).toThrow("not above zero");
    }
    refused(published(1n, 1)).toThrow("not above zero");
    expect(readMagicblockAccount(published(100n, 1), address).price).toBe(1n);
  });
});

const NOW = PUBLISHED_AT_MS + 700;

/** A reference over a price that the test sets, and a Pyth source it controls. */
const rig = (limits = { maxAgeMs: 3_000, maxPythBps: 30 }) => {
  const clock = new ManualClock(NOW);
  const mark = {
    reading: { source: "MagicBlock", exchange: false, price: dollars(80), atMs: NOW },
  };
  const pyth = {
    calls: 0,
    reading: { source: "Pyth", exchange: false, price: dollars(80), atMs: NOW } as PriceReading,
    failing: false,
  };
  const source: ReferenceSource = {
    name: "Pyth",
    exchange: false,
    minIntervalMs: 5_000,
    read: async () => {
      pyth.calls += 1;
      if (pyth.failing) throw new Error("the Solana RPC did not answer");
      return pyth.reading;
    },
  };
  const reference = new MagicblockReference(
    { latest: () => mark.reading },
    source,
    clock,
    limits,
    () => clock.nowMs(),
  );
  return { clock, mark, pyth, reference };
};

describe("the maker's reference from MagicBlock", () => {
  it("quotes from the MagicBlock price while it is fresh", async () => {
    const { reference } = rig();
    expect(await reference.read()).toEqual({ ok: true, price: dollars(80) });
  });

  it("pulls when the price is older than the limit, and quotes at the limit", async () => {
    const { clock, reference } = rig();
    clock.advance(3_000);
    expect(await reference.read()).toEqual({ ok: true, price: dollars(80) });
    clock.advance(1);
    expect(await reference.read()).toEqual({
      ok: false,
      reason: "the MagicBlock price is 3 s old",
    });
  });

  it("pulls on a price dated further ahead than the limit, and honours a limit set tighter", async () => {
    const { clock, mark, reference } = rig({ maxAgeMs: 1_000, maxPythBps: 30 });
    mark.reading.atMs = NOW + 1_001;
    expect((await reference.read()).ok).toBe(false);
    mark.reading.atMs = NOW;
    clock.advance(1_001);
    expect((await reference.read()).ok).toBe(false);
  });

  it("refuses when a fresh Pyth price is further apart than the limit", async () => {
    const { pyth, reference } = rig();
    pyth.reading = { ...pyth.reading, price: dollars(80.25) };
    const answer = await reference.read();
    expect(answer).toEqual({
      ok: false,
      reason: expect.stringMatching(
        /the MagicBlock and Pyth prices are 31\.\d bps apart, past the 30 bps/,
      ),
    });
  });

  it("quotes when a fresh Pyth price is within the limit, either side of it", async () => {
    for (const price of [80.24, 79.78]) {
      const { pyth, reference } = rig();
      pyth.reading = { ...pyth.reading, price: dollars(price) };
      expect((await reference.read()).ok).toBe(true);
    }
  });

  it("keeps quoting on a Pyth price too old to mean anything, even a wildly different one", async () => {
    const { pyth, reference } = rig();
    pyth.reading = { ...pyth.reading, price: dollars(60), atMs: NOW - 10_001 };
    expect(await reference.read()).toEqual({ ok: true, price: dollars(80) });
  });

  it("checks against a Pyth price of exactly the exchanges' age limit", async () => {
    const { pyth, reference } = rig();
    pyth.reading = { ...pyth.reading, price: dollars(60), atMs: NOW - 10_000 };
    expect((await reference.read()).ok).toBe(false);
  });

  it("keeps quoting when Pyth cannot be read, and does not hammer it", async () => {
    const { clock, mark, pyth, reference } = rig();
    pyth.failing = true;
    for (let tick = 0; tick < 20; tick += 1) {
      clock.advance(250);
      mark.reading = { ...mark.reading, atMs: clock.nowMs() };
      expect(await reference.read()).toEqual({ ok: true, price: dollars(80) });
    }
    expect(pyth.calls).toBe(1);
  });

  it("says why when no MagicBlock price is held", async () => {
    const clock = new ManualClock(NOW);
    const feed = new MagicblockPrice(address, () => new FakeLink(), clock);
    const reference = new MagicblockReference(
      feed,
      { name: "Pyth", exchange: false, read: async () => Promise.reject(new Error("none")) },
      clock,
      { maxAgeMs: 3_000, maxPythBps: 30 },
    );
    expect(await reference.read()).toEqual({
      ok: false,
      reason: "no MagicBlock price has arrived yet",
    });
  });
});

class FakeLink implements PriceAccountLink {
  listener: ((account: PriceAccount) => void) | null = null;
  reads = 0;
  closed = false;
  answer: PriceAccount | null | Error = null;

  async read(): Promise<PriceAccount | null> {
    this.reads += 1;
    if (this.answer instanceof Error) throw this.answer;
    return this.answer;
  }

  onChange(listener: (account: PriceAccount) => void): void {
    this.listener = listener;
  }

  close(): void {
    this.closed = true;
  }

  push(account: PriceAccount): void {
    this.listener?.(account);
  }
}

describe("following the price over the websocket", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const following = () => {
    const clock = new ManualClock(NOW);
    const link = new FakeLink();
    const feed = new MagicblockPrice(address, () => link, clock);
    const loop = feed.follow();
    /** Time passes in the steps the poll loop ticks at. */
    const elapse = async (ms: number) => {
      for (let left = ms; left > 0; left -= 100) {
        clock.advance(100);
        await vi.advanceTimersByTimeAsync(100);
      }
    };
    return { clock, link, feed, loop, elapse };
  };
  const seconds = (ms: number) => Math.floor(ms / 1_000);

  it("holds the newest price pushed, and reads nothing while pushes keep coming", async () => {
    const { clock, link, feed, loop, elapse } = following();
    for (let push = 0; push < 20; push += 1) {
      link.push(published(8_000_000_000n + BigInt(push) * 1_000_000n, seconds(clock.nowMs())));
      await elapse(100);
    }
    expect(feed.latest().price).toBe(dollars(80.19));
    expect(link.reads).toBe(0);
    loop.stop();
  });

  it("ignores a price published before the one it holds", () => {
    const { link, feed, loop } = following();
    link.push(published(8_000_000_000n, 1_794_592_460));
    link.push(published(7_000_000_000n, 1_794_592_459));
    expect(feed.latest().price).toBe(dollars(80));
    loop.stop();
  });

  it("drops the price an update that is refused makes untrustworthy", () => {
    const { link, feed, loop } = following();
    link.push(published(8_000_000_000n, 1_794_592_460));
    link.push({ ...published(8_000_000_000n, 1_794_592_461), owner: PublicKey.default.toBase58() });
    expect(() => feed.latest()).toThrow("not owned by the oracle");
    link.push(published(8_100_000_000n, 1_794_592_462));
    expect(feed.latest().price).toBe(dollars(81));
    loop.stop();
  });

  it("reads the account itself while the socket is silent, and stops once it speaks", async () => {
    const { clock, link, feed, loop, elapse } = following();
    link.push(published(8_000_000_000n, seconds(clock.nowMs())));
    link.answer = published(8_100_000_000n, seconds(clock.nowMs()));
    await elapse(1_000);
    expect(link.reads).toBe(0);
    await elapse(600);
    expect(link.reads).toBeGreaterThan(0);
    expect(feed.latest().price).toBe(dollars(81));

    const readsWhileSilent = link.reads;
    link.push(published(8_200_000_000n, seconds(clock.nowMs())));
    await elapse(900);
    expect(link.reads).toBe(readsWhileSilent);
    expect(feed.latest().price).toBe(dollars(82));
    loop.stop();
  });

  it("goes on polling through failed reads, and keeps the last price to age out", async () => {
    const { clock, link, feed, loop, elapse } = following();
    link.push(published(8_000_000_000n, seconds(clock.nowMs())));
    link.answer = new Error("the rollup did not answer");
    await elapse(3_000);
    expect(link.reads).toBeGreaterThanOrEqual(4);
    expect(feed.latest().price).toBe(dollars(80));
    link.answer = published(8_300_000_000n, seconds(clock.nowMs()));
    await elapse(600);
    expect(feed.latest().price).toBe(dollars(83));
    loop.stop();
  });

  it("refuses when the silent account is gone", async () => {
    const { link, feed, loop, elapse } = following();
    link.answer = null;
    await elapse(2_000);
    expect(() => feed.latest()).toThrow("does not exist");
    loop.stop();
  });

  it("closes the socket and stops polling when stopped", async () => {
    const { link, loop, elapse } = following();
    loop.stop();
    await loop.idle();
    const reads = link.reads;
    await elapse(5_000);
    expect(link.closed).toBe(true);
    expect(link.reads).toBe(reads);
  });

  it("keeps the maker quoting through a dead Pyth feed, and pulls when its own socket is silent too long", async () => {
    const { clock, link, feed, loop, elapse } = following();
    const stalePyth: ReferenceSource = {
      name: "Pyth",
      exchange: false,
      read: async () => ({
        source: "Pyth",
        exchange: false,
        price: dollars(70),
        atMs: clock.nowMs() - 270_000,
      }),
    };
    const reference = new MagicblockReference(feed, stalePyth, clock, {
      maxAgeMs: 3_000,
      maxPythBps: 30,
    });
    link.push(published(8_000_000_000n, seconds(clock.nowMs())));
    expect(await reference.read()).toEqual({ ok: true, price: dollars(80) });

    link.answer = published(8_000_000_000n, seconds(clock.nowMs()));
    await elapse(2_000);
    expect(await reference.read()).toMatchObject({ ok: true });

    link.answer = null;
    await elapse(4_000);
    expect((await reference.read()).ok).toBe(false);
    loop.stop();
  });
});
