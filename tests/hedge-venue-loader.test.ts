import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { HedgeVenueLoadError, hedgeVenueFor, loadHedgeVenue } from "../src/hedge/venue-loader.js";

const dirPromise = mkdtemp(join(tmpdir(), "hedge-venue-loader-"));
afterAll(async () => rm(await dirPromise, { recursive: true, force: true }));

let counter = 0;
const writeModule = async (source: string): Promise<string> => {
  counter += 1;
  const path = join(await dirPromise, `venue-${counter}.mjs`);
  await writeFile(path, source);
  return path;
};

const venueSource = (
  overrides: { health?: string; rules?: string; omit?: string; maxCallMs?: string | null } = {},
): string => {
  const maxCallMs = overrides.maxCallMs === undefined ? "10000" : overrides.maxCallMs;
  const methods: Record<string, string> = {
    rules:
      overrides.rules ??
      "async () => ({ minOrderNotional: 1n, sizeIncrement: 1n, priceIncrement: 1n })",
    account: "async () => ({ position: 0n, equity: 0n })",
    placeIoc: "async () => ({ status: 'accepted' })",
    cancel: "async () => {}",
    fills: "async () => []",
    health: overrides.health ?? "async () => ({ ok: true })",
  };
  if (overrides.omit) delete methods[overrides.omit];
  const body = Object.entries(methods)
    .map(([name, fn]) => `${name}: ${fn}`)
    .join(",\n");
  const bound = maxCallMs === null ? "" : `maxCallMs: ${maxCallMs},\n`;
  return `export default async (config) => ({ received: config, ${bound}${body} });`;
};

const loadFailure = async (path: string | undefined, env: Record<string, string> = {}) => {
  const error = await loadHedgeVenue(path, env).then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(HedgeVenueLoadError);
  return (error as HedgeVenueLoadError).message;
};

describe("loading the hedge venue module", () => {
  it("loads a good module with the prefix stripped and the module key left out", async () => {
    const path = await writeModule(venueSource());
    const venue = await loadHedgeVenue(path, {
      HEDGE_VENUE_MODULE: path,
      HEDGE_VENUE_API_URL: "https://example.invalid/x",
      HEDGE_VENUE_KEY_FILE: "/secret/place",
      HEDGE_ENABLED: "1",
      OTHER: "no",
    });
    expect((venue as unknown as { received: unknown }).received).toEqual({
      API_URL: "https://example.invalid/x",
      KEY_FILE: "/secret/place",
    });
    expect(await venue.health()).toEqual({ ok: true });
  });

  it("refuses a missing setting", async () => {
    expect(await loadFailure(undefined)).toContain("HEDGE_VENUE_MODULE is required");
  });

  it("refuses a relative path", async () => {
    const path = await writeModule(venueSource());
    expect(await loadFailure(`./${path.split("/").pop()}`)).toContain("absolute path");
  });

  it("refuses a file that does not exist", async () => {
    const path = join(await dirPromise, "absent.mjs");
    expect(await loadFailure(path)).toContain("does not point at an existing file");
  });

  it("refuses a module without a default function", async () => {
    const path = await writeModule("export const createVenue = () => ({});");
    expect(await loadFailure(path)).toContain("default function createVenue");
  });

  it("refuses a venue missing a method and names the method", async () => {
    const path = await writeModule(venueSource({ omit: "cancel" }));
    expect(await loadFailure(path)).toContain("does not implement: cancel");
  });

  it.each([
    ["missing", null],
    ["zero", "0"],
    ["negative", "-5"],
    ["not finite", "Infinity"],
    ["not a number", "'10000'"],
    ["above half of the late-dispatch quarantine", "30001"],
  ])("refuses a venue whose maxCallMs is %s, naming the key only", async (_, maxCallMs) => {
    const path = await writeModule(venueSource({ maxCallMs }));
    const message = await loadFailure(path, { HEDGE_VENUE_KEY: "s3cret-value" });
    expect(message).toContain("maxCallMs");
    expect(message).not.toContain("s3cret-value");
  });

  it("accepts a maxCallMs at exactly half of the late-dispatch quarantine", async () => {
    const path = await writeModule(venueSource({ maxCallMs: "30000" }));
    const venue = await loadHedgeVenue(path, {});
    expect(venue.maxCallMs).toBe(30_000);
  });

  it("refuses a venue whose health check fails", async () => {
    const path = await writeModule(
      venueSource({ health: "async () => { throw new Error('down'); }" }),
    );
    expect(await loadFailure(path)).toContain("health check failed");
  });

  it("refuses a venue that reports itself unhealthy", async () => {
    const path = await writeModule(
      venueSource({ health: "async () => ({ ok: false, reason: 'halted' })" }),
    );
    expect(await loadFailure(path)).toContain("not healthy");
  });

  it("refuses a venue whose rules cannot be read", async () => {
    const path = await writeModule(
      venueSource({ rules: "async () => { throw new Error('no'); }" }),
    );
    expect(await loadFailure(path)).toContain("rules could not be read");
  });

  it("refuses a venue that returns no rules", async () => {
    const path = await writeModule(venueSource({ rules: "async () => undefined" }));
    expect(await loadFailure(path)).toContain("returned no rules");
  });

  it("names config keys but never their values when the venue cannot be created", async () => {
    const path = await writeModule(
      "export default async (config) => { throw new Error('bad ' + Object.values(config).join(' ')); };",
    );
    const message = await loadFailure(path, {
      HEDGE_VENUE_API_URL: "https://private-value.invalid/abc",
      HEDGE_VENUE_KEY_FILE: "/private/value/path",
    });
    expect(message).toContain("API_URL");
    expect(message).toContain("KEY_FILE");
    expect(message).not.toContain("private-value");
    expect(message).not.toContain("/private/value/path");
  });

  it("does not repeat a module's import error text", async () => {
    const path = await writeModule("throw new Error('leaks /private/value/path');");
    const message = await loadFailure(path, { HEDGE_VENUE_KEY_FILE: "/private/value/path" });
    expect(message).toContain("could not be imported");
    expect(message).not.toContain("/private/value/path");
  });
});

describe("with the hedge off", () => {
  it("never imports the module", async () => {
    const path = await writeModule("throw new Error('imported');");
    const venue = await hedgeVenueFor({ HEDGE_ENABLED: false, HEDGE_VENUE_MODULE: path }, {});
    expect(venue).toBeUndefined();
  });

  it("imports it when the hedge is on", async () => {
    const path = await writeModule(venueSource());
    const venue = await hedgeVenueFor({ HEDGE_ENABLED: true, HEDGE_VENUE_MODULE: path }, {});
    expect(venue).toBeDefined();
  });
});
