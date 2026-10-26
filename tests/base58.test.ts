import { Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { base58Of } from "../src/rollup/base58.js";

describe("base58 of a signature", () => {
  it("agrees with web3.js on 32 bytes, including leading zeros", () => {
    const keys = [
      ...Array.from({ length: 50 }, () => Keypair.generate().publicKey),
      new PublicKey(new Uint8Array(32)),
      new PublicKey(Uint8Array.from({ length: 32 }, (_, at) => (at < 3 ? 0 : at))),
    ];
    for (const key of keys) {
      expect(base58Of(key.toBytes())).toBe(key.toBase58());
    }
  });

  it("writes 64 bytes the way a signature is written, and back into the same bytes", () => {
    const bytes = Uint8Array.from({ length: 64 }, (_, at) => (at * 37 + 11) % 256);
    const text = base58Of(bytes);
    expect(text).toMatch(/^[1-9A-HJ-NP-Za-km-z]{80,88}$/);
    const [first, second] = [bytes.slice(0, 32), bytes.slice(32)];
    expect(base58Of(first)).toBe(new PublicKey(first).toBase58());
    expect(base58Of(second)).toBe(new PublicKey(second).toBase58());
  });
});
