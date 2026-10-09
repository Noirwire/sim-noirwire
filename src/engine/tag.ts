import { randomBytes } from "node:crypto";

export const randomTag = (): bigint => randomBytes(8).readBigUInt64BE(0);
