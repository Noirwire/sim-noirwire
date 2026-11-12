import { createPublicKey, verify } from "node:crypto";
import { bytesOfBase58 } from "../rollup/base58.js";

const ED25519_PUBLIC_KEY_BYTES = 32;
const ED25519_SIGNATURE_BYTES = 64;
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export interface DeviceConsent {
  wallet: string;
  deviceKey: string;
  until: string;
  challenge: string;
}

export interface QuestOrderEntry {
  market: string;
  secret: string;
}

export interface QuestOrderBatch {
  deviceKey: string;
  signedAt: number;
  orders: readonly QuestOrderEntry[];
}

/** The text a wallet signs to switch quest recording on for one device. */
export const deviceConsentText = ({ wallet, deviceKey, until, challenge }: DeviceConsent): string =>
  [
    "Earn MagicBlock quest points on this device. While on, NoirWire records which of your trades count toward quests.",
    `Wallet: ${wallet}`,
    `Device key: ${deviceKey}`,
    `Until: ${until}`,
    `Code: ${challenge}`,
  ].join("\n");

/** The text a device key signs to hand over the secrets of its latest orders. */
export const questOrdersText = ({ deviceKey, signedAt, orders }: QuestOrderBatch): string =>
  [
    "NoirWire quest orders",
    deviceKey,
    String(signedAt),
    ...orders.map(({ market, secret }) => `${market} ${secret}`),
  ].join("\n");

export interface DeviceOff {
  deviceKey: string;
  signedAt: number;
}

/** The text a device key signs to switch itself off. */
export const deviceOffText = ({ deviceKey, signedAt }: DeviceOff): string =>
  ["NoirWire quest device off", deviceKey, String(signedAt)].join("\n");

/** Whether `signature` (base58) is `publicKey`'s (base58) ed25519 signature of the UTF-8 `text`. */
export const signatureMatches = (publicKey: string, text: string, signature: string): boolean => {
  const key = bytesOfBase58(publicKey);
  const signed = bytesOfBase58(signature);
  if (key?.length !== ED25519_PUBLIC_KEY_BYTES || signed?.length !== ED25519_SIGNATURE_BYTES) {
    return false;
  }
  try {
    const keyObject = createPublicKey({
      key: Buffer.concat([SPKI_ED25519_PREFIX, key]),
      format: "der",
      type: "spki",
    });
    return verify(null, Buffer.from(text, "utf8"), keyObject, signed);
  } catch {
    return false;
  }
};
