import { isIPv6 } from "node:net";

const GROUP_COUNT = 8;
/** An IPv6 network is one person's, however they rotate inside it: its first 64 bits. */
const NETWORK_GROUPS = 4;

/** The eight 16-bit groups of an IPv6 address, or null when `text` is not one. */
const groupsOf = (text: string): number[] | null => {
  if (!isIPv6(text)) return null;
  let address = text;
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(address);
  if (dotted) {
    const [, a, b, c, d] = dotted.map(Number);
    const tail = `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
    address = address.slice(0, dotted.index) + tail;
  }
  const [head, rest] = address.split("::");
  const front = head === "" ? [] : head.split(":");
  const back = rest === undefined || rest === "" ? [] : rest.split(":");
  const fill = rest === undefined ? 0 : GROUP_COUNT - front.length - back.length;
  const groups = [...front, ...Array<string>(fill).fill("0"), ...back].map((group) =>
    Number.parseInt(group, 16),
  );
  return groups.length === GROUP_COUNT ? groups : null;
};

/**
 * The address a limit counts a caller by: an IPv4-mapped IPv6 address (`::ffff:1.2.3.4`) is the
 * IPv4 address it wraps, so one person is not two askers, and any other IPv6 address is its /64
 * network, so rotating inside one's own network does not make a new asker. IPv4 and anything
 * that is not an address come back as they are.
 */
export const clientAddressOf = (address: string): string => {
  const plain = address.split("%")[0].toLowerCase();
  const groups = groupsOf(plain);
  if (!groups) return address;
  const mapped = groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff;
  if (mapped) {
    return [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff].join(".");
  }
  return `${groups
    .slice(0, NETWORK_GROUPS)
    .map((group) => group.toString(16))
    .join(":")}::/64`;
};
