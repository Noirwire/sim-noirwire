import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Keypair } from "@solana/web3.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ManualClock } from "../src/engine/clock.js";
import { DAY_MS } from "../src/engine/day-window.js";
import { Admission } from "../src/gate/admission.js";
import { InviteList, OpenInvitations } from "../src/gate/invite-list.js";
import { SeatLedger } from "../src/gate/seat-ledger.js";

const DIR = join("data-test", `gate-${Date.now()}`);
const DAY_START_MS = 20_000 * DAY_MS;
const PROGRAM_MAX = 5;
const CODE = "launch-code-0001";

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

describe("the invite list", () => {
  const listOf = (text: string) => {
    const path = join(freshDir(), "invites.txt");
    writeFileSync(path, text);
    const problems: string[] = [];
    return { path, problems, list: new InviteList(path, (line) => problems.push(line)) };
  };

  it("admits an owner key listed on its own and refuses one that is not listed", () => {
    const [listed, stranger] = [newKey(), newKey()];
    const { list } = listOf(`# first friends\n${listed}  # Ana\n\n`);

    expect(list.check(listed, undefined)).toEqual({ ok: true, id: `key:${listed}` });
    const refused = list.check(stranger, undefined);
    expect(refused.ok).toBe(false);
    expect(refused.ok ? "" : refused.reason).toContain("not on the invite list");
  });

  it("admits a code only for the key it is written next to, and asks for the code when a key has one", () => {
    const [owner, other] = [newKey(), newKey()];
    const { list } = listOf(`${CODE} ${owner}\n`);

    expect(list.check(owner, CODE).ok).toBe(true);
    expect(list.check(other, CODE).ok).toBe(false);
    expect(list.check(owner, "launch-code-9999").ok).toBe(false);
    const withoutCode = list.check(owner, undefined);
    expect(withoutCode.ok ? "" : withoutCode.reason).toContain("Send the invite code");
  });

  it("names a line it cannot use and leaves it out, and keeps the rest", () => {
    const owner = newKey();
    const { list, problems } = listOf(`not-a-key\n${CODE}\nshort abc\n${owner}\n`);

    expect(problems).toHaveLength(3);
    expect(problems[0]).toContain("line 1");
    expect(problems[1]).toContain("line 2");
    expect(problems.every((line) => !line.includes(CODE))).toBe(true);
    expect(list.check(owner, undefined).ok).toBe(true);
  });

  it("leaves out a code given to two owner keys, so it can never open the wrong person's account", () => {
    const [first, second] = [newKey(), newKey()];
    const { list, problems } = listOf(`${CODE} ${first}\n${CODE} ${second}\n`);

    expect(list.check(first, CODE).ok).toBe(false);
    expect(list.check(second, CODE).ok).toBe(false);
    expect(problems).toEqual([expect.stringContaining("more than one owner key")]);
  });

  it("picks up an edit without a restart, and a removal takes effect at once", () => {
    const [kept, added] = [newKey(), newKey()];
    const { list, path } = listOf(`${kept}\n`);
    expect(list.check(added, undefined).ok).toBe(false);

    writeFileSync(path, `${added}\n`);
    utimesSync(path, new Date(Date.now() + 5_000), new Date(Date.now() + 5_000));

    expect(list.check(added, undefined).ok).toBe(true);
    expect(list.check(kept, undefined).ok).toBe(false);
  });

  it("refuses to start when the file is missing, and says where to look", () => {
    expect(() => new InviteList(join(freshDir(), "nope.txt"), () => {})).toThrow(
      "Check GATE_INVITES_FILE is mounted",
    );
  });

  it("admits nobody while a file that was readable cannot be read, and again once it can", () => {
    const owner = newKey();
    const { list, path, problems } = listOf(`${owner}\n`);
    expect(list.check(owner, undefined).ok).toBe(true);

    rmSync(path);
    const refused = list.check(owner, undefined);
    expect(refused.ok).toBe(false);
    expect(refused.ok ? "" : refused.reason).toContain("cannot be read");
    list.check(owner, undefined);
    expect(problems).toHaveLength(1);

    writeFileSync(path, `${owner}\n`);
    expect(list.check(owner, undefined).ok).toBe(true);
  });
});

