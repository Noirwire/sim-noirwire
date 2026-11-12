import { join } from "node:path";
import { z } from "zod";
import { JsonFile } from "./json-file.js";
import type { Award, Credit } from "./quest-rules.js";

export interface Device {
  deviceKey: string;
  wallet: string;
  untilMs: number;
}

export interface StoredSecret {
  secret: string;
  wallet: string;
  market: string;
  receivedAtMs: number;
}

const deviceSchema = z.object({
  deviceKey: z.string(),
  wallet: z.string(),
  untilMs: z.number(),
});
const secretSchema = z.object({
  secret: z.string(),
  wallet: z.string(),
  market: z.string(),
  receivedAtMs: z.number(),
});
const creditSchema = z.object({
  wallet: z.string(),
  market: z.string(),
  sequence: z.number().int(),
  utcDay: z.number().int(),
  week: z.number().int(),
  notionalAtoms: z.string().regex(/^\d+$/),
  order: z.string(),
});
const awardSchema = z.object({
  wallet: z.string(),
  quest: z.enum(["getStarted", "threeDays", "streak"]),
  week: z.number().int(),
});

const creditKey = (wallet: string, market: string, sequence: number): string =>
  `${wallet}|${market}|${sequence}`;

/** Everything the quests remember, each kind in a file of its own under one folder. */
export class QuestState {
  private readonly devicesFile: JsonFile<{ devices: Device[] }>;
  private readonly secretsFile: JsonFile<{ secrets: StoredSecret[] }>;
  private readonly creditsFile: JsonFile<{ credits: z.infer<typeof creditSchema>[] }>;
  private readonly awardsFile: JsonFile<{ awards: Award[] }>;
  private readonly devices = new Map<string, Device>();
  private readonly secrets = new Map<string, StoredSecret>();
  private credits: Credit[];
  private readonly creditKeys = new Set<string>();
  private readonly awards: Award[];

  /** Throws when a file exists and cannot be read. */
  constructor(folder: string) {
    this.devicesFile = new JsonFile(
      join(folder, "devices.json"),
      z.object({ devices: z.array(deviceSchema) }),
      () => ({ devices: [] }),
    );
    this.secretsFile = new JsonFile(
      join(folder, "secrets.json"),
      z.object({ secrets: z.array(secretSchema) }),
      () => ({ secrets: [] }),
    );
    this.creditsFile = new JsonFile(
      join(folder, "credits.json"),
      z.object({ credits: z.array(creditSchema) }),
      () => ({ credits: [] }),
    );
    this.awardsFile = new JsonFile(
      join(folder, "awards.json"),
      z.object({ awards: z.array(awardSchema) }),
      () => ({ awards: [] }),
    );
    for (const device of this.devicesFile.load().devices)
      this.devices.set(device.deviceKey, device);
    for (const secret of this.secretsFile.load().secrets) this.secrets.set(secret.secret, secret);
    this.credits = this.creditsFile.load().credits.map((credit) => ({
      ...credit,
      notionalAtoms: BigInt(credit.notionalAtoms),
    }));
    for (const credit of this.credits) {
      this.creditKeys.add(creditKey(credit.wallet, credit.market, credit.sequence));
    }
    this.awards = this.awardsFile.load().awards;
  }

  device(deviceKey: string): Device | undefined {
    return this.devices.get(deviceKey);
  }

  /** Switches the device on; a wallet keeps `devicesPerWallet` at most, the oldest replaced first. */
  setDevice(device: Device, devicesPerWallet: number): Promise<void> {
    this.devices.delete(device.deviceKey);
    this.devices.set(device.deviceKey, device);
    const theirs = [...this.devices.values()].filter((entry) => entry.wallet === device.wallet);
    for (const oldest of theirs.slice(0, Math.max(0, theirs.length - devicesPerWallet))) {
      this.devices.delete(oldest.deviceKey);
    }
    return this.saveDevices();
  }

  removeDevice(deviceKey: string): boolean {
    return this.devices.delete(deviceKey);
  }

  secretCount(market: string): number {
    return this.secretsOf(market).length;
  }

  /** Each wallet and quest week that has a credit. */
  creditedWeeks(): { wallet: string; week: number }[] {
    const seen = new Map<string, { wallet: string; week: number }>();
    for (const { wallet, week } of this.credits) seen.set(`${wallet}|${week}`, { wallet, week });
    return [...seen.values()];
  }

  dropDevicesEndedBy(nowMs: number): boolean {
    let dropped = false;
    for (const [key, device] of this.devices) {
      if (device.untilMs <= nowMs) {
        this.devices.delete(key);
        dropped = true;
      }
    }
    return dropped;
  }

  saveDevices(): Promise<void> {
    return this.devicesFile.save({ devices: [...this.devices.values()] });
  }

  secret(secret: string): StoredSecret | undefined {
    return this.secrets.get(secret);
  }

  secretsOf(market: string): StoredSecret[] {
    return [...this.secrets.values()].filter((entry) => entry.market === market);
  }

  secretsOfWalletBetween(wallet: string, fromMs: number, toMs: number): number {
    return [...this.secrets.values()].filter(
      (entry) =>
        entry.wallet === wallet && entry.receivedAtMs >= fromMs && entry.receivedAtMs < toMs,
    ).length;
  }

  addSecret(entry: StoredSecret): void {
    this.secrets.set(entry.secret, entry);
  }

  dropSecretsBefore(cutoffMs: number): boolean {
    let dropped = false;
    for (const [key, entry] of this.secrets) {
      if (entry.receivedAtMs < cutoffMs) {
        this.secrets.delete(key);
        dropped = true;
      }
    }
    return dropped;
  }

  saveSecrets(): Promise<void> {
    return this.secretsFile.save({ secrets: [...this.secrets.values()] });
  }

  /** False when this wallet already has that fill. */
  addCredit(credit: Credit): boolean {
    const key = creditKey(credit.wallet, credit.market, credit.sequence);
    if (this.creditKeys.has(key)) return false;
    this.creditKeys.add(key);
    this.credits.push(credit);
    return true;
  }

  creditsOf(wallet: string): Credit[] {
    return this.credits.filter((credit) => credit.wallet === wallet);
  }

  dropCreditsBeforeDay(utcDay: number): boolean {
    const kept = this.credits.filter((credit) => credit.utcDay >= utcDay);
    if (kept.length === this.credits.length) return false;
    for (const credit of this.credits) {
      if (credit.utcDay < utcDay) {
        this.creditKeys.delete(creditKey(credit.wallet, credit.market, credit.sequence));
      }
    }
    this.credits = kept;
    return true;
  }

  saveCredits(): Promise<void> {
    return this.creditsFile.save({
      credits: this.credits.map((credit) => ({
        ...credit,
        notionalAtoms: credit.notionalAtoms.toString(),
      })),
    });
  }

  awardsOf(wallet: string): Award[] {
    return this.awards.filter((award) => award.wallet === wallet);
  }

  addAward(award: Award): void {
    const known = this.awards.some(
      (other) =>
        other.wallet === award.wallet && other.quest === award.quest && other.week === award.week,
    );
    if (!known) this.awards.push(award);
  }

  saveAwards(): Promise<void> {
    return this.awardsFile.save({ awards: this.awards });
  }
}
