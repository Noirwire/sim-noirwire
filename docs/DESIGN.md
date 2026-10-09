# NoirWire simulation service: design

One always-on Node service that makes the test-network order book feel alive and
measurable. It never runs against a real-money network.

## What it does

1. **Prices in.** Reads real prices (Jupiter price API, no key) and writes them to the
   order book's price feeds.
2. **Market makers.** Bots that keep each market quoted around the live price, and a few
   takers that trade through the quotes so the tape moves.
3. **Fund button.** An HTTP endpoint that gives a new trader 5,000 test dollars, once.
4. **Public data.** Markets, tape, candles and counters over HTTP and one websocket, so a
   browser needs no blockchain connection to draw the public parts of the terminal.
5. **Load test.** A command, run by hand, that measures orders per second and time to
   confirmation and writes a report.

## Markets

| Id | Kind | Mirrors | Quote |
| --- | --- | --- | --- |
| `NSOL-PERP` | perpetual | SOL | nUSD |
| `NNVDA-PERP` | perpetual | NVDAx (tokenized NVIDIA) | nUSD |
| `NSOL-NUSD` | spot | SOL | nUSD |

Names are test names on purpose. Prices are real, the tokens are not.

## The venue port

Everything talks to the order book through one interface, `Venue`. Two implementations:

- `MemoryVenue`: a small in-process matching engine with the same rules (price-time
  priority, spot and perp, cross margin, taker fee, funding, liquidation). Used by tests,
  by local development and until the on-chain program is ready.
- `RollupVenue`: the real program through its TypeScript client. Added when the client
  exists. Selected with `VENUE=rollup`.

```ts
type MarketId = string;
type Side = "buy" | "sell";
type OrderType = "limit" | "postOnly" | "ioc" | "market";

interface Venue {
  markets(): Promise<MarketInfo[]>;
  publishPrice(market: MarketId, price: bigint, publishedAtMs: number): Promise<void>;
  openTrader(trader: TraderKey): Promise<void>;
  deposit(trader: TraderKey, token: string, amount: bigint): Promise<void>;
  placeOrder(trader: TraderKey, order: NewOrder): Promise<PlaceResult>;
  cancelAll(trader: TraderKey, market: MarketId): Promise<number>;
  traderState(trader: TraderKey): Promise<TraderState>;
  updateFunding(market: MarketId): Promise<void>;
  liquidate(liquidator: TraderKey, target: string, market: MarketId): Promise<boolean>;
  onFill(listener: (fill: Fill) => void): () => void;
  stats(): Promise<VenueStats>;
}
```

Prices and sizes cross this boundary as integers (`bigint`), never floats.

## HTTP and websocket API (prefix `/v1`)

| Route | Returns |
| --- | --- |
| `GET /health` | `{ ok, venue, network }` |
| `GET /markets` | per market: id, kind, names, tick, lot, max leverage, mark price, 24h change, 24h volume, open interest |
| `GET /tape?market=&limit=` | latest fills: price, size, taker side, time, sequence |
| `GET /candles?market=&interval=1m\|5m\|15m\|1h&limit=` | open, high, low, close, volume, start time |
| `GET /stats` | orders, fills, volume, traders, latency (median, p99, sample size, where measured), updated at |
| `POST /fund` `{ address }` | `{ amount, reference }`; one grant per address, rate limited per IP |
| `WS /stream` | `price`, `fill`, `candle`, `stats` messages; a client subscribes per market |

Every volume, trader and latency figure in a response carries `network: "devnet"` and
`simulated: true` where bots produced it. Bot volume and user volume are counted
separately and never merged into one number.

## Honesty rules

- The market makers are ours and are named as ours in the API (`makers: "house"`).
- A latency figure states where it was measured from.
- Nothing here is presented as user activity unless a user did it.

## Deployment

One Railway service, one replica (the fund limits and candles live in memory, with a
small JSON snapshot on a volume so a restart keeps candles). Configuration by
environment variables only; secrets are never logged.