describe("the seat record", () => {
  it("survives a restart: what was written down is still there", async () => {
    const path = join(freshDir(), "seats.json");
    const first = new SeatLedger(path, new ManualClock(DAY_START_MS));
    await first.reserve("key:a", "a", "1.1.1.1", DAY_START_MS);
    await first.confirm("key:a");

    const second = new SeatLedger(path, new ManualClock(DAY_START_MS));

    expect(second.forInvite("key:a")?.state).toBe("opened");
    expect(second.seatsToday(DAY_START_MS)).toBe(1);
  });

  it("keeps no network address in the file", async () => {
    const path = join(freshDir(), "seats.json");
    const ledger = new SeatLedger(path, new ManualClock(DAY_START_MS));
    await ledger.reserve("key:a", "a", "203.0.113.77", DAY_START_MS);

    expect(readFileSync(path, "utf8")).not.toContain("203.0.113.77");
  });

  it("hashes the address with a key of its own, so the file alone cannot be searched for an address", async () => {
    const asker = (dir: string, ip: string) => {
      const path = join(dir, "seats.json");
      const ledger = new SeatLedger(path, new ManualClock(DAY_START_MS));
      return ledger.reserve("key:a", "a", ip, DAY_START_MS).then(() => {
        const [record] = JSON.parse(readFileSync(path, "utf8")).seats;
        return record.asker as string;
      });
    };

    const first = await asker(freshDir(), "203.0.113.77");
    const second = await asker(freshDir(), "203.0.113.77");

    expect(first).not.toBe(second);
    expect(first).not.toBe(createHash("sha256").update("203.0.113.77").digest("hex").slice(0, 16));
  });

  it("keeps the key in a file only its service can read, and counts addresses the same after a restart", async () => {
    const dir = freshDir();
    const path = join(dir, "seats.json");
    const first = new SeatLedger(path, new ManualClock(DAY_START_MS));
    await first.reserve("key:a", "a", "203.0.113.77", DAY_START_MS);

    expect(statSync(`${path}.key`).mode & 0o777).toBe(0o600);
    const second = new SeatLedger(path, new ManualClock(DAY_START_MS));
    expect(second.seatsTodayFor("203.0.113.77", DAY_START_MS)).toBe(1);
    expect(second.seatsTodayFor("203.0.113.78", DAY_START_MS)).toBe(0);
  });

  it("drops the address hash once its day is over, and keeps the seat", async () => {
    const path = join(freshDir(), "seats.json");
    const clock = new ManualClock(DAY_START_MS + 3_600_000);
    const ledger = new SeatLedger(path, clock);
    await ledger.reserve("key:a", "a", "203.0.113.77", clock.nowMs());
    expect(JSON.parse(readFileSync(path, "utf8")).seats[0].asker).toBeTypeOf("string");

    clock.advance(DAY_MS);
    await ledger.reserve("key:b", "b", "203.0.113.78", clock.nowMs());

    const [older, newer] = JSON.parse(readFileSync(path, "utf8")).seats;
    expect(older.invite).toBe("key:a");
    expect(older.asker).toBeUndefined();
    expect(newer.asker).toBeTypeOf("string");
    expect(new SeatLedger(path, clock).forInvite("key:a")?.owner).toBe("a");
  });

  it("stops the start when the key file is damaged, and says to delete it", async () => {
    const path = join(freshDir(), "seats.json");
    writeFileSync(`${path}.key`, "not a key");

    expect(() => new SeatLedger(path, new ManualClock(DAY_START_MS))).toThrow("Delete it");
  });

  it("stops the start rather than forget who has a seat when the file is damaged", () => {
    const path = join(freshDir(), "seats.json");
    writeFileSync(path, "{ not json");

    expect(() => new SeatLedger(path, new ManualClock(DAY_START_MS))).toThrow(
      "will not start without it",
    );
  });

  it("starts empty when there is no file yet", () => {
    expect(
      new SeatLedger(join(freshDir(), "none.json"), new ManualClock(DAY_START_MS)).seatsToday(
        DAY_START_MS,
      ),
    ).toBe(0);
  });
});

