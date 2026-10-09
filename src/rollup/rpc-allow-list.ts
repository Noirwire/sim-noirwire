const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "host.docker.internal"]);

const sameEndpoint = (a: URL, b: URL): boolean => a.protocol === b.protocol && a.host === b.host;

/**
 * The load test sends real transactions, so it runs only against endpoints
 * that were named on purpose: this machine by default, anything else only
 * when its URL was passed in `allowed`. Throws on the first URL that is not.
 */
export const requireAllowedRpc = (urls: string[], allowed: string[]): void => {
  const allowedUrls = allowed.map((url) => new URL(url));
  for (const url of urls) {
    const parsed = new URL(url);
    const isLocal = LOCAL_HOSTS.has(parsed.hostname);
    if (!isLocal && !allowedUrls.some((entry) => sameEndpoint(entry, parsed))) {
      throw new Error(
        `${parsed.origin} is not on the allow-list. Pass --allow-rpc ${parsed.origin} to send load there on purpose.`,
      );
    }
  }
};
