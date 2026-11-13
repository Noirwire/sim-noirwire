import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { Clock } from "../engine/clock.js";
import { KEEPER_NOT_READ_YET, type KeeperProblemSource } from "./keeper-heartbeat.js";

/** The header a keeper's status carries its signature in: lowercase hex of HMAC-SHA256 over the exact body. */
export const KEEPER_SIGNATURE_HEADER = "x-keeper-signature";
/** The query parameter the maker puts its random challenge in. The keeper echoes it in the signed body. */
export const KEEPER_NONCE_PARAMETER = "nonce";
export const KEEPER_STATUS_VERSION = 1;

const NONCE_BYTES = 16;
const REQUEST_TIMEOUT_MS = 5_000;
/** A status body larger than this is refused without being read further. */
const MAX_BODY_BYTES = 4_096;

/**
 * What a keeper signs and publishes, one JSON object per request.
 *
 * `healthy` is true only for a sweep that did not fail, ended no market at "stale price" and left
 * no ALERT standing: the same condition that today lets the keeper write its heartbeat file.
 * `sweepCompletedAtMs` is when that sweep ended, and `sweepSeq` counts the keeper's completed healthy
 * sweeps since it started, so a status that never advances is visible. `issuedAtMs` is when the
 * keeper built this very answer; both times are on the keeper's own clock, and only their difference
 * is used, so a skew between the machines does not matter.
 */
const statusSchema = z.object({
  v: z.literal(KEEPER_STATUS_VERSION),
  keeper: z.string().min(1),
  network: z.string().min(1),
  nonce: z.string().min(1),
  issuedAtMs: z.number().int().nonnegative(),
  healthy: z.boolean(),
  sweepSeq: z.number().int().nonnegative(),
  sweepCompletedAtMs: z.number().int().nonnegative(),
  failedSteps: z.number().int().nonnegative(),
});

export type KeeperStatus = z.infer<typeof statusSchema>;

export interface KeeperSource {
  id: string;
  url: string;
  secret: Buffer;
}

export type Fetcher = (
  url: string,
  init: { signal: AbortSignal; headers?: Record<string, string> },
) => Promise<{
  status: number;
  text(): Promise<string>;
  headers: { get(name: string): string | null };
}>;

const hex = (bytes: Buffer): string => bytes.toString("hex");

/** The signature a keeper puts on `body`. Exported for the keeper's side of the contract and for tests. */
export const signKeeperStatus = (secret: Buffer, body: string): string =>
  hex(createHmac("sha256", secret).update(body).digest());

const signatureMatches = (secret: Buffer, body: string, claimed: string | null): boolean => {
  if (!claimed || !/^[0-9a-f]{64}$/.test(claimed)) return false;
  const expected = createHmac("sha256", secret).update(body).digest();
  return timingSafeEqual(expected, Buffer.from(claimed, "hex"));
};

/** `id=url` entries, comma separated. Throws naming the entry's position, never its address. */
export const parseKeeperUrls = (text: string): { id: string; url: string }[] => {
  const entries = text
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry, at) => {
      const split = entry.indexOf("=");
      const id = split > 0 ? entry.slice(0, split).trim() : "";
      const url = split > 0 ? entry.slice(split + 1).trim() : "";
      if (!/^[A-Za-z0-9_.-]+$/.test(id) || !URL.canParse(url)) {
        throw new Error(`KEEPER_HEARTBEAT_URLS entry ${at + 1} must be id=url`);
      }
      const { protocol } = new URL(url);
      if (protocol !== "http:" && protocol !== "https:") {
        throw new Error(`KEEPER_HEARTBEAT_URLS entry ${at + 1} must be an http or https address`);
      }
      return { id, url };
    });
  if (entries.length === 0) throw new Error("KEEPER_HEARTBEAT_URLS names no keeper");
  if (new Set(entries.map(({ id }) => id)).size !== entries.length) {
    throw new Error("KEEPER_HEARTBEAT_URLS repeats a keeper id");
  }
  return entries;
};

