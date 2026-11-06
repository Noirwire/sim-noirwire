import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { isMissing, writeAtomically } from "../bots/maker-state.js";
import type { Clock } from "../engine/clock.js";
import { backoffDelayMs } from "../scheduling/backoff.js";
import type { Direction } from "./planner.js";

export const REQUEST_LIFE_MS = 10 * 60_000;
const ATTEMPT_TIMEOUT_MS = 10_000;
const RETRY_BACKOFF = { baseMs: 5_000, maxMs: 300_000 };
const REFUSED_BACKOFF_CEILING_MS = 6 * 3_600_000;

const openSchema = z.object({
  requestId: z.string(),
  direction: z.enum(["out", "in"]),
  amount: z.string().regex(/^\d+$/),
  requestedAt: z.string(),
  validUntil: z.string(),
  seq: z.number().int().min(1),
  accepted: z.boolean(),
  bridgeAta: z.string().optional(),
});

const fileSchema = z.object({
  seq: z.number().int().min(0),
  open: openSchema.nullable(),
  cooldownUntilMs: z.number(),
  refusals: z.number().int().min(0),
});

type SenderState = z.infer<typeof fileSchema>;
export type OpenRequest = z.infer<typeof openSchema>;

/** What the bridge is told, and nothing else: no position, equity, ratio or fill ever goes into it. */
export interface RequestBody {
  requestId: string;
  direction: Direction;
  amount: string;
  requestedAt: string;
  validUntil: string;
  seq: number;
}

export type SenderEvent =
  | { kind: "none" }
  | { kind: "accepted" }
  | { kind: "refused" | "already-open" | "expired" }
  | { kind: "retrying"; error: unknown };

export interface SenderOptions {
  path: string;
  /** The bridge's address, without a trailing path. */
  url: string;
  token: string;
  /** Names the maker in its request ids. */
  label: string;
  clock: Clock;
  fetch?: typeof fetch;
  /** The wait after a completed or closed request before the next one may go out. */
  cooldownMs: number;
  /** The wait after a refusal, doubling with each one in a row. */
  refusedBackoffMs: number;
}

export const requestIdOf = (label: string, seq: number): string =>
  createHash("sha256").update(`noirwire-rebalance|${label}|${seq}`).digest("hex");

const bodyOf = (request: OpenRequest): RequestBody => ({
  requestId: request.requestId,
  direction: request.direction,
  amount: request.amount,
  requestedAt: request.requestedAt,
  validUntil: request.validUntil,
  seq: request.seq,
});

