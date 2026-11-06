import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ManualClock } from "../src/engine/clock.js";
import { RequestSender, requestIdOf } from "../src/rebalance/request-sender.js";

const ROOT = join("data-test", `rebalance-sender-${Date.now()}`);
afterAll(() => rm(ROOT, { recursive: true, force: true }));

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

const reply = (status: number, body = "{}"): Response => new Response(body, { status });

const setup = async (
  name: string,
  answers: (Response | Error)[],
  extra: Partial<{ path: string }> = {},
) => {
  await mkdir(ROOT, { recursive: true });
  const path = extra.path ?? join(ROOT, `${name}.json`);
  const clock = new ManualClock(1_000_000);
  const calls: Call[] = [];
  const queue = [...answers];
  const fetchStub = (async (url: string, init: RequestInit) => {
    calls.push({
      method: init.method ?? "GET",
      url,
      headers: init.headers as Record<string, string>,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    });
    const next = queue.shift() ?? reply(500);
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch;
  const open = () =>
    RequestSender.open({
      path,
      url: "http://bridge.test/",
      token: "secret-token",
      label: "NBTC-PERP",
      clock,
      fetch: fetchStub,
      cooldownMs: 1_800_000,
      refusedBackoffMs: 60_000,
    });
  return { sender: await open(), open, clock, calls, queue, path };
};

describe("the rebalance request sender", () => {
  it("posts exactly the six fields, with the bearer token, and nothing private", async () => {
    const { sender, calls } = await setup("body", [reply(202, '{"bridgeAta":"ATA"}')]);
    const event = await sender.submit("out", 50_000_000n, false);

    expect(event).toEqual({ kind: "accepted" });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://bridge.test/v1/rebalance/requests");
    expect(calls[0].headers.authorization).toBe("Bearer secret-token");
    expect(Object.keys(calls[0].body as object).sort()).toEqual(
      ["amount", "direction", "requestId", "requestedAt", "seq", "validUntil"].sort(),
    );
    expect(calls[0].body).toMatchObject({
      requestId: requestIdOf("NBTC-PERP", 1),
      direction: "out",
      amount: "50000000",
      seq: 1,
    });
    expect(sender.open?.accepted).toBe(true);
    expect(sender.open?.bridgeAta).toBe("ATA");
  });

  it("derives the id from the sequence number alone", () => {
    expect(requestIdOf("A", 7)).toBe(requestIdOf("A", 7));
    expect(requestIdOf("A", 7)).not.toBe(requestIdOf("A", 8));
    expect(requestIdOf("A", 7)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("saves the counter before sending, and a restart resends the same request under the same id", async () => {
    const { sender, open, clock, calls } = await setup("restart", [new Error("down")]);
    const event = await sender.submit("in", 25_000_000n, false);
    expect(event).toMatchObject({ kind: "retrying" });
    const first = calls[0].body;
    expect(JSON.parse(await readFile(join(ROOT, "restart.json"), "utf8")).seq).toBe(1);

    clock.advance(1_000);
    const reborn = await open();
    expect(reborn.seq).toBe(1);
    expect(reborn.open?.requestId).toBe(requestIdOf("NBTC-PERP", 1));
    expect(await reborn.submit("out", 75_000_000n, false)).toBe(false);
    await reborn.tick();
    expect(calls).toHaveLength(2);
    expect(calls.at(-1)?.body).toEqual(first);
  });

  it("never reuses a number after a request closes", async () => {
    const { sender, clock } = await setup("seq", [reply(202), reply(202)]);
    await sender.submit("out", 25_000_000n, false);
    await sender.close();
    expect(await sender.submit("out", 25_000_000n, false)).toBe(false);
    clock.advance(1_800_001);
    await sender.submit("out", 25_000_000n, false);
    expect(sender.seq).toBe(2);
    expect(sender.open?.requestId).toBe(requestIdOf("NBTC-PERP", 2));
  });

  it("keeps at most one request open", async () => {
    const { sender, calls } = await setup("one", [reply(202)]);
    await sender.submit("out", 25_000_000n, false);
    expect(await sender.submit("in", 25_000_000n, true)).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("closes on 422 and backs off, doubling on each refusal", async () => {
    const { sender, clock } = await setup("refused", [reply(422), reply(422)]);
    expect(await sender.submit("out", 25_000_000n, false)).toEqual({ kind: "refused" });
    expect(sender.open).toBeNull();
    expect(sender.cooldownUntilMs).toBe(clock.nowMs() + 60_000);
    expect(await sender.submit("out", 25_000_000n, false)).toBe(false);
    clock.advance(60_000);
    expect(await sender.submit("out", 25_000_000n, false)).toEqual({ kind: "refused" });
    expect(sender.cooldownUntilMs).toBe(clock.nowMs() + 120_000);
  });

  it("lets an urgent request through the cooldown", async () => {
    const { sender, calls } = await setup("urgent", [reply(422), reply(202)]);
    await sender.submit("out", 25_000_000n, false);
    expect(await sender.submit("in", 25_000_000n, true)).toEqual({ kind: "accepted" });
    expect(calls).toHaveLength(2);
  });

  it("on 409 treats a request the bridge knows as accepted, and a stranger's as already open", async () => {
    const mine = await setup("conflict-mine", [reply(409), reply(200, '{"state":"accepted"}')]);
    expect(await mine.sender.submit("out", 25_000_000n, false)).toEqual({ kind: "accepted" });
    const other = await setup("conflict-other", [reply(409), reply(404)]);
    expect(await other.sender.submit("out", 25_000_000n, false)).toEqual({ kind: "already-open" });
    expect(other.sender.open).toBeNull();
    expect(other.sender.cooldownUntilMs).toBeGreaterThan(other.clock.nowMs());
  });

  it("retries a failing bridge with a growing wait, and gives up when the request expires", async () => {
    const { sender, clock, calls } = await setup("backoff", [reply(500), reply(503), reply(500)]);
    expect(await sender.submit("out", 25_000_000n, false)).toMatchObject({ kind: "retrying" });
    expect(await sender.tick()).toEqual({ kind: "none" });
    clock.advance(5_000);
    expect(await sender.tick()).toMatchObject({ kind: "retrying" });
    clock.advance(5_000);
    expect(await sender.tick()).toEqual({ kind: "none" });
    expect(calls).toHaveLength(2);
    clock.advance(10 * 60_000);
    expect(await sender.tick()).toEqual({ kind: "expired" });
    expect(sender.open).toBeNull();
  });

  it("refuses a request file it cannot read", async () => {
    const { path, open } = await setup("broken", []);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path, "not json");
    await expect(open()).rejects.toThrow(/cannot be read/);
  });
});