/** `id=secret` lines. A secret is at least 32 characters; it is never echoed. */
export const parseKeeperSecrets = (text: string): Map<string, Buffer> => {
  const secrets = new Map<string, Buffer>();
  for (const [at, raw] of text.split("\n").entries()) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const split = line.indexOf("=");
    const id = split > 0 ? line.slice(0, split).trim() : "";
    const secret = split > 0 ? line.slice(split + 1).trim() : "";
    if (!id || secret.length < 32) {
      throw new Error(
        `KEEPER_HEARTBEAT_SECRETS_FILE line ${at + 1} must be id=secret of 32 or more characters`,
      );
    }
    secrets.set(id, Buffer.from(secret, "utf8"));
  }
  return secrets;
};

/** Every keeper's address with its own secret. A keeper with no secret stops the start. */
export const keeperSources = (urlsText: string, secretsText: string): KeeperSource[] => {
  const secrets = parseKeeperSecrets(secretsText);
  return parseKeeperUrls(urlsText).map(({ id, url }) => {
    const secret = secrets.get(id);
    if (!secret) throw new Error(`KEEPER_HEARTBEAT_SECRETS_FILE has no secret for keeper ${id}`);
    return { id, url, secret };
  });
};

/** What the last answer from one keeper established. */
type Seen =
  | { at: "none" }
  /** A verified, healthy status; its age is told on the keeper's clock plus the time since it arrived. */
  | { at: "healthy"; sweepAgeAtIssueMs: number; receivedAtMs: number }
  /** An answer that arrived and is not good: forged, unhealthy, for another network, or malformed. It voids what came before. */
  | { at: "bad"; reason: string };

interface KeeperState {
  source: KeeperSource;
  seen: Seen;
  /** The last transport failure since the last answer, when there was one. A failure alone does not void a healthy status: it ages out. */
  unreachable: boolean;
}

export interface NetworkKeeperHeartbeatOptions {
  sources: KeeperSource[];
  network: string;
  /** How many keepers must be verified, healthy and fresh. */
  minHealthy: number;
  maxAgeMs: number;
  pollEveryMs: number;
  clock: Clock;
  fetcher?: Fetcher;
}

/**
 * What the liquidation keepers, which run outside this process, said about themselves over the
 * network. Each keeper answers a challenge with a signed status; the maker counts a keeper only for
 * a status whose signature, challenge, network and keeper id check out and that reports a completed
 * healthy sweep still within `maxAgeMs`. Like the file reader, `problem` is synchronous and a
 * function of what the polls saw, and the age is worked out at each call, so a poll loop that dies
 * shows as a stale keeper.
 *
 * Losing the transport behaves as a stale file does: the last healthy status keeps counting until it
 * is `maxAgeMs` old, and then the keeper does not count. An answer that arrives and is wrong (bad
 * signature, wrong challenge, unhealthy) voids the keeper at once. With several keepers the maker
 * needs `minHealthy` of them: a dead or unhealthy copy never hides behind a live one, because each is
 * judged on its own status and a copy that is down is named in the reason when too few remain.
 */
export class NetworkKeeperHeartbeat implements KeeperProblemSource {
  private readonly keepers: KeeperState[];
  private readonly fetcher: Fetcher;
  private lastPollStartedMs = Number.NEGATIVE_INFINITY;
  private polling: Promise<void> | null = null;

  constructor(private readonly options: NetworkKeeperHeartbeatOptions) {
    if (options.sources.length < options.minHealthy) {
      throw new Error(
        `KEEPER_HEARTBEAT_MIN_HEALTHY is ${options.minHealthy} but only ${options.sources.length} keepers are named`,
      );
    }
    this.fetcher = options.fetcher ?? ((url, init) => fetch(url, init));
    this.keepers = options.sources.map((source) => ({
      source,
      seen: { at: "none" },
      unreachable: false,
    }));
  }

  reset(): void {
    this.lastPollStartedMs = Number.NEGATIVE_INFINITY;
    for (const keeper of this.keepers) {
      keeper.seen = { at: "none" };
      keeper.unreachable = false;
    }
  }

  /** Asks every keeper once, unless the last ask was less than `pollEveryMs` ago. Never throws. */
  poll(): Promise<void> {
    const now = this.options.clock.nowMs();
    if (this.polling) return this.polling;
    if (now - this.lastPollStartedMs < this.options.pollEveryMs) return Promise.resolve();
    this.lastPollStartedMs = now;
    const polling = Promise.all(this.keepers.map((keeper) => this.ask(keeper))).then(() => {});
    this.polling = polling.finally(() => {
      this.polling = null;
    });
    return this.polling;
  }

