import type { MarketId, TraderKey } from "../engine/types.js";
import { type PlaceOutcome, executed } from "./chain-types.js";
import { MAKER_NOT_LISTED_ERROR, programErrorLabel } from "./program-errors.js";

const INSUFFICIENT_MARGIN_ERROR = 6024;

export interface QuoteProblems {
  onError(what: string, error: unknown): void;
  onRecovered(what: string): void;
}

/** What the operator can do about a refusal, where it is theirs to fix. */
const remedyOf = (code: number, market: MarketId): string => {
  if (code === MAKER_NOT_LISTED_ERROR) {
    return (
      `${market} takes resting orders only from listed makers. The exchange admin lists the seat ` +
      "with set_seat_access; until then this maker's quotes are refused"
    );
  }
  if (code === INSUFFICIENT_MARGIN_ERROR) {
    return (
      "the seat's collateral does not cover the ladder. Deposit more to it, or make the ladder " +
      "smaller (ROLLUP_MAKER_LEVEL_NUSD, HOUSE_MAKER_LEVELS)"
    );
  }
  return "";
};

/** Why a quote was refused, or null when it was not refused (it executed, or ran out of time). */
const refusalOf = (market: MarketId, owner: string, outcome: PlaceOutcome): string | null => {
  if (outcome.status === "invalid") {
    return `the client refused a ${market} quote before signing it: ${outcome.reason ?? "no reason"}`;
  }
  if (outcome.status !== "failed") return null;
  const code = outcome.programError;
  const refused = `the program refused a ${market} quote from the seat of owner ${owner}`;
  if (code === undefined) return `${refused}: ${outcome.reason ?? "it gave no error number"}`;
  const remedy = remedyOf(code, market);
  return `${programErrorLabel(code)}: ${refused}${remedy ? `; ${remedy}` : ""}`;
};

/**
 * Reports a house maker's refused quote through `problems`, by the program's
 * error number and name and with the owner key any fix names, until one of
 * that maker's quotes executes again. A ladder refused at every requote is
 * many refusals; the problem log makes them one line, then one a minute.
 */
export const noteMakerQuote = (
  problems: QuoteProblems,
  trader: TraderKey,
  market: MarketId,
  owner: string,
  outcome: PlaceOutcome,
): void => {
  const what = `${trader} quoting on ${market}`;
  if (executed(outcome)) {
    problems.onRecovered(what);
    return;
  }
  const refusal = refusalOf(market, owner, outcome);
  if (refusal !== null) problems.onError(what, new Error(refusal));
};
