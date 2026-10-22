import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { PublicKey } from "@solana/web3.js";

const CODE_PATTERN = /^[A-Za-z0-9_-]{12,64}$/;

/** Who an entry names, and the id a seat opened for it is recorded under. */
export type Invitation = { ok: true; id: string } | { ok: false; reason: string };

interface Parsed {
  /** Owner keys invited by their address alone. */
  byKey: Set<string>;
  /** Per owner key, the hash of each invite code that opens a seat for it. */
  codesByOwner: Map<string, Set<string>>;
}

const hashOf = (code: string): string => createHash("sha256").update(code).digest("hex");

const isPublicKey = (text: string): boolean => {
  try {
    return new PublicKey(text).toBase58() === text;
  } catch {
    return false;
  }
};

/**
 * Reads the list. A line is `<owner key>` (invited by address) or
 * `<code> <owner key>` (an invite code that works only for that key); `#`
 * starts a comment. A line that cannot be used is reported with its number
 * and left out, which is the safe way for a mistake to fail: someone is
 * not admitted, nobody is admitted by accident.
 */
const parse = (text: string, onProblem: (line: string) => void): Parsed => {
  const byKey = new Set<string>();
  const owners = new Map<string, Set<string>>();
  const codeOwners = new Map<string, Set<string>>();
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) return;
    const where = `line ${index + 1}`;
    const words = line.split(/\s+/);
    if (words.length === 1 && isPublicKey(words[0])) {
      byKey.add(words[0]);
      return;
    }
    if (words.length === 2 && CODE_PATTERN.test(words[0]) && isPublicKey(words[1])) {
      const hash = hashOf(words[0]);
      codeOwners.set(hash, (codeOwners.get(hash) ?? new Set()).add(words[1]));
      owners.set(words[1], (owners.get(words[1]) ?? new Set()).add(hash));
      return;
    }
    onProblem(
      `the invite list has a line it cannot use (${where}). It is left out. ` +
        "Write an owner public key, or an invite code of 12 to 64 letters, digits, - or _, then a space and the owner public key.",
    );
  });
  for (const [hash, keys] of codeOwners) {
    if (keys.size < 2) continue;
    for (const key of keys) owners.get(key)?.delete(hash);
    onProblem(
      "the invite list gives one invite code to more than one owner key. That code is left out. Give each code to one owner key.",
    );
  }
  return { byKey, codesByOwner: owners };
};

/**
 * The people the gate signs for, read from a file the operator edits. The
 * file is looked at again whenever it changes, so adding or removing a line
 * needs no restart. A file that cannot be read after it once was is treated
 * as an empty list until it can be: nobody is admitted on a stale copy.
 */
export class InviteList {
  private parsed: Parsed = { byKey: new Set(), codesByOwner: new Map() };
  private seenVersion = "";
  private readable = true;

  constructor(
    private readonly path: string,
    private readonly onProblem: (line: string) => void,
  ) {
    this.refresh(true);
  }

  /** Reads the file when its size or modified time moved. Throws only when asked to, at start. */
  private refresh(atStart = false): void {
    let version: string;
    let text: string;
    try {
      const stat = statSync(this.path);
      version = `${stat.mtimeMs}:${stat.size}`;
      if (version === this.seenVersion && this.readable) return;
      text = readFileSync(this.path, "utf8");
    } catch {
      const reason =
        "the invite list file cannot be read, so nobody is admitted until it can be. " +
        "Check GATE_INVITES_FILE is mounted into the service and readable by it (an empty file is fine).";
      if (atStart) throw new Error(reason);
      if (this.readable) this.onProblem(reason);
      this.readable = false;
      this.parsed = { byKey: new Set(), codesByOwner: new Map() };
      this.seenVersion = "";
      return;
    }
    this.readable = true;
    this.seenVersion = version;
    this.parsed = parse(text, this.onProblem);
  }

  /** Whether `owner` may be given a seat, and under which invite. `code` is what the person sent, if anything. */
  check(owner: string, code: string | undefined): Invitation {
    this.refresh();
    if (!this.readable) {
      return {
        ok: false,
        reason: "the invite list cannot be read right now. Nobody is admitted: try again later",
      };
    }
    const codes = this.parsed.codesByOwner.get(owner);
    if (code !== undefined) {
      const hash = hashOf(code);
      return codes?.has(hash)
        ? { ok: true, id: `code:${hash}` }
        : {
            ok: false,
            reason: "the invite code does not match this address. Check it and try again",
          };
    }
    if (this.parsed.byKey.has(owner)) return { ok: true, id: `key:${owner}` };
    if (codes && codes.size > 0) {
      return {
        ok: false,
        reason: "this address is invited with a code. Send the invite code you were given",
      };
    }
    return {
      ok: false,
      reason: "this address is not on the invite list. Ask for an invite, then try again",
    };
  }
}