  private async ask(keeper: KeeperState): Promise<void> {
    const nonce = hex(randomBytes(NONCE_BYTES));
    const url = new URL(keeper.source.url);
    url.searchParams.set(KEEPER_NONCE_PARAMETER, nonce);
    let text: string;
    let signature: string | null;
    let httpStatus: number;
    try {
      const response = await this.fetcher(url.toString(), {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      httpStatus = response.status;
      signature = response.headers.get(KEEPER_SIGNATURE_HEADER);
      text = await response.text();
    } catch {
      keeper.unreachable = true;
      return;
    }
    const receivedAtMs = this.options.clock.nowMs();
    if (httpStatus === 401 || httpStatus === 403) {
      keeper.unreachable = false;
      keeper.seen = { at: "bad", reason: "refused the request" };
      return;
    }
    if (httpStatus >= 500 || httpStatus === 429) {
      keeper.unreachable = true;
      return;
    }
    keeper.unreachable = false;
    keeper.seen = this.judge(keeper.source, nonce, httpStatus, signature, text, receivedAtMs);
  }

  private judge(
    source: KeeperSource,
    nonce: string,
    httpStatus: number,
    signature: string | null,
    body: string,
    receivedAtMs: number,
  ): Seen {
    if (httpStatus !== 200) return { at: "bad", reason: `answered ${httpStatus}` };
    if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) {
      return { at: "bad", reason: "sent an oversized status" };
    }
    if (!signatureMatches(source.secret, body, signature)) {
      return { at: "bad", reason: "sent a status that is not signed with its secret" };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return { at: "bad", reason: "sent a malformed status" };
    }
    const status = statusSchema.safeParse(parsed);
    if (!status.success) return { at: "bad", reason: "sent a malformed status" };
    const value = status.data;
    if (value.keeper !== source.id) return { at: "bad", reason: "answered as another keeper" };
    if (value.network !== this.options.network) {
      return { at: "bad", reason: `answered for the network ${value.network}` };
    }
    if (value.nonce !== nonce) return { at: "bad", reason: "answered another request's challenge" };
    if (!value.healthy || value.failedSteps > 0) {
      return { at: "bad", reason: "says its last sweep was not healthy" };
    }
    const sweepAgeAtIssueMs = value.issuedAtMs - value.sweepCompletedAtMs;
    if (sweepAgeAtIssueMs < 0)
      return { at: "bad", reason: "sent a sweep that ends after its answer" };
    return { at: "healthy", sweepAgeAtIssueMs, receivedAtMs };
  }

  /** Why this keeper does not count, or undefined when it does. */
  private keeperProblem(keeper: KeeperState, nowMs: number): string | undefined {
    const { id } = keeper.source;
    const { seen } = keeper;
    if (seen.at === "none") {
      return keeper.unreachable ? `keeper ${id} is unreachable` : KEEPER_NOT_READ_YET;
    }
    if (seen.at === "bad") return `keeper ${id} ${seen.reason}`;
    const age = seen.sweepAgeAtIssueMs + Math.max(0, nowMs - seen.receivedAtMs);
    if (age > this.options.maxAgeMs) {
      const why = keeper.unreachable ? "is unreachable and " : "";
      return `keeper ${id} ${why}has not completed a healthy sweep for ${Math.floor(age / 1000)}s`;
    }
    return undefined;
  }

  /** Why too few keepers count, or undefined when enough do. */
  problem(): string | undefined {
    const now = this.options.clock.nowMs();
    const problems = this.keepers.map((keeper) => this.keeperProblem(keeper, now));
    const healthy = problems.filter((problem) => problem === undefined).length;
    if (healthy >= this.options.minHealthy) return undefined;
    const reasons = problems.filter((problem): problem is string => problem !== undefined);
    // Only when nothing has been heard at all is it the quiet start-up problem.
    if (reasons.every((reason) => reason === KEEPER_NOT_READ_YET)) return KEEPER_NOT_READ_YET;
    return reasons.filter((reason) => reason !== KEEPER_NOT_READ_YET).join("; ");
  }
}
