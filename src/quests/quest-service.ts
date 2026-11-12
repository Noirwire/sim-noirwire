import { createHash } from "node:crypto";
import { join } from "node:path";
import { ROLE, receipt } from "@noirwire/orderbook";
import type { Clock } from "../engine/clock.js";
import { DAY_MS } from "../engine/day-window.js";
import { mulDivScale } from "../engine/money.js";
import type { Fill } from "../engine/types.js";
import { type Repeating, every, idleWithin } from "../scheduling/repeating.js";
import { ChallengeBook } from "./challenge-book.js";
import { PushOutbox } from "./push-outbox.js";
import { type QuestKind, questsCompleted } from "./quest-rules.js";
import { QuestState, type StoredSecret } from "./quest-state.js";
import { questWeekOf, questWeekStartMs, utcDayOf } from "./quest-week.js";
import {
  type DeviceConsent,
  type DeviceOff,
  type QuestOrderBatch,
  deviceConsentText,
  deviceOffText,
  questOrdersText,
  signatureMatches,
} from "./signed-text.js";

/** A secret registered this long after its fill printed still counts. */
const LATE_REGISTRATION_MS = 60_000;
const RECENT_FILLS_KEPT_MS = 5 * 60_000;
const SIGNED_AT_TOLERANCE_MS = 5 * 60_000;
const LONGEST_DEVICE_WINDOW_MS = 30 * DAY_MS;
const DEVICES_PER_WALLET = 5;
const SECRETS_PER_WALLET_PER_DAY = 500;
const SECRETS_PER_MARKET = 20_000;
/**
 * An order with no expiry rests until its owner cancels it, and the terminal's "until cancelled"
 * sets none, so no order lifetime bounds a secret. It is kept for this long at most, plus the grace.
 */
const SECRETS_KEPT_MS = 30 * DAY_MS;
const CREDITS_KEPT_DAYS = 35;
const GET_STARTED_RETRIED_FOR_MS = 30 * DAY_MS;
const WEEKLY_QUEST_RETRIED_AFTER_WEEK_MS = 7 * DAY_MS;
const PUSH_INTERVAL_MS = 30_000;
const CLEAN_UP_INTERVAL_MS = 10 * 60_000;

export interface Refused {
  ok: false;
  status: 400 | 401 | 429;
  reason: string;
}

/** The one answer for every claim that does not hold: it says nothing about why. */
const NOT_VALID: Refused = { ok: false, status: 401, reason: "the request is not valid" };

/** Which sides of a fill were the service's own bots. */
export interface BotSides {
  maker: boolean;
  taker: boolean;
}

type Role = "maker" | "taker";

interface RecentFill {
  fill: Fill;
  /** The only side that may earn: the one that traded against a bot. */
  earner: Role;
}

export interface QuestServiceOptions {
  /** The folder the quest files live in. */
  folder: string;
  clock: Clock;
  /** The markets orders may name. */
  markets: readonly string[];
  questIds: Record<QuestKind, string>;
  /** Whether the wallet holds an opened seat; null where no seat record is kept. */
  seatOpened: ((wallet: string) => boolean) | null;
  push: { url: string; apiKey: string; fetch: typeof fetch };
  onError(what: string, error: unknown): void;
}

const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const receiptTag = (secret: Uint8Array, sequence: number, role: number): bigint =>
  Buffer.from(receipt(secret, BigInt(sequence), role)).readBigUInt64BE(0);

/** The side that traded against a house bot, or null when it was not exactly one side that did. */
const earnerOf = ({ maker, taker }: BotSides): Role | null => {
  if (maker === taker) return null;
  return maker ? "taker" : "maker";
};

/**
 * MagicBlock quest points. A device the wallet switched on hands over the secrets of its orders;
 * a public fill whose receipt one of them produces is credited to that wallet, once, when the
 * other side of the fill was a house bot. The quests the wallet has completed are pushed to
 * MagicBlock.
 */
export class QuestService {
  private readonly state: QuestState;
  private readonly challenges: ChallengeBook;
  private readonly outbox: PushOutbox;
  private readonly recentFills = new Map<string, RecentFill[]>();
  private loops: Repeating[] = [];
  private background: Promise<void> = Promise.resolve();

  /** Throws when a quest file exists and cannot be read. */
  constructor(private readonly options: QuestServiceOptions) {
    this.state = new QuestState(options.folder);
    this.challenges = new ChallengeBook(options.clock);
    this.outbox = new PushOutbox({
      path: join(options.folder, "outbox.json"),
      clock: options.clock,
      url: options.push.url,
      apiKey: options.push.apiKey,
      fetch: options.push.fetch,
      onError: options.onError,
    });
  }

