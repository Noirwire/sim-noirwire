import type { MakerVoice } from "../bots/maker-risk.js";
import type { MakerLedger } from "../bots/maker-state.js";
import type { Clock } from "../engine/clock.js";
import { type FlowFence, applyFlow } from "./flow-adjust.js";
import type { MarginReading } from "./free-collateral.js";
import { OutFlow, type OutFlowOptions, type OutPorts } from "./out-flow.js";
import { planRebalance } from "./planner.js";
import type { RequestSender, SenderEvent } from "./request-sender.js";
import type { RebalanceSettings } from "./settings.js";

const BPS = 10_000n;
/** A transfer in that the bridge has not finished by now is given up on, with an alert. */
const IN_GIVE_UP_MS = 6 * 3_600_000;
/** The bridge's words for a transfer in that has reached the seat, and for one that never will. */
const CREDITED_STATES = new Set(["credited", "book-credited"]);
const DEAD_STATES = new Set(["failed", "expired", "cancelled", "refused", "rejected"]);

/** The seat as the planner needs it. `requirement` is the larger of the margin now and that of the full ladder. */
export interface SeatReading extends MarginReading {
  requirement: bigint;
}

export interface RebalanceChain extends OutPorts {
  read(): Promise<SeatReading | null>;
}

export interface RebalancerOptions {
  settings: RebalanceSettings;
  sender: RequestSender;
  chain: RebalanceChain;
  /** Where the transfer out is journaled. */
  journalPath: string;
  flowTimings?: Pick<OutFlowOptions, "resendAfterMs" | "landWaitMs" | "pollMs" | "sleep">;
  ledger: MakerLedger;
  fence: FlowFence;
  clock: Clock;
  voice: MakerVoice;
  market: string;
}

/**
 * Looks at the maker's own seat, asks the treasury bridge for collateral in or out when it is far
 * from its target, and does the maker's part of a transfer out. Only a direction and a rounded
 * amount ever leave the process.
 */
export class Rebalancer {
  private readonly flow: OutFlow;

  constructor(private readonly options: RebalancerOptions) {
    const { chain, fence, clock, ledger, journalPath, flowTimings } = options;
    this.flow = new OutFlow({
      path: journalPath,
      ports: chain,
      fence,
      clock,
      mayWithdraw: (amount) => this.mayWithdraw(amount),
      onBookWithdrawn: async (requestId, amount) => {
        await applyFlow(ledger, requestId, -amount, 0n);
      },
      ...flowTimings,
    });
  }

  /** Raises the loss-check fence again if a restart finds a withdrawal the limits do not yet know of. */
  async start(): Promise<void> {
    await this.flow.recover();
  }

  async tick(): Promise<void> {
    const { sender } = this.options;
    const open = sender.open;
    if (open === null) {
      const left = await this.flow.current();
      if (left?.phase === "sent-to-bridge") await this.flow.finish();
      else if (left) {
        this.options.voice.alert(
          `ALERT ${this.options.market} maker: a transfer out is journaled with no open request, so it asks for nothing until an operator looks`,
        );
        return;
      }
      return this.maybeAsk();
    }
    if (!open.accepted) {
      this.report(await sender.tick());
      if (sender.open?.accepted !== true) return;
    }
    const accepted = sender.open;
    if (accepted === null) return;
    if (accepted.direction === "out")
      return this.moveOut(accepted.requestId, BigInt(accepted.amount));
    return this.awaitIn(
      accepted.requestId,
      BigInt(accepted.amount),
      Date.parse(accepted.requestedAt),
    );
  }

  private report(event: SenderEvent): void {
    const { voice, market } = this.options;
    if (event.kind === "accepted")
      voice.notice(`${market} maker: the bridge accepted a transfer request`);
    if (event.kind === "refused" || event.kind === "already-open" || event.kind === "expired") {
      voice.notice(
        `${market} maker: a transfer request ended (${event.kind}); it will not ask again for a while`,
      );
    }
  }

  private async maybeAsk(): Promise<void> {
    const { ledger, fence, chain, settings, sender } = this.options;
    if (ledger.state.mode !== "run" || fence.active) return;
    const seat = await chain.read();
    if (!seat) return;
    const plan = planRebalance(seat, seat.requirement, settings.planner);
    if (!plan) return;
    const event = await sender.submit(plan.direction, plan.amount, plan.urgent);
    if (event) this.report(event);
  }

  private async mayWithdraw(amount: bigint): Promise<boolean> {
    const { ledger, chain, settings } = this.options;
    if (ledger.state.mode !== "run") return false;
    const seat = await chain.read();
    if (!seat || amount > seat.withdrawable) return false;
    const floor = (BigInt(settings.planner.bands.lowBps) * seat.requirement) / BPS;
    return seat.equity - amount >= floor;
  }

  private async moveOut(requestId: string, amount: bigint): Promise<void> {
    const { sender, voice, market, settings } = this.options;
    const flow = this.flow;
    const open = sender.open;
    if (open?.bridgeAta !== undefined && open.bridgeAta !== settings.bridgeAta) {
      voice.alert(
        `ALERT ${market} maker: the bridge named an account other than the one configured, so it sent nothing`,
      );
      await sender.close();
      return;
    }
    await flow.begin(requestId, amount);
    const result = await flow.advance();
    if (result.kind === "waiting") return;
    if (result.kind === "failed") {
      voice.notice(
        `${market} maker: a transfer out ended before any money moved: ${result.reason}`,
      );
      await flow.finish();
      await sender.close();
      return;
    }
    if (result.signature !== undefined) {
      await sender.funded(requestId, result.signature).catch((error: unknown) => {
        voice.notice(
          `${market} maker: the bridge was not told of the transfer yet: ${error instanceof Error ? error.message : "no answer"}`,
        );
      });
    }
    // The request closes first: a journal that is gone while its request stays open would send again.
    await sender.close();
    await flow.finish();
    voice.notice(`${market} maker: sent a transfer out to the bridge`);
  }

  private async awaitIn(requestId: string, amount: bigint, requestedAtMs: number): Promise<void> {
    const { sender, ledger, chain, clock, voice, market } = this.options;
    const known = await sender.status(requestId).catch(() => undefined);
    if (known && CREDITED_STATES.has(known.state)) {
      const seat = await chain.read();
      await applyFlow(ledger, requestId, amount, seat?.equity ?? 0n);
      await sender.close();
      voice.notice(`${market} maker: a transfer in reached the seat`);
      return;
    }
    const dead = known !== undefined && known !== null && DEAD_STATES.has(known.state);
    if (dead || clock.nowMs() - requestedAtMs > IN_GIVE_UP_MS) {
      voice.notice(`${market} maker: a transfer in did not complete; it counted nothing`);
      await sender.close();
    }
  }
}