const bridgeAtaOf = (text: string): string | undefined => {
  try {
    const parsed = z.object({ bridgeAta: z.string() }).safeParse(JSON.parse(text));
    return parsed.success ? parsed.data.bridgeAta : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Asks the treasury bridge to move collateral, one request at a time. The counter and the open
 * request are saved with a sync before anything is sent, so a restart sends the same request under
 * the same id and never a different one under an old id.
 */
export class RequestSender {
  private retryAfterMs = 0;
  private failures = 0;

  private constructor(
    private readonly options: SenderOptions,
    private state: SenderState,
  ) {}

  static async open(options: SenderOptions): Promise<RequestSender> {
    let state: SenderState = { seq: 0, open: null, cooldownUntilMs: 0, refusals: 0 };
    try {
      state = fileSchema.parse(JSON.parse(await readFile(options.path, "utf8")));
    } catch (error) {
      if (!isMissing(error)) {
        throw new Error(
          `the rebalance request file ${options.path} cannot be read, so the request counter cannot be trusted`,
          { cause: error },
        );
      }
    }
    return new RequestSender(options, state);
  }

  get open(): Readonly<OpenRequest> | null {
    return this.state.open;
  }

  get seq(): number {
    return this.state.seq;
  }

  get cooldownUntilMs(): number {
    return this.state.cooldownUntilMs;
  }

  private async save(change: Partial<SenderState>): Promise<void> {
    const next = { ...this.state, ...change };
    await writeAtomically(this.options.path, JSON.stringify(next));
    this.state = next;
  }

  /**
   * Opens a request and sends it. Nothing goes out while one is open, or during the cooldown
   * unless `urgent`. Returns false when it did not start one.
   */
  async submit(
    direction: Direction,
    amount: bigint,
    urgent: boolean,
  ): Promise<SenderEvent | false> {
    const now = this.options.clock.nowMs();
    if (this.state.open !== null) return false;
    if (!urgent && now < this.state.cooldownUntilMs) return false;
    const seq = this.state.seq + 1;
    const open: OpenRequest = {
      requestId: requestIdOf(this.options.label, seq),
      direction,
      amount: amount.toString(),
      requestedAt: new Date(now).toISOString(),
      validUntil: new Date(now + REQUEST_LIFE_MS).toISOString(),
      seq,
      accepted: false,
    };
    await this.save({ seq, open });
    this.failures = 0;
    this.retryAfterMs = 0;
    return this.attempt(open);
  }

  /** Sends an unanswered request again when its wait is over, or closes it once it has expired. */
  async tick(): Promise<SenderEvent> {
    const open = this.state.open;
    if (open === null || open.accepted) return { kind: "none" };
    const now = this.options.clock.nowMs();
    if (now >= Date.parse(open.validUntil)) return this.refusedFor("expired");
    if (now < this.retryAfterMs) return { kind: "none" };
    return this.attempt(open);
  }

  /** Ends the open request and starts the cooldown. Its number is never used again. */
  async close(): Promise<void> {
    await this.save({
      open: null,
      cooldownUntilMs: this.options.clock.nowMs() + this.options.cooldownMs,
    });
  }

  private async refusedFor(kind: "refused" | "already-open" | "expired"): Promise<SenderEvent> {
    const refusals = this.state.refusals + 1;
    const wait = backoffDelayMs(refusals, {
      baseMs: this.options.refusedBackoffMs,
      maxMs: REFUSED_BACKOFF_CEILING_MS,
    });
    await this.save({ open: null, refusals, cooldownUntilMs: this.options.clock.nowMs() + wait });
    return { kind };
  }

  private async attempt(open: OpenRequest): Promise<SenderEvent> {
    let response: Response;
    try {
      response = await this.call("POST", "/v1/rebalance/requests", bodyOf(open));
    } catch (error) {
      this.failures += 1;
      this.retryAfterMs = this.options.clock.nowMs() + backoffDelayMs(this.failures, RETRY_BACKOFF);
      return { kind: "retrying", error };
    }
    if (response.status === 202) {
      const bridgeAta = bridgeAtaOf(await response.text().catch(() => ""));
      await this.save({
        open: { ...open, accepted: true, ...(bridgeAta === undefined ? {} : { bridgeAta }) },
        refusals: 0,
      });
      return { kind: "accepted" };
    }
    if (response.status === 409) {
      const known = await this.status(open.requestId).catch(() => undefined);
      if (known === undefined) {
        this.retryAfterMs = this.options.clock.nowMs() + RETRY_BACKOFF.baseMs;
        return {
          kind: "retrying",
          error: new Error("the bridge has a request open and was not asked about ours"),
        };
      }
      if (known !== null) {
        await this.save({ open: { ...open, accepted: true }, refusals: 0 });
        return { kind: "accepted" };
      }
      return this.refusedFor("already-open");
    }
    if (response.status === 422) return this.refusedFor("refused");
    this.failures += 1;
    this.retryAfterMs = this.options.clock.nowMs() + backoffDelayMs(this.failures, RETRY_BACKOFF);
    return { kind: "retrying", error: new Error(`the bridge answered ${response.status}`) };
  }

  /** The bridge's state for a request: null when it does not know the id. */
  async status(requestId: string): Promise<{ state: string } | null> {
    const response = await this.call("GET", `/v1/rebalance/requests/${requestId}`);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`the bridge answered ${response.status}`);
    const parsed = z.object({ state: z.string() }).parse(await response.json());
    return { state: parsed.state };
  }

  /** Tells the bridge the money is at its account. Only the signature goes with it. */
  async funded(requestId: string, signature: string): Promise<void> {
    const response = await this.call("POST", `/v1/rebalance/requests/${requestId}/funded`, {
      signature,
    });
    if (!response.ok && response.status !== 409) {
      throw new Error(`the bridge answered ${response.status}`);
    }
  }

  private call(method: "GET" | "POST", path: string, body?: unknown): Promise<Response> {
    const send = this.options.fetch ?? fetch;
    return send(`${this.options.url.replace(/\/+$/, "")}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.options.token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
    });
  }
}
