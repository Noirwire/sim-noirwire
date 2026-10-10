import { Connection, type FetchFn } from "@solana/web3.js";
import { REQUEST_TIMEOUT_MS, fetchWithin } from "./timeouts.js";
import { ProgramRefused } from "./transactions.js";

/** A connection whose every request is given up after `REQUEST_TIMEOUT_MS`. */
export const connectionTo = (rpcUrl: string, wsUrl?: string): Connection =>
  new Connection(rpcUrl, {
    commitment: "confirmed",
    wsEndpoint: wsUrl,
    fetch: fetchWithin(REQUEST_TIMEOUT_MS) as FetchFn,
  });

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

/** This service moves test tokens only. It stops before sending anything if Solana is mainnet. */
export const refuseMainnet = async (solanaRpcUrl: string): Promise<void> => {
  const genesis = await connectionTo(solanaRpcUrl).getGenesisHash();
  if (genesis === MAINNET_GENESIS) {
    throw new Error("SOLANA_RPC_URL is mainnet. This service never runs there.");
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
