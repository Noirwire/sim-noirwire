import { rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DAY_MS } from "../src/engine/day-window.js";
import { questWeekOf, questWeekStartMs } from "../src/quests/quest-week.js";
import {
  HOUR_MS,
  WEEK_START_MS,
  againstBot,
  betweenTraders,
  handOver,
  newPerson,
  newSecret,
  rig,
  switchOn,
  trade,
  weekStart,
} from "./quest-helpers.js";

const FIFTY = 50;

describe("matching fills to secrets", () => {
  it("credits a fill in which a registered secret traded against a bot", async () => {
    const r = rig();
    const service = r.open();
    const person = newPerson();
    await trade(r, service, person, FIFTY, r.clock.nowMs());
    await service.idle();
    expect(r.push.pushesOf("101").map((call) => call.user)).toEqual([person.wallet.key]);
    expect(r.push.calls[0]?.quest).toBe(101);
  });

  it("credits the maker side as well as the taker side", async () => {
    const r = rig();
    const service = r.open();
    const person = newPerson();
    const secret = newSecret();
    await switchOn(service, r.clock, person);
    await handOver(service, r.clock, person, [secret]);
    const { fill, botSides } = againstBot(secret, FIFTY, r.clock.nowMs(), "maker");
    service.acceptFill(fill, botSides);
    await service.idle();
    expect(r.push.pushesOf("101")).toHaveLength(1);
  });

  it("never matches a stranger's secret", async () => {
    const r = rig();
    const service = r.open();
    const person = newPerson();
    await switchOn(service, r.clock, person);
    await handOver(service, r.clock, person, [newSecret()]);
    const { fill, botSides } = againstBot(newSecret(), FIFTY, r.clock.nowMs());
    service.acceptFill(fill, botSides);
    await service.idle();
    expect(r.push.calls).toHaveLength(0);
  });

  it("earns nothing when two opted-in wallets trade against each other", async () => {
    const r = rig();
    const service = r.open();
    const [first, second] = [newPerson(), newPerson()];
    const [makerSecret, takerSecret] = [newSecret(), newSecret()];
    await switchOn(service, r.clock, first);
    await switchOn(service, r.clock, second);
    await handOver(service, r.clock, first, [makerSecret]);
    await handOver(service, r.clock, second, [takerSecret]);
    const { fill, botSides } = betweenTraders(makerSecret, takerSecret, FIFTY, r.clock.nowMs());
    service.acceptFill(fill, botSides);
    await service.idle();
    expect(r.push.calls).toHaveLength(0);
  });

  it("earns nothing from a fill between two bots", async () => {
    const r = rig();
    const service = r.open();
    const person = newPerson();
    const secret = newSecret();
    await switchOn(service, r.clock, person);
    await handOver(service, r.clock, person, [secret]);
    const { fill } = againstBot(secret, FIFTY, r.clock.nowMs());
    service.acceptFill(fill, { maker: true, taker: true });
    await service.idle();
    expect(r.push.calls).toHaveLength(0);
  });

  it("counts a secret registered 30 s after its fill but not one registered 2 minutes after", async () => {
    const printedAtMs = WEEK_START_MS + DAY_MS;
    for (const [afterMs, counts] of [
      [30_000, true],
      [120_000, false],
    ] as const) {
      const r = rig(undefined, printedAtMs);
      const service = r.open();
      const person = newPerson();
      const secret = newSecret();
      await switchOn(service, r.clock, person);
      const { fill, botSides } = againstBot(secret, FIFTY, printedAtMs);
      service.acceptFill(fill, botSides);
      r.clock.advance(afterMs);
      await handOver(service, r.clock, person, [secret]);
      await service.idle();
      expect(r.push.pushesOf("101").length > 0).toBe(counts);
    }
  });

  it("credits each fill once, also when a restart offers the same fills again", async () => {
    const r = rig();
    const person = newPerson();
    const secret = newSecret();
    const first = againstBot(secret, 30, r.clock.nowMs());
    const second = againstBot(secret, 20, r.clock.nowMs());

    const before = r.open();
    await switchOn(before, r.clock, person);
    await handOver(before, r.clock, person, [secret]);
    before.acceptFill(first.fill, first.botSides);
    before.acceptFill(first.fill, first.botSides);
    await before.idle();

    const after = r.open();
    after.acceptFill(first.fill, first.botSides);
    await after.idle();
    expect(r.push.calls).toHaveLength(0);

    after.acceptFill(second.fill, second.botSides);
    await after.idle();
    expect(r.push.pushesOf("101")).toHaveLength(1);
  });
});