describe("admission", () => {
  const setup = (invites: string, limits = { perDay: 3, perAskerPerDay: 1 }) => {
    const dir = freshDir();
    const invitesPath = join(dir, "invites.txt");
    writeFileSync(invitesPath, invites);
    const clock = new ManualClock(DAY_START_MS + 3_600_000);
    const ledgerPath = join(dir, "seats.json");
    const make = () =>
      new Admission(
        new InviteList(invitesPath, () => {}),
        new SeatLedger(ledgerPath, clock),
        limits,
        clock,
      );
    return { admission: make(), make, clock };
  };

  const reason = (decision: { ok: boolean; reason?: string }): string => decision.reason ?? "";

  it("signs for an invited key and for nobody else", async () => {
    const owner = newKey();
    const { admission } = setup(`${owner}\n`);

    expect((await admission.admit(owner, undefined, "1.1.1.1", PROGRAM_MAX)).ok).toBe(true);
    const stranger = await admission.admit(newKey(), undefined, "2.2.2.2", PROGRAM_MAX);
    expect(stranger.ok).toBe(false);
    expect(reason(stranger)).toContain("not on the invite list");
  });

  it("opens at most one seat per invite, also across a restart", async () => {
    const owner = newKey();
    const { admission, make } = setup(`${CODE} ${owner}\n`);
    const first = await admission.admit(owner, CODE, "1.1.1.1", PROGRAM_MAX);
    expect(first.ok).toBe(true);
    if (first.ok) await admission.confirm(first.invite);

    for (const gate of [admission, make()]) {
      const again = await gate.admit(owner, CODE, "9.9.9.9", PROGRAM_MAX);
      expect(again.ok).toBe(false);
      expect(reason(again)).toContain("used already");
    }
  });

  it("lets a seat that was sent but never confirmed be tried again without counting it twice", async () => {
    const owner = newKey();
    const { admission } = setup(`${owner}\n`, { perDay: 1, perAskerPerDay: 1 });
    expect((await admission.admit(owner, undefined, "1.1.1.1", PROGRAM_MAX)).ok).toBe(true);

    expect((await admission.admit(owner, undefined, "1.1.1.1", PROGRAM_MAX)).ok).toBe(true);
  });

  it("frees the day's count and the invite when the seat was not opened", async () => {
    const owner = newKey();
    const { admission } = setup(`${owner}\n`, { perDay: 1, perAskerPerDay: 1 });
    const first = await admission.admit(owner, undefined, "1.1.1.1", PROGRAM_MAX);
    if (first.ok) await admission.release(first.invite);

    expect((await admission.admit(newKey(), undefined, "1.1.1.1", PROGRAM_MAX)).ok).toBe(false);
    expect((await admission.admit(owner, undefined, "1.1.1.1", PROGRAM_MAX)).ok).toBe(true);
  });

  it("stops at the day's limit and opens again at 00:00 UTC", async () => {
    const owners = [newKey(), newKey(), newKey()];
    const { admission, clock } = setup(owners.join("\n"), { perDay: 2, perAskerPerDay: 2 });
    expect((await admission.admit(owners[0], undefined, "1.1.1.1", PROGRAM_MAX)).ok).toBe(true);
    expect((await admission.admit(owners[1], undefined, "2.2.2.2", PROGRAM_MAX)).ok).toBe(true);

    const full = await admission.admit(owners[2], undefined, "3.3.3.3", PROGRAM_MAX);
    expect(full).toMatchObject({ ok: false, status: 503 });
    expect(reason(full)).toContain("00:00 UTC");

    clock.set(DAY_START_MS + DAY_MS + 60_000);
    expect((await admission.admit(owners[2], undefined, "3.3.3.3", PROGRAM_MAX)).ok).toBe(true);
  });

  it("limits one network address per day, however many invites it holds", async () => {
    const owners = [newKey(), newKey()];
    const { admission } = setup(owners.join("\n"), { perDay: 3, perAskerPerDay: 1 });
    expect((await admission.admit(owners[0], undefined, "1.1.1.1", PROGRAM_MAX)).ok).toBe(true);

    const second = await admission.admit(owners[1], undefined, "1.1.1.1", PROGRAM_MAX);

    expect(second).toMatchObject({ ok: false, status: 429 });
    expect(reason(second)).toContain("try again tomorrow");
    expect((await admission.admit(owners[1], undefined, "2.2.2.2", PROGRAM_MAX)).ok).toBe(true);
  });

  it("keeps the day's limit below the program's, whatever is configured", async () => {
    const owners = [newKey(), newKey(), newKey()];
    const { admission } = setup(owners.join("\n"), { perDay: 50, perAskerPerDay: 50 });

    expect((await admission.admit(owners[0], undefined, "1.1.1.1", 3)).ok).toBe(true);
    expect((await admission.admit(owners[1], undefined, "2.2.2.2", 3)).ok).toBe(true);
    expect((await admission.admit(owners[2], undefined, "3.3.3.3", 3)).ok).toBe(false);
    expect((await admission.admit(owners[2], undefined, "3.3.3.3", 1)).ok).toBe(false);
  });

  it("signs nothing before it has read the program's limit", async () => {
    const owner = newKey();
    const { admission } = setup(`${owner}\n`);

    const decision = await admission.admit(owner, undefined, "1.1.1.1", null);

    expect(decision).toMatchObject({ ok: false, status: 503 });
    expect(reason(decision)).toContain("still starting");
  });

  it("signs nothing when the seat cannot be written down", async () => {
    const owner = newKey();
    const dir = freshDir();
    const invitesPath = join(dir, "invites.txt");
    writeFileSync(invitesPath, `${owner}\n`);
    const admission = new Admission(
      new InviteList(invitesPath, () => {}),
      new SeatLedger(join(dir, "folder", "seats.json"), new ManualClock(DAY_START_MS)),
      { perDay: 3, perAskerPerDay: 1 },
      new ManualClock(DAY_START_MS),
    );
    writeFileSync(join(dir, "folder"), "a file where the folder should be");

    const decision = await admission.admit(owner, undefined, "1.1.1.1", PROGRAM_MAX);

    expect(decision).toMatchObject({ ok: false, status: 503 });
    expect(reason(decision)).toContain("signed nothing");
    expect(admission.check(owner, undefined, "1.1.1.1", PROGRAM_MAX).ok).toBe(true);
  });

  it("refuses an address that already has an account, even under a new invite", async () => {
    const owner = newKey();
    const { admission } = setup(`${owner}\n${CODE} ${owner}\n`);
    const first = await admission.admit(owner, undefined, "1.1.1.1", PROGRAM_MAX);
    if (first.ok) await admission.confirm(first.invite);

    const second = await admission.admit(owner, CODE, "2.2.2.2", PROGRAM_MAX);

    expect(second).toMatchObject({ ok: false, status: 409 });
    expect(reason(second)).toContain("has an account already");
  });
});

