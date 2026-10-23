import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import type { HedgeVenue } from "./hedge-venue.js";

const MODULE_VARIABLE = "HEDGE_VENUE_MODULE";
const CONFIG_PREFIX = "HEDGE_VENUE_";
const VENUE_METHODS = ["rules", "account", "placeIoc", "cancel", "fills", "health"] as const;

/** The hedge venue module could not be loaded or did not pass its start-up checks. It cannot start. */
export class HedgeVenueLoadError extends Error {
  constructor(problem: string) {
    super(`HEDGE_ENABLED=1 cannot start: ${problem}`);
    this.name = "HedgeVenueLoadError";
  }
}

/** The settings the module is given: every HEDGE_VENUE_* variable but the module's path, without the prefix. */
export const venueModuleConfig = (
  env: Record<string, string | undefined>,
): Record<string, string> => {
  const settings: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith(CONFIG_PREFIX) || name === MODULE_VARIABLE || value === undefined)
      continue;
    settings[name.slice(CONFIG_PREFIX.length)] = value;
  }
  return settings;
};

const keyNames = (settings: Record<string, string>): string => {
  const names = Object.keys(settings);
  return names.length > 0 ? names.join(", ") : "none";
};

/** What a module threw is named by its type only: its message may quote the settings it was given. */
const thrownKind = (error: unknown): string =>
  error instanceof Error && error.name ? error.name : "a non-error value";

const checkModulePath = (path: string | undefined): string => {
  if (!path) {
    throw new HedgeVenueLoadError(
      `${MODULE_VARIABLE} is required: set it to the absolute path of the hedge venue module file, or unset HEDGE_ENABLED.`,
    );
  }
  if (!isAbsolute(path)) {
    throw new HedgeVenueLoadError(
      `${MODULE_VARIABLE} must be an absolute path to a JavaScript module file, not a relative one.`,
    );
  }
  let isFile = false;
  try {
    isFile = statSync(path).isFile();
  } catch {
    isFile = false;
  }
  if (!isFile) {
    throw new HedgeVenueLoadError(
      `${MODULE_VARIABLE} does not point at an existing file. Check the path and that the module is built.`,
    );
  }
  return path;
};

const importFactory = async (
  path: string,
): Promise<(config: Record<string, string>) => unknown> => {
  let loaded: unknown;
  try {
    loaded = await import(/* @vite-ignore */ pathToFileURL(path).href);
  } catch (error) {
    throw new HedgeVenueLoadError(
      `the hedge venue module could not be imported (it threw ${thrownKind(error)}). Check that it is a valid, built JavaScript module and that its own dependencies are installed.`,
    );
  }
  const factory = (loaded as { default?: unknown }).default;
  if (typeof factory !== "function") {
    throw new HedgeVenueLoadError(
      "the hedge venue module must export a default function createVenue(config).",
    );
  }
  return factory as (config: Record<string, string>) => unknown;
};

const assertImplementsVenue = (
  candidate: unknown,
  settings: Record<string, string>,
): HedgeVenue => {
  const missing = VENUE_METHODS.filter(
    (method) =>
      typeof (candidate as Record<string, unknown> | null | undefined)?.[method] !== "function",
  );
  if (missing.length > 0) {
    throw new HedgeVenueLoadError(
      `the venue the module created does not implement: ${missing.join(", ")}. Config keys it was given: ${keyNames(settings)}.`,
    );
  }
  return candidate as HedgeVenue;
};

/** The controller needs the venue's rules and a heartbeat before it can size or place anything. */
const assertAnswers = async (venue: HedgeVenue): Promise<void> => {
  let health: Awaited<ReturnType<HedgeVenue["health"]>> | undefined;
  try {
    health = await venue.health();
  } catch (error) {
    throw new HedgeVenueLoadError(
      `the hedge venue's health check failed at start-up (it threw ${thrownKind(error)}). Check the venue is reachable and the HEDGE_VENUE_* settings are right.`,
    );
  }
  if (!health) {
    throw new HedgeVenueLoadError("the hedge venue's health check returned nothing at start-up.");
  }
  if (!health.ok) {
    throw new HedgeVenueLoadError(
      "the hedge venue reports it is not healthy at start-up. Check the venue is reachable and trading.",
    );
  }
  let rules: Awaited<ReturnType<HedgeVenue["rules"]>> | undefined;
  try {
    rules = await venue.rules();
  } catch (error) {
    throw new HedgeVenueLoadError(
      `the hedge venue's rules could not be read at start-up (it threw ${thrownKind(error)}).`,
    );
  }
  if (!rules) {
    throw new HedgeVenueLoadError("the hedge venue returned no rules at start-up.");
  }
};

/**
 * Loads the hedge venue from the module at `modulePath` and checks it answers.
 * Every failure is a `HedgeVenueLoadError` whose text names what to fix and
 * the config key names, never their values.
 */
export const loadHedgeVenue = async (
  modulePath: string | undefined,
  env: Record<string, string | undefined>,
): Promise<HedgeVenue> => {
  const path = checkModulePath(modulePath);
  const createVenue = await importFactory(path);
  const settings = venueModuleConfig(env);
  let created: unknown;
  try {
    created = await createVenue(settings);
  } catch (error) {
    throw new HedgeVenueLoadError(
      `the hedge venue module failed to create the venue (it threw ${thrownKind(error)}). Config keys it was given: ${keyNames(settings)}.`,
    );
  }
  const venue = assertImplementsVenue(created, settings);
  await assertAnswers(venue);
  return venue;
};

/** The hedge venue when hedging is on, and nothing, without touching the module, when it is off. */
export const hedgeVenueFor = (
  config: { HEDGE_ENABLED: boolean; HEDGE_VENUE_MODULE?: string },
  env: Record<string, string | undefined> = process.env,
): Promise<HedgeVenue | undefined> =>
  config.HEDGE_ENABLED
    ? loadHedgeVenue(config.HEDGE_VENUE_MODULE, env)
    : Promise.resolve(undefined);