describe("the Get started quest", () => {
  it("takes no order secrets from a wallet without an opened seat, and counts once it has one", async () => {
    const r = rig();
    r.seatOpen.value = false;
    const service = r.open();
    const person = newPerson();
    await switchOn(service, r.clock, person);
    const refused = await handOver(service, r.clock, person, [newSecret()]);
    expect(refused).toEqual({ ok: false, status: 401, reason: "the request is not valid" });

    r.seatOpen.value = true;
    await trade(r, service, person, FIFTY, r.clock.nowMs());
    await service.idle();
    expect(r.push.pushesOf("101")).toHaveLength(1);
  });

  it("needs one order to total 45 dollars, here across two partial fills, and not two orders", async () => {
    const r = rig();
    const service = r.open();
    const person = newPerson();
    await trade(r, service, person, 25, r.clock.nowMs());
    await trade(r, service, person, 25, r.clock.nowMs());
    await service.idle();
    expect(r.push.calls).toHaveLength(0);

    const secret = newSecret();
    await switchOn(service, r.clock, person);
    await handOver(service, r.clock, person, [secret]);
    const [a, b] = [
      againstBot(secret, 25, r.clock.nowMs()),
      againstBot(secret, 25, r.clock.nowMs()),
    ];
    service.acceptFill(a.fill, a.botSides);
    await service.idle();
    expect(r.push.calls).toHaveLength(0);
    service.acceptFill(b.fill, b.botSides);
    await service.idle();
    expect(r.push.pushesOf("101")).toHaveLength(1);
  });

  it("stops just short of 45 dollars and completes at exactly 45, once ever", async () => {
    const r = rig();
    const service = r.open();
    const person = newPerson();
    const secret = newSecret();
    await switchOn(service, r.clock, person);
    await handOver(service, r.clock, person, [secret]);
    for (const dollars of [44.99, 0.01, 10]) {
      const { fill, botSides } = againstBot(secret, dollars, r.clock.nowMs());
      service.acceptFill(fill, botSides);
      await service.idle();
    }
    expect(r.push.pushesOf("101")).toHaveLength(1);
  });
});

describe("quest weeks and trading days", () => {
  it("starts a quest week on Friday at 08:00 UTC", () => {
    expect(questWeekStartMs(questWeekOf(WEEK_START_MS))).toBe(WEEK_START_MS);
    expect(questWeekOf(WEEK_START_MS - 1)).toBe(questWeekOf(WEEK_START_MS) - 1);
    expect(new Date(WEEK_START_MS).getUTCDay()).toBe(5);
  });

  it("completes three days at exactly 10 dollars each within one week", async () => {
    const r = rig();
    const service = r.open();
    const person = newPerson();
    for (const day of [1, 2, 3]) await trade(r, service, person, 10, weekStart(0) + day * DAY_MS);
    await service.idle();
    expect(r.push.pushesOf("102")).toHaveLength(1);
  });

  it("does not count a day under 10 dollars, and sums a day's fills", async () => {
    const r = rig();
    const service = r.open();
    const person = newPerson();
    await trade(r, service, person, 10, weekStart(0) + DAY_MS);
    await trade(r, service, person, 10, weekStart(0) + 2 * DAY_MS);
    await trade(r, service, person, 9.99, weekStart(0) + 3 * DAY_MS);
    await service.idle();
    expect(r.push.pushesOf("102")).toHaveLength(0);
    await trade(r, service, person, 0.01, weekStart(0) + 3 * DAY_MS + HOUR_MS);
    await service.idle();
    expect(r.push.pushesOf("102")).toHaveLength(1);
  });

  it("splits days at midnight UTC", async () => {
    const r = rig();
    const service = r.open();
    const person = newPerson();
    const midnight = weekStart(0) + 16 * HOUR_MS;
    expect(midnight % DAY_MS).toBe(0);
    await trade(r, service, person, 10, midnight + HOUR_MS);
    await trade(r, service, person, 10, midnight + DAY_MS + HOUR_MS);
    await trade(r, service, person, 6, midnight + 3 * DAY_MS - 1);
    await trade(r, service, person, 6, midnight + 3 * DAY_MS);
    await service.idle();
    expect(r.push.pushesOf("102")).toHaveLength(0);
    await trade(r, service, person, 4, midnight + 3 * DAY_MS + HOUR_MS);
    await service.idle();
    expect(r.push.pushesOf("102")).toHaveLength(1);
  });

  it("does not carry days across the Friday 08:00 UTC boundary", async () => {
    const r = rig();
    const service = r.open();
    const person = newPerson();
    await trade(r, service, person, 10, weekStart(1) - 2 * DAY_MS);
    await trade(r, service, person, 10, weekStart(1) - DAY_MS);
    await trade(r, service, person, 10, weekStart(1));
    await service.idle();
    expect(r.push.pushesOf("102")).toHaveLength(0);

    const other = newPerson();
    await trade(r, service, other, 10, weekStart(2) - 2 * DAY_MS);
    await trade(r, service, other, 10, weekStart(2) - DAY_MS);
    await trade(r, service, other, 10, weekStart(2) - 1);
    await service.idle();
    expect(r.push.pushesOf("102").map((call) => call.user)).toEqual([other.wallet.key]);
  });
});

