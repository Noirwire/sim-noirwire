import { Connection, type FetchFn } from "@solana/web3.js";
import { ROLLUP_BACKOFF, backoffDelayMs } from "../scheduling/backoff.js";
import type { Generation } from "./generation.js";
import { REQUEST_TIMEOUT_MS, fetchWithin } from "./timeouts.js";
import { ProgramRefused } from "./transactions.js";

/** The reconnecting websocket web3.js 1.99.0 keeps to itself: only what the backoff needs of it. */
interface ReconnectingSocket {
  on(event: "open" | "close" | "error", listener: () => void): unknown;
  setReconnectInterval(intervalMs: number): void;
}

/**
 * Makes a connection's websocket wait longer after each failed reconnect.
 * web3.js retries every second for ever, which against an endpoint that
 * refuses us is a request a second; this makes it 5 s, 10 s, 20 s and so on
 * up to 5 minutes, and back to 5 s once a socket has opened.
 *
 * Invariant: the retry timer reads the interval when it is set, which is
 * before the socket's `close` or `error` event reaches these listeners, so
 * the interval set here is the one the retry after the next failure waits.
 * A socket that never opened reports an `error` and no `close`; one that
 * opened reports a `close`, so each failure is counted once.
 */
export const backOffReconnects = (connection: Connection): void => {
  const socket = (connection as unknown as { _rpcWebSocket: ReconnectingSocket })._rpcWebSocket;
  let failures = 0;
  let open = false;
  const failed = (): void => {
    failures += 1;
    socket.setReconnectInterval(backoffDelayMs(failures + 1));
  };
  socket.setReconnectInterval(ROLLUP_BACKOFF.baseMs);
  socket.on("open", () => {
    open = true;
    failures = 0;
    socket.setReconnectInterval(ROLLUP_BACKOFF.baseMs);
  });
  socket.on("error", () => {
    if (!open) failed();
  });
  socket.on("close", () => {
    open = false;
    failed();
  });
};

/**
 * A connection whose every request is given up after `REQUEST_TIMEOUT_MS` and
 * whose websocket, if it opens one, backs off when the endpoint refuses it.
 * It belongs to `life`: once that generation ends, a request in flight is
 * aborted and a later one is refused without being sent (or, with
 * `hangWhenEnded`, never answered), so whatever polls on the connection, a
 * confirmation or an order's result, stops sending whatever code runs it.
 */
export const connectionTo = (
  rpcUrl: string,
  wsUrl?: string,
  life?: Generation,
  hangWhenEnded = false,
): Connection => {
  const connection = new Connection(rpcUrl, {
    commitment: "confirmed",
    wsEndpoint: wsUrl,
    fetch: fetchWithin(REQUEST_TIMEOUT_MS, undefined, life, hangWhenEnded) as FetchFn,
  });
  backOffReconnects(connection);
  return connection;
};

/** The parts of a connection's websocket that web3.js 1.99.0 keeps to itself and offers no way to end. */
interface WebsocketInternals {
  _updateSubscriptions(): Promise<void>;
  _rpcWebSocketHeartbeat: ReturnType<typeof setInterval> | null;
  _rpcWebSocket: {
    reconnect_timer_id?: ReturnType<typeof setTimeout>;
    setAutoReconnect(reconnect: boolean): void;
    close(): void;
  };
}

/**
 * Ends a connection's websocket for good: its subscriptions are dropped where
 * they stand, the socket is closed and nothing opens another. The connection
 * still answers requests.
 *
 * Invariant: the listeners are never removed one by one on the way out.
 * `removeAccountChangeListener` on a socket that is closing but has not said
 * so yet retries its unsubscribe request without ever yielding, which holds
 * the event loop until the process runs out of memory.
 */
export const hangUp = (connection: Connection): void => {
  const internals = connection as unknown as WebsocketInternals;
  internals._updateSubscriptions = async () => {};
  if (internals._rpcWebSocketHeartbeat) clearInterval(internals._rpcWebSocketHeartbeat);
  internals._rpcWebSocketHeartbeat = null;
  const socket = internals._rpcWebSocket;
  socket.setAutoReconnect(false);
  clearTimeout(socket.reconnect_timer_id);
  socket.close();
};

const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";

/** Solana is not the network the service was told to run on. No wait cures it: the service does not start. */
export class NetworkMismatch extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NetworkMismatch";
  }
}

/**
 * Stops the service before it sends anything if Solana is not the network
 * it was told to run on. NETWORK=mainnet needs mainnet; any other network
 * moves test tokens only and must not be mainnet.
 */
export const requireNetwork = async (mainnet: boolean, solanaRpcUrl: string): Promise<void> => {
  const genesis = await connectionTo(solanaRpcUrl).getGenesisHash();
  const isMainnet = genesis === MAINNET_GENESIS;
  if (mainnet && !isMainnet) {
    throw new NetworkMismatch(
      `NETWORK=mainnet, but SOLANA_RPC_URL is not Solana mainnet (its genesis hash is ${genesis}). ` +
        "Point SOLANA_RPC_URL at a mainnet endpoint, or change NETWORK.",
    );
  }
  if (!mainnet && isMainnet) {
    throw new NetworkMismatch(
      "SOLANA_RPC_URL is Solana mainnet, but NETWORK is not mainnet, and without it this service " +
        "moves test tokens only. Set NETWORK=mainnet to run the mainnet mode, or point SOLANA_RPC_URL at a test network.",
    );
  }
};

/**
 * A key's connection, opened again after anything went wrong with it: a
 * sign-in token can expire and a connection can die, and neither says so.
 */
export class Session {
  private current: Promise<Connection> | null = null;

  constructor(private readonly open: () => Promise<Connection>) {}

  static of(connection: Connection): Session {
    return new Session(async () => connection);
  }

  connection(): Promise<Connection> {
    this.current ??= this.open().catch((error: unknown) => {
      this.current = null;
      throw error;
    });
    return this.current;
  }

  /** Opens a new connection on the next use: a sign-in token may have run out while nothing used it. */
  renew(): void {
    this.current = null;
  }

  /** Runs `work` on the connection, and opens a new one next time unless the program itself gave the answer. */
  async use<T>(work: (connection: Connection) => Promise<T>): Promise<T> {
    try {
      return await work(await this.connection());
    } catch (error) {
      if (!(error instanceof ProgramRefused)) this.current = null;
      throw error;
    }
  }
}
