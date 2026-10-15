import { backoffDelayMs } from "../scheduling/backoff.js";

/** The part of a websocket the order book client uses; the client's own type has this shape. */
export interface Socket {
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
}

export type SocketFactory = (url: string) => Socket;

/** The id the client gives its account subscription request, and so its answer. */
const SUBSCRIBE_ID = 1;

/** A socket that fails at once without touching the network, for the client's own retry to find. */
const refusedSocket = (): Socket => {
  const socket: Socket = {
    send: () => {},
    close: () => {},
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  };
  setTimeout(() => socket.onerror?.(), 0);
  return socket;
};

/** Whether `data` is the endpoint's answer to the account subscription: "accepted" or "refused". */
const subscriptionAnswer = (data: unknown): "accepted" | "refused" | null => {
  if (typeof data !== "string") return null;
  try {
    const message = JSON.parse(data) as { id?: unknown; error?: unknown };
    if (message.id !== SUBSCRIBE_ID) return null;
    return message.error ? "refused" : "accepted";
  } catch {
    return null;
  }
};

/**
 * The bots' view subscriptions retry every 250 ms to 5 s on their own, which
 * against an endpoint that refuses us is several connections a second from
 * ten clients. This wraps the socket they open so that, after a socket the
 * endpoint refused, none is opened for 5 s, then 10 s, 20 s and so on up to 5
 * minutes, whichever client asks. Until the wait is over a client's attempt
 * fails locally and costs no request.
 *
 * A socket is refused when it fails or closes before the endpoint accepted
 * its subscription, or when the endpoint answers the subscription with an
 * error: a socket that opens and is then turned away is as much a refusal
 * as one that never opens. Once a subscription was accepted the socket is
 * good, and a later drop is no refusal: the next one is opened at once.
 */
export const backedOffSockets = (
  open: SocketFactory,
  now: () => number = () => Date.now(),
): SocketFactory => {
  let refusals = 0;
  let notBeforeMs = 0;

  return (url) => {
    if (now() < notBeforeMs) return refusedSocket();
    const inner = open(url);
    let accepted = false;
    let counted = false;
    const refused = (): void => {
      if (accepted || counted) return;
      counted = true;
      refusals += 1;
      notBeforeMs = now() + backoffDelayMs(refusals);
    };
    const watched: Socket = {
      send: (data) => inner.send(data),
      close: () => inner.close(),
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
    };
    inner.onopen = () => watched.onopen?.();
    inner.onmessage = (event) => {
      const answer = subscriptionAnswer(event.data);
      if (answer === "accepted") {
        accepted = true;
        refusals = 0;
        notBeforeMs = 0;
      } else if (answer === "refused") {
        refused();
      }
      watched.onmessage?.(event);
    };
    inner.onclose = () => {
      refused();
      watched.onclose?.();
    };
    inner.onerror = () => {
      refused();
      watched.onerror?.();
    };
    return watched;
  };
};