  start(): void {
    if (this.loops.length > 0) return;
    const report = (what: string) => (error: unknown) => this.options.onError(what, error);
    this.recheck();
    this.loops = [
      every(PUSH_INTERVAL_MS, () => this.outbox.pushDue(), report("pushing quests")),
      every(CLEAN_UP_INTERVAL_MS, () => this.cleanUp(), report("cleaning up quest records")),
    ];
    void this.outbox.pushDue().catch(report("pushing quests"));
  }

  async stop(): Promise<void> {
    for (const loop of this.loops) loop.stop();
    await idleWithin([...this.loops, { idle: () => this.idle() }], 2_000);
    this.loops = [];
  }

  /** Resolves once the writes and pushes under way have ended. */
  async idle(): Promise<void> {
    await this.background;
    await this.outbox.idle();
  }

  /** Sends the pushes that are due. */
  pushDue(): Promise<void> {
    return this.outbox.pushDue();
  }

  /**
   * Evaluates the quest rules again for every wallet and week with credits, so a completion
   * whose outbox entry a crash lost is made again. The outbox keeps one entry per wallet, quest
   * and week, so doing it twice changes nothing.
   */
  recheck(): void {
    for (const { wallet, week } of this.state.creditedWeeks()) this.award(wallet, week);
  }

  issueChallenge(wallet: string): { challenge: string; expiresAtMs: number } {
    return this.challenges.issue(wallet);
  }

  async registerDevice(
    request: DeviceConsent & { signature: string },
  ): Promise<{ ok: true } | Refused> {
    const { wallet, deviceKey, until, challenge, signature } = request;
    if (!signatureMatches(wallet, deviceConsentText(request), signature)) return NOT_VALID;
    const now = this.options.clock.nowMs();
    const untilMs = Date.parse(until);
    if (!(untilMs > now && untilMs <= now + LONGEST_DEVICE_WINDOW_MS)) {
      return {
        ok: false,
        status: 400,
        reason: "until must be in the future and at most 30 days ahead",
      };
    }
    const held = this.state.device(deviceKey);
    if (held && held.wallet !== wallet && held.untilMs > now) return NOT_VALID;
    if (!this.challenges.consume(wallet, challenge)) return NOT_VALID;
    try {
      await this.state.setDevice({ deviceKey, wallet, untilMs }, DEVICES_PER_WALLET);
    } catch (error) {
      this.options.onError("saving the quest devices", error);
      return NOT_VALID;
    }
    return { ok: true };
  }

  /** Switches the device off. The answer is the same whether or not it was on. */
  async revokeDevice(request: DeviceOff & { signature: string }): Promise<{ ok: true } | Refused> {
    if (!signatureMatches(request.deviceKey, deviceOffText(request), request.signature)) {
      return NOT_VALID;
    }
    if (!this.isFresh(request.signedAt)) return NOT_VALID;
    if (this.state.removeDevice(request.deviceKey)) {
      try {
        await this.state.saveDevices();
      } catch (error) {
        this.options.onError("saving the quest devices", error);
        return NOT_VALID;
      }
    }
    return { ok: true };
  }

  async registerOrders(
    request: QuestOrderBatch & { signature: string },
  ): Promise<{ ok: true; accepted: number } | Refused> {
    if (!signatureMatches(request.deviceKey, questOrdersText(request), request.signature)) {
      return NOT_VALID;
    }
    const now = this.options.clock.nowMs();
    const device = this.state.device(request.deviceKey);
    if (!this.isFresh(request.signedAt) || !device || device.untilMs <= now) return NOT_VALID;
    if (this.options.seatOpened && !this.options.seatOpened(device.wallet)) return NOT_VALID;
    if (request.orders.some(({ market }) => !this.options.markets.includes(market))) {
      return {
        ok: false,
        status: 400,
        reason: "an order names a market this service does not have",
      };
    }
    const fresh = [
      ...new Map(
        request.orders
          .filter(({ secret }) => !this.state.secret(secret))
          .map((order) => [order.secret, order]),
      ).values(),
    ];
    const dayStartMs = utcDayOf(now) * DAY_MS;
    const today = this.state.secretsOfWalletBetween(device.wallet, dayStartMs, dayStartMs + DAY_MS);
    if (today + fresh.length > SECRETS_PER_WALLET_PER_DAY) {
      return {
        ok: false,
        status: 429,
        reason: "too many orders recorded today: try again tomorrow",
      };
    }
    const full = [...new Set(fresh.map(({ market }) => market))].find(
      (market) =>
        this.state.secretCount(market) + fresh.filter((o) => o.market === market).length >
        SECRETS_PER_MARKET,
    );
    if (full !== undefined) {
      this.options.onError(
        `the quest secret store for ${full} is full: new secrets are refused`,
        null,
      );
      return NOT_VALID;
    }
    const stored: StoredSecret[] = fresh.map(({ market, secret }) => ({
      secret,
      market,
      wallet: device.wallet,
      receivedAtMs: now,
    }));
    for (const entry of stored) this.state.addSecret(entry);
    try {
      if (stored.length > 0) await this.state.saveSecrets();
    } catch (error) {
      this.options.onError("saving the quest secrets", error);
      return NOT_VALID;
    }
    for (const entry of stored) {
      for (const recent of this.recentFills.get(entry.market) ?? []) {
        this.creditIfMatch(entry, recent);
      }
    }
    return { ok: true, accepted: request.orders.length };
  }