describe("admission with the gate open", () => {
  const setup = (limits = { perDay: 3, perAskerPerDay: 1 }) => {
    const dir = freshDir();
    const clock = new ManualClock(DAY_START_MS + 3_600_000);
    const ledgerPath = join(dir, "seats.json");
    const make = () =>
      new Admission(new OpenInvitations(), new SeatLedger(ledgerPath, clock), limits, clock);
    return { admission: make(), make };
  };

  const reason = (decision: { ok: boolean; reason?: string }): string => decision.reason ?? "";

  it("signs for an owner key that is on no list", async () => {
    const { admission } = setup();

    const decision = await admission.admit(newKey(), undefined, "1.1.1.1", PROGRAM_MAX);

    expect(decision.ok).toBe(true);
  });

  it("still stops at the day's limit", async () => {
    const { admission } = setup({ perDay: 2, perAskerPerDay: 2 });
    for (const ip of ["1.1.1.1", "2.2.2.2"]) {
      expect((await admission.admit(newKey(), undefined, ip, PROGRAM_MAX)).ok).toBe(true);
    }

    const third = await admission.admit(newKey(), undefined, "3.3.3.3", PROGRAM_MAX);

    expect(third).toMatchObject({ ok: false, status: 503 });
    expect(reason(third)).toContain("all given out");
  });

  it("keeps the day's limit under the program's own", async () => {
    const { admission } = setup({ perDay: 10, perAskerPerDay: 10 });

    const refused = await admission.admit(newKey(), undefined, "1.1.1.1", 1);

    expect(refused).toMatchObject({ ok: false, status: 503 });
  });

  it("still stops one network address at its limit", async () => {
    const { admission } = setup();
    expect((await admission.admit(newKey(), undefined, "1.1.1.1", PROGRAM_MAX)).ok).toBe(true);

    const second = await admission.admit(newKey(), undefined, "1.1.1.1", PROGRAM_MAX);

    expect(second).toMatchObject({ ok: false, status: 429 });
    expect((await admission.admit(newKey(), undefined, "2.2.2.2", PROGRAM_MAX)).ok).toBe(true);
  });

  it("opens one account per owner key, also across a restart, and says the address has one", async () => {
    const owner = newKey();
    const { admission, make } = setup();
    const first = await admission.admit(owner, undefined, "1.1.1.1", PROGRAM_MAX);
    expect(first.ok).toBe(true);
    if (first.ok) await admission.confirm(first.invite);

    for (const gate of [admission, make()]) {
      const again = await gate.admit(owner, undefined, "9.9.9.9", PROGRAM_MAX);
      expect(again).toMatchObject({ ok: false, status: 409 });
      expect(reason(again)).toContain("has an account already");
    }
  });

  it("frees the owner key again when its seat was not opened", async () => {
    const owner = newKey();
    const { admission } = setup();
    const first = await admission.admit(owner, undefined, "1.1.1.1", PROGRAM_MAX);
    if (first.ok) await admission.release(first.invite);

    expect((await admission.admit(owner, undefined, "1.1.1.1", PROGRAM_MAX)).ok).toBe(true);
  });
});
