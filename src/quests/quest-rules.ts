export type QuestKind = "getStarted" | "threeDays" | "streak";

/** One fill credited to one wallet. The order is the sha256 of its secret, in hex. */
export interface Credit {
  wallet: string;
  market: string;
  sequence: number;
  utcDay: number;
  week: number;
  /** In USDC atoms: six decimals, so one dollar is 1,000,000. */
  notionalAtoms: bigint;
  order: string;
}

/** A completed quest, kept for as long as the service runs. */
export interface Award {
  wallet: string;
  quest: QuestKind;
  week: number;
}

const ATOMS_PER_DOLLAR = 1_000_000n;
const GET_STARTED_ORDER_MIN = 45n * ATOMS_PER_DOLLAR;
const TRADING_DAY_MIN = 10n * ATOMS_PER_DOLLAR;
const TRADING_DAYS_PER_WEEK = 3;
const STREAK_WEEKS = 4;

const tradingDaysIn = (credits: readonly Credit[], week: number): number => {
  const perDay = new Map<number, bigint>();
  for (const credit of credits) {
    if (credit.week === week) {
      perDay.set(credit.utcDay, (perDay.get(credit.utcDay) ?? 0n) + credit.notionalAtoms);
    }
  }
  return [...perDay.values()].filter((total) => total >= TRADING_DAY_MIN).length;
};

const largestOrderTotal = (credits: readonly Credit[]): bigint => {
  const perOrder = new Map<string, bigint>();
  for (const credit of credits) {
    perOrder.set(credit.order, (perOrder.get(credit.order) ?? 0n) + credit.notionalAtoms);
  }
  return [...perOrder.values()].reduce((most, total) => (total > most ? total : most), 0n);
};

export interface QuestStanding {
  /** One wallet's credits and awards. */
  credits: readonly Credit[];
  awards: readonly Award[];
  /** The quest week of the credit that was just made. */
  week: number;
  seatOpened: boolean;
}

/** The quests that this wallet has just completed and not been awarded yet. */
export const questsCompleted = ({
  credits,
  awards,
  week,
  seatOpened,
}: QuestStanding): { quest: QuestKind; week: number }[] => {
  const awarded = (quest: QuestKind, atWeek?: number): boolean =>
    awards.some(
      (award) => award.quest === quest && (atWeek === undefined || award.week === atWeek),
    );
  const weekDone = (atWeek: number): boolean =>
    awarded("threeDays", atWeek) || tradingDaysIn(credits, atWeek) >= TRADING_DAYS_PER_WEEK;
  const completed: { quest: QuestKind; week: number }[] = [];

  if (!awarded("getStarted") && seatOpened && largestOrderTotal(credits) >= GET_STARTED_ORDER_MIN) {
    completed.push({ quest: "getStarted", week });
  }
  if (!weekDone(week)) return completed;

  if (!awarded("threeDays", week)) completed.push({ quest: "threeDays", week });
  const lastStreakWeek = Math.max(
    -Infinity,
    ...awards.filter((award) => award.quest === "streak").map((award) => award.week),
  );
  const firstWeekOfRun = week - (STREAK_WEEKS - 1);
  const runIsOnTheWay =
    firstWeekOfRun > lastStreakWeek &&
    Array.from({ length: STREAK_WEEKS }, (_, at) => firstWeekOfRun + at).every(weekDone);
  if (runIsOnTheWay && !awarded("streak", week)) completed.push({ quest: "streak", week });
  return completed;
};
