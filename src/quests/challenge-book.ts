import { randomBytes } from "node:crypto";
import type { Clock } from "../engine/clock.js";

const CHALLENGE_LIFETIME_MS = 5 * 60_000;
const CHALLENGES_IN_ALL = 10_000;

interface Challenge {
  wallet: string;
  expiresAtMs: number;
}

/**
 * Single-use codes a wallet signs to switch a device on. Held in memory: a restart just means
 * asking again. A code is always issued, whoever asks and for whichever wallet: at a limit the
 * oldest code goes instead, so asking reveals nothing about anyone else's codes.
 */
export class ChallengeBook {
  private readonly open = new Map<string, Challenge>();

  constructor(
    private readonly clock: Clock,
    private readonly newCode: () => string = () => randomBytes(16).toString("hex"),
  ) {}

  issue(wallet: string): { challenge: string; expiresAtMs: number } {
    this.forgetExpired();
    if (this.open.size >= CHALLENGES_IN_ALL) this.open.delete(this.open.keys().next().value!);
    const challenge = this.newCode();
    const expiresAtMs = this.clock.nowMs() + CHALLENGE_LIFETIME_MS;
    this.open.set(challenge, { wallet, expiresAtMs });
    return { challenge, expiresAtMs };
  }

  /** True once per code, only for the wallet it was issued to and before it expires. */
  consume(wallet: string, challenge: string): boolean {
    const entry = this.open.get(challenge);
    if (!entry || entry.wallet !== wallet) return false;
    this.open.delete(challenge);
    return entry.expiresAtMs > this.clock.nowMs();
  }

  forgetExpired(): void {
    const now = this.clock.nowMs();
    for (const [challenge, entry] of this.open) {
      if (entry.expiresAtMs <= now) this.open.delete(challenge);
    }
  }
}