describe("four weeks in a row", () => {
  const tradeThreeDays = async (
    r: ReturnType<typeof rig>,
    service: ReturnType<ReturnType<typeof rig>["open"]>,
    person: ReturnType<typeof newPerson>,
    week: number,
  ) => {
    for (const day of [1, 2, 3]) {
      await trade(r, service, person, 10, weekStart(week) + day * DAY_MS + HOUR_MS);
    }
    await service.idle();
  };

  it("pays once for four consecutive weeks, then starts the run again from zero", async () => {
    const r = rig();
    const service = r.open();
    const person = newPerson();
    for (const week of [0, 1, 2]) await tradeThreeDays(r, service, person, week);
    expect(r.push.pushesOf("103")).toHaveLength(0);
    await tradeThreeDays(r, service, person, 3);
    expect(r.push.pushesOf("103")).toHaveLength(1);
    for (const week of [4, 5, 6]) await tradeThreeDays(r, service, person, week);
    expect(r.push.pushesOf("103")).toHaveLength(1);
    await tradeThreeDays(r, service, person, 7);
    expect(r.push.pushesOf("103")).toHaveLength(2);
  });

  it("breaks the run on a missed week", async () => {
    const r = rig();
    const service = r.open();
    const person = newPerson();
    for (const week of [0, 1, 3, 4, 5]) await tradeThreeDays(r, service, person, week);
    expect(r.push.pushesOf("103")).toHaveLength(0);
    await tradeThreeDays(r, service, person, 6);
    expect(r.push.pushesOf("103")).toHaveLength(1);
  });
});

