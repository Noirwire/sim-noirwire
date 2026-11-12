import { DAY_MS } from "../engine/day-window.js";

export const WEEK_MS = 7 * DAY_MS;

/** A quest week runs from Friday 08:00 UTC; the first one after the Unix epoch began on 1970-01-02. */
const FIRST_QUEST_WEEK_START_MS = Date.UTC(1970, 0, 2, 8);

export const questWeekOf = (atMs: number): number =>
  Math.floor((atMs - FIRST_QUEST_WEEK_START_MS) / WEEK_MS);

export const questWeekStartMs = (week: number): number =>
  FIRST_QUEST_WEEK_START_MS + week * WEEK_MS;

export const utcDayOf = (atMs: number): number => Math.floor(atMs / DAY_MS);
