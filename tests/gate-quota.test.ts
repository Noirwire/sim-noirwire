import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Keypair } from "@solana/web3.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ManualClock } from "../src/engine/clock.js";
import { DAY_MS } from "../src/engine/day-window.js";
import { Admission, RESERVATIONS_HELD } from "../src/gate/admission.js";
import { InviteList, OpenInvitations } from "../src/gate/invite-list.js";
import { SeatLedger } from "../src/gate/seat-ledger.js";
import { clientAddressOf } from "../src/http/client-address.js";
import { RateLimiter, SocketLimiter } from "../src/http/rate-limit.js";
import { every } from "../src/scheduling/repeating.js";

const DIR = join("data-test", `gate-quota-${Date.now()}`);
const DAY_START_MS = 20_000 * DAY_MS;
const PROGRAM_MAX = 50;

const newKey = (): string => Keypair.generate().publicKey.toBase58();

let counter = 0;
const freshDir = (): string => {
  counter += 1;
  const dir = join(DIR, `case-${counter}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};

beforeAll(() => mkdirSync(DIR, { recursive: true }));
afterAll(() => rmSync(DIR, { recursive: true, force: true }));

const openGate = (limits = { perDay: 3, perAskerPerDay: 1 }) => {
  const clock = new ManualClock(DAY_START_MS + 3_600_000);
  const ledger = new SeatLedger(join(freshDir(), "seats.json"), clock);
  return { ledger, clock, admission: new Admission(new OpenInvitations(), ledger, limits, clock) };
};

describe("reservations and the day's quota", () => {
  it("counts a prepare nobody submitted toward the day and the address", async () => {
    const { admission, ledger, clock } = openGate({ perDay: 2, perAskerPerDay: 1 });

    const held = await admission.admit(newKey(), undefined, "1.1.1.1", PROGRAM_MAX, true);

    expect(held.ok).toBe(true);
    expect(ledger.seatsToday(clock.nowMs())).toBe(1);
    expect(ledger.seatsTodayFor("1.1.1.1", clock.nowMs())).toBe(1);
    expect(ledger.submittedToday(clock.nowMs())).toBe(0);
  });

  it("tells a submitted seat from a prepare once the owner has submitted", async () => {
    const { admission, ledger, clock } = openGate();
    const held = await admission.admit(newKey(), undefined, "1.1.1.1", PROGRAM_MAX, true);
    if (!held.ok) throw new Error("expected a reservation");

    expect(await admission.commit(held.invite, "2.2.2.2")).toBe(true);

    expect(ledger.seatsToday(clock.nowMs())).toBe(1);
    expect(ledger.submittedToday(clock.nowMs())).toBe(1);
    expect(ledger.seatsTodayFor("2.2.2.2", clock.nowMs())).toBe(1);
    expect(ledger.seatsTodayFor("1.1.1.1", clock.nowMs())).toBe(0);
  });

  it("answers that openings are in progress while prepares fill the day, and sold out only once submitted seats do", async () => {
    const { admission } = openGate({ perDay: 2, perAskerPerDay: 5 });
    const first = await admission.admit(newKey(), undefined, "1.1.1.1", PROGRAM_MAX, true);
    expect((await admission.admit(newKey(), undefined, "2.2.2.2", PROGRAM_MAX, true)).ok).toBe(
      true,
    );

    const refused = await admission.admit(newKey(), undefined, "3.3.3.3", PROGRAM_MAX, true);

    expect(refused).toEqual(RESERVATIONS_HELD);
    expect(refused.ok ? "" : refused.reason).toBe(
      "new accounts are being opened right now: try again in a minute",
    );

    if (!first.ok) throw new Error("expected a reservation");
    await admission.commit(first.invite, "1.1.1.1");
    const second = await admission.admit(newKey(), undefined, "4.4.4.4", PROGRAM_MAX, true);
    expect(second).toEqual(RESERVATIONS_HELD);
    const held = admission.check(newKey(), undefined, "5.5.5.5", PROGRAM_MAX);
    expect(held.ok ? "" : held.reason).not.toContain("all given out");
  });

  it("says all given out when submitted seats alone fill the day", async () => {
    const { admission } = openGate({ perDay: 1, perAskerPerDay: 5 });
    const only = await admission.admit(newKey(), undefined, "1.1.1.1", PROGRAM_MAX);
    expect(only.ok).toBe(true);

    const refused = await admission.admit(newKey(), undefined, "2.2.2.2", PROGRAM_MAX, true);

    expect(refused.ok ? "" : refused.reason).toContain("all given out");
  });

  it("holds one reservation per address", async () => {
    const { admission } = openGate({ perDay: 5, perAskerPerDay: 5 });
    expect((await admission.admit(newKey(), undefined, "1.1.1.1", PROGRAM_MAX, true)).ok).toBe(
      true,
    );

    const second = await admission.admit(newKey(), undefined, "1.1.1.1", PROGRAM_MAX, true);

    expect(second).toMatchObject({ ok: false, status: 429 });
  });

  it("never says sold out because of reservations alone, however many addresses prepare", async () => {
    const { admission } = openGate({ perDay: 3, perAskerPerDay: 1 });
    for (let at = 0; at < 20; at += 1) {
      await admission.admit(newKey(), undefined, `198.51.100.${at}`, PROGRAM_MAX, true);
    }

    const visitor = await admission.admit(newKey(), undefined, "203.0.113.9", PROGRAM_MAX, true);

    expect(visitor.ok).toBe(false);
    expect(visitor.ok ? "" : visitor.reason).not.toContain("all given out");
  });

  it("keeps the day's cap when many openings are decided at once", async () => {
    const { admission, ledger, clock } = openGate({ perDay: 2, perAskerPerDay: 50 });

    const answers = await Promise.all(
      Array.from({ length: 6 }, (_, at) =>
        admission.admit(newKey(), undefined, `10.0.0.${at}`, PROGRAM_MAX),
      ),
    );

    expect(answers.filter((answer) => answer.ok)).toHaveLength(2);
    expect(ledger.seatsToday(clock.nowMs())).toBe(2);
  });

  it("keeps the day's cap when prepared seats are submitted at once", async () => {
    const { admission, ledger, clock } = openGate({ perDay: 3, perAskerPerDay: 50 });
    const prepared = [];
    for (let at = 0; at < 3; at += 1) {
      const owner = newKey();
      const held = await admission.admit(owner, undefined, `10.0.0.${at}`, PROGRAM_MAX, true);
      if (held.ok) prepared.push({ owner, at });
    }

    const answers = await Promise.all(
      prepared.map(async ({ owner, at }) => {
        const decision = admission.check(owner, undefined, `10.0.1.${at}`, PROGRAM_MAX);
        return decision.ok ? admission.commit(decision.invite, `10.0.1.${at}`) : false;
      }),
    );

    expect(answers.filter(Boolean)).toHaveLength(3);
    expect(ledger.seatsToday(clock.nowMs())).toBe(3);
  });

  it("holds a seat again when an owner prepares after submitting, counted once, and commits it on the next submit", async () => {
    const { admission, ledger, clock } = openGate();
    const owner = newKey();
    const first = await admission.admit(owner, undefined, "1.1.1.1", PROGRAM_MAX, true);
    if (!first.ok) throw new Error("expected a reservation");
    await admission.commit(first.invite, "1.1.1.1");

    await admission.admit(owner, undefined, "1.1.1.1", PROGRAM_MAX, true);

    expect(ledger.seatsToday(clock.nowMs())).toBe(1);
    expect(ledger.seatsTodayFor("1.1.1.1", clock.nowMs())).toBe(1);
    expect(ledger.submittedToday(clock.nowMs())).toBe(0);
    expect(admission.check(newKey(), undefined, "2.2.2.2", PROGRAM_MAX)).toMatchObject({
      ok: true,
    });

    await admission.commit(first.invite, "1.1.1.1");

    expect(ledger.seatsToday(clock.nowMs())).toBe(1);
    expect(ledger.submittedToday(clock.nowMs())).toBe(1);
  });

  it("counts a record written before reservations existed", () => {
    const dir = freshDir();
    const path = join(dir, "seats.json");
    writeFileSync(
      path,
      JSON.stringify({
        seats: [{ invite: "key:a", owner: "a", atMs: DAY_START_MS, state: "unconfirmed" }],
      }),
    );

    const ledger = new SeatLedger(path, new ManualClock(DAY_START_MS));

    expect(ledger.seatsToday(DAY_START_MS)).toBe(1);
  });

  it("finds an unconfirmed seat by owner, not by invite", async () => {
    const { ledger, clock } = openGate();
    await ledger.reserve("code:abc", "owner-1", "1.1.1.1", clock.nowMs());
    await ledger.track("code:abc", "sig", 5);

    expect(ledger.unconfirmedFor("owner-1")?.invite).toBe("code:abc");
    expect(ledger.unconfirmedFor("owner-2")).toBeUndefined();
  });

  it("works with an invite list as well", async () => {
    const dir = freshDir();
    const owner = newKey();
    writeFileSync(join(dir, "invites.txt"), `${owner}\n`);
    const clock = new ManualClock(DAY_START_MS);
    const admission = new Admission(
      new InviteList(join(dir, "invites.txt"), () => {}),
      new SeatLedger(join(dir, "seats.json"), clock),
      { perDay: 1, perAskerPerDay: 1 },
      clock,
    );

    expect((await admission.admit(owner, undefined, "1.1.1.1", PROGRAM_MAX, true)).ok).toBe(true);
  });
});

describe("the address a limit counts", () => {
  it("unwraps an IPv4-mapped IPv6 address", () => {
    expect(clientAddressOf("::ffff:1.2.3.4")).toBe("1.2.3.4");
    expect(clientAddressOf("::FFFF:102:304")).toBe("1.2.3.4");
    expect(clientAddressOf("1.2.3.4")).toBe("1.2.3.4");
  });

  it("buckets IPv6 by its /64", () => {
    const first = clientAddressOf("2001:db8:1:2:aaaa:bbbb:cccc:dddd");
    expect(clientAddressOf("2001:db8:1:2::1")).toBe(first);
    expect(clientAddressOf("2001:0db8:0001:0002:0:0:0:9")).toBe(first);
    expect(clientAddressOf("2001:db8:1:3::1")).not.toBe(first);
    expect(clientAddressOf("::1")).toBe("0:0:0:0::/64");
  });

  it("leaves what is not an address as it is", () => {
    expect(clientAddressOf("not-an-address")).toBe("not-an-address");
  });

  it("makes the mapped and plain forms one asker in the seat record", async () => {
    const { ledger, clock } = openGate();
    await ledger.reserve("key:a", "a", "1.2.3.4", clock.nowMs());

    expect(ledger.seatsTodayFor("::ffff:1.2.3.4", clock.nowMs())).toBe(1);
  });

  it("makes addresses inside one /64 one asker in the seat record", async () => {
    const { ledger, clock } = openGate();
    await ledger.reserve("key:a", "a", "2001:db8:1:2::1", clock.nowMs());

    expect(ledger.seatsTodayFor("2001:db8:1:2:ffff::7", clock.nowMs())).toBe(1);
  });

  it("limits requests and sockets by the same address", () => {
    const clock = new ManualClock(0);
    const requests = new RateLimiter(2, clock);
    expect(requests.hit("1.2.3.4")).toBe(0);
    expect(requests.hit("::ffff:1.2.3.4")).toBe(0);
    expect(requests.hit("::ffff:1.2.3.4")).toBeGreaterThan(0);
    const v6 = new RateLimiter(1, clock);
    expect(v6.hit("2001:db8:1:2::1")).toBe(0);
    expect(v6.hit("2001:db8:1:2::2")).toBeGreaterThan(0);

    const sockets = new SocketLimiter(1);
    expect(sockets.acquire("1.2.3.4")).not.toBeNull();
    expect(sockets.acquire("::ffff:1.2.3.4")).toBeNull();
  });
});

describe("a repeating loop whose handler throws", () => {
  it("logs it and goes on, never an unhandled rejection", async () => {
    vi.useFakeTimers();
    const written: string[] = [];
    const write = vi.spyOn(process.stderr, "write").mockImplementation((text) => {
      written.push(String(text));
      return true;
    });
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", listener);
    try {
      const loop = every(
        100,
        async () => {},
        () => {
          throw new Error("the failure handler threw");
        },
        () => {
          throw new Error("the success handler threw");
        },
      );
      await vi.advanceTimersByTimeAsync(500);
      loop.stop();
      await vi.advanceTimersByTimeAsync(10);
      vi.useRealTimers();
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(written.some((line) => line.includes("handler threw"))).toBe(true);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", listener);
      write.mockRestore();
      vi.useRealTimers();
    }
  });
});