describe("the push outbox", () => {
  it("survives a restart and sends what an outage held back", async () => {
    const r = rig();
    r.push.answerWith(503);
    const before = r.open();
    await trade(r, before, newPerson(), FIFTY, r.clock.nowMs());
    await before.idle();
    expect(r.push.calls).toHaveLength(1);

    r.push.answerWith(200);
    r.clock.advance(60_000);
    const after = r.open();
    await after.pushDue();
    expect(r.push.calls).toHaveLength(2);
    r.clock.advance(HOUR_MS);
    await after.pushDue();
    expect(r.push.calls).toHaveLength(2);
  });

  it("retries a refusal hourly and lets the entry go when the give-up time has passed", async () => {
    const r = rig();
    r.push.answerWith(400);
    const service = r.open();
    await trade(r, service, newPerson(), FIFTY, r.clock.nowMs());
    await service.idle();
    expect(r.push.calls).toHaveLength(1);

    r.clock.advance(HOUR_MS - 1);
    await service.pushDue();
    expect(r.push.calls).toHaveLength(1);
    r.clock.advance(1);
    await service.pushDue();
    expect(r.push.calls).toHaveLength(2);

    r.clock.advance(31 * DAY_MS);
    await service.pushDue();
    const callsAtDrop = r.push.calls.length;
    r.clock.advance(5 * DAY_MS);
    await service.pushDue();
    expect(r.push.calls).toHaveLength(callsAtDrop);
  });

  it("stops pushing for good after a 401", async () => {
    const r = rig();
    r.push.answerWith(401);
    const service = r.open();
    await trade(r, service, newPerson(), FIFTY, r.clock.nowMs());
    await service.idle();
    r.clock.advance(HOUR_MS);
    await service.pushDue();
    await trade(r, service, newPerson(), FIFTY, r.clock.nowMs());
    await service.idle();
    expect(r.push.calls).toHaveLength(1);
    expect(r.errors.some((what) => what.includes("401"))).toBe(true);
  });

  it("sends strictly increasing timestamps, also when two pushes are due at the same instant", async () => {
    const r = rig();
    const service = r.open();
    const person = newPerson();
    await trade(r, service, person, 10, weekStart(0) + DAY_MS);
    await trade(r, service, person, 10, weekStart(0) + 2 * DAY_MS);
    await service.idle();
    r.push.calls.length = 0;
    await trade(r, service, person, FIFTY, weekStart(0) + 3 * DAY_MS);
    await service.idle();
    const stamps = r.push.calls.map((call) => call.timestamp);
    expect(r.push.calls.map((call) => call.quest).sort((a, b) => a - b)).toEqual([101, 102]);
    expect(stamps[1]).toBeGreaterThan(stamps[0]);
  });

  it("makes a completion again when a crash lost its award and outbox entry", async () => {
    const r = rig();
    const before = r.open();
    const person = newPerson();
    await trade(r, before, person, FIFTY, r.clock.nowMs());
    await before.idle();
    r.push.calls.length = 0;
    rmSync(join(r.folder, "awards.json"));
    rmSync(join(r.folder, "outbox.json"));

    const after = r.open();
    after.recheck();
    await after.idle();
    expect(r.push.pushesOf("101").map((call) => call.user)).toEqual([person.wallet.key]);
  });
});

describe("what is kept, and for how long", () => {
  it("writes its files readable by the service alone", async () => {
    const r = rig();
    const service = r.open();
    await trade(r, service, newPerson(), FIFTY, r.clock.nowMs());
    await service.idle();
    for (const file of ["devices", "secrets", "credits", "awards", "outbox"]) {
      expect(statSync(join(r.folder, `${file}.json`)).mode & 0o777).toBe(0o600);
    }
  });

  it("stops the start when a file exists and is not in the form it writes", async () => {
    const r = rig();
    const service = r.open();
    await switchOn(service, r.clock, newPerson());
    writeFileSync(join(r.folder, "devices.json"), "{ not json");
    expect(() => r.open()).toThrow(/devices\.json/);
  });

  it("forgets a secret after 30 days and a credit after 35", async () => {
    const r = rig();
    const service = r.open();
    const person = newPerson();
    const secret = newSecret();
    await switchOn(service, r.clock, person);
    await handOver(service, r.clock, person, [secret]);
    const half = againstBot(secret, 30, r.clock.nowMs());
    service.acceptFill(half.fill, half.botSides);
    await service.idle();

    r.clock.advance(36 * DAY_MS);
    await service.cleanUp();
    const lateRest = againstBot(secret, 20, r.clock.nowMs());
    service.acceptFill(lateRest.fill, lateRest.botSides);
    await service.idle();
    expect(r.push.calls).toHaveLength(0);

    await switchOn(service, r.clock, person);
    await handOver(service, r.clock, person, [secret]);
    const rest = againstBot(secret, 20, r.clock.nowMs());
    service.acceptFill(rest.fill, rest.botSides);
    await service.idle();
    expect(r.push.calls).toHaveLength(0);
  });

  it("drops a device when its time is up", async () => {
    const r = rig();
    const service = r.open();
    const person = newPerson();
    await switchOn(service, r.clock, person);
    r.clock.advance(2 * DAY_MS);
    await service.cleanUp();
    const refused = await handOver(service, r.clock, person, [newSecret()]);
    expect(refused.ok).toBe(false);
  });
});