  /**
   * A fill the venue has read, new or replayed: the credit is made once per wallet, market and
   * sequence however often it is offered. It earns only when exactly one side was a house bot.
   */
  acceptFill(fill: Fill, botSides: BotSides): void {
    const earner = earnerOf(botSides);
    if (earner === null) return;
    const recent = { fill, earner };
    this.keepRecent(recent);
    for (const entry of this.state.secretsOf(fill.market)) this.creditIfMatch(entry, recent);
  }

  /** Drops what has outlived its time, and writes what changed. */
  async cleanUp(): Promise<void> {
    const now = this.options.clock.nowMs();
    this.challenges.forgetExpired();
    if (this.state.dropDevicesEndedBy(now)) await this.state.saveDevices();
    if (this.state.dropSecretsBefore(now - SECRETS_KEPT_MS - LATE_REGISTRATION_MS)) {
      await this.state.saveSecrets();
    }
    if (this.state.dropCreditsBeforeDay(utcDayOf(now) - CREDITS_KEPT_DAYS)) {
      await this.state.saveCredits();
    }
  }

  private isFresh(signedAt: number): boolean {
    return Math.abs(this.options.clock.nowMs() - signedAt) <= SIGNED_AT_TOLERANCE_MS;
  }

  private keepRecent(recent: RecentFill): void {
    const cutoffMs = this.options.clock.nowMs() - RECENT_FILLS_KEPT_MS;
    const kept = (this.recentFills.get(recent.fill.market) ?? []).filter(
      (other) => other.fill.timestampMs >= cutoffMs,
    );
    if (recent.fill.timestampMs >= cutoffMs) kept.push(recent);
    this.recentFills.set(recent.fill.market, kept);
  }

  private creditIfMatch(entry: StoredSecret, { fill, earner }: RecentFill): void {
    if (entry.receivedAtMs > fill.timestampMs + LATE_REGISTRATION_MS) return;
    const secret = Buffer.from(entry.secret, "hex");
    const [role, tag] =
      earner === "maker" ? [ROLE.maker, fill.makerTag] : [ROLE.taker, fill.takerTag];
    if (receiptTag(secret, fill.sequence, role) !== tag) return;
    const week = questWeekOf(fill.timestampMs);
    const credited = this.state.addCredit({
      wallet: entry.wallet,
      market: fill.market,
      sequence: fill.sequence,
      utcDay: utcDayOf(fill.timestampMs),
      week,
      notionalAtoms: mulDivScale(fill.price, fill.size),
      order: sha256Hex(secret),
    });
    if (!credited) return;
    this.inBackground("saving the quest credits", this.state.saveCredits());
    this.award(entry.wallet, week);
  }

  private award(wallet: string, week: number): void {
    const completed = questsCompleted({
      credits: this.state.creditsOf(wallet),
      awards: this.state.awardsOf(wallet),
      week,
      seatOpened: this.options.seatOpened?.(wallet) ?? false,
    });
    if (completed.length === 0) return;
    const now = this.options.clock.nowMs();
    const queued = completed.map(({ quest, week: questWeek }) =>
      this.outbox
        .enqueue({
          wallet,
          questId: this.options.questIds[quest],
          week: questWeek,
          giveUpAtMs:
            quest === "getStarted"
              ? now + GET_STARTED_RETRIED_FOR_MS
              : questWeekStartMs(questWeek + 1) + WEEKLY_QUEST_RETRIED_AFTER_WEEK_MS,
        })
        .then(() => this.state.addAward({ wallet, quest, week: questWeek })),
    );
    this.inBackground(
      "saving the quest awards",
      Promise.all(queued).then(() => this.state.saveAwards()),
    );
  }

  private inBackground(what: string, saving: Promise<void>): void {
    const done = saving.catch((error: unknown) => this.options.onError(what, error));
    this.background = Promise.all([this.background, done]).then(() => {});
  }
}
