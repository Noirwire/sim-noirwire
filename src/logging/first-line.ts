const HIDDEN = "[private address]";

/** Text that must not appear in a log line or an answer: private endpoints that may carry a key. */
let hidden: string[] = [];

/** The parts of an endpoint address that may be a key, and the address itself in the forms an error prints it. */
const secretsOf = (address: string): string[] => {
  if (!URL.canParse(address)) return [address];
  const url = new URL(address);
  return [
    address,
    url.href,
    url.pathname,
    url.search,
    url.search.slice(1),
    url.username,
    url.password,
  ].filter((part) => part.length > 1);
};

/**
 * From now on `firstLine` replaces these addresses, and the key-carrying
 * parts of them, with a placeholder. Every error text the service logs or
 * serves goes through it, so a library's error that quotes the endpoint it
 * called does not leak it.
 */
export const hideAddresses = (addresses: string[]): void => {
  hidden = addresses.flatMap(secretsOf).sort((a, b) => b.length - a.length);
};

/** The first line of an error's message, or of whatever else was thrown. */
export const firstLine = (error: unknown): string => {
  const line = error instanceof Error ? error.message.split("\n")[0] : String(error ?? "");
  return hidden.reduce((text, secret) => text.split(secret).join(HIDDEN), line);
};
