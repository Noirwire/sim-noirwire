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
- `RollupVenue`: the real program through its TypeScript client. Selected with
  `VENUE=rollup`. See "The rollup venue" below.

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
| `GET /health` | `{ ok, venue, network }`; with `VENUE=rollup` also `connected`, `pricesFresh`, `botsFunded`, and 503 until all three hold |
| `GET /markets` | per market: id, kind, names, tick, lot, max leverage, mark price, 24h change, 24h volume, open interest |
| `GET /tape?market=&limit=` | latest fills: price, size, taker side, time, sequence |
| `GET /candles?market=&interval=1m\|5m\|15m\|1h&limit=` | open, high, low, close, volume, start time |
| `GET /stats` | orders, fills, volume, traders, latency (median, p99, sample size, where measured), updated at |
| `POST /fund` `{ address }` | `VENUE=memory` only. `{ amount, reference }`; one grant per address, rate limited per IP |
| `POST /fund/prepare` `{ owner, orderKeys[4] }` | `VENUE=rollup` only. `{ transaction, expiresAtMs, amount }`: the unsigned transaction that opens the account and deposits the grant |
| `POST /fund/submit` `{ owner, transaction }` | `VENUE=rollup` only. `{ amount, reference }` once the transaction executed; `reference` is its signature |
| `WS /stream` | `price`, `fill`, `candle`, `stats` messages; a client subscribes per market |

Every volume, trader and latency figure in a response carries `network: "devnet"` and
`simulated: true` where bots produced it. Bot volume and user volume are counted
separately and never merged into one number.

## Honesty rules

- The market makers are ours and are named as ours in the API (`makers: "house"`).
- A latency figure states where it was measured from.
- Nothing here is presented as user activity unless a user did it.

## The rollup venue

`src/rollup/program.ts` is the only module that imports the order book client
(`@noirwire/orderbook`, a release file under `vendor/`). Everything else sees its plain
types, so a new client release is an edit to that one file.

- **Prices.** The oracle key publishes every market's price every two seconds, stamped
  with the rollup's own clock. The program refuses a price more than its move limit from
  the last one, so a larger real move is walked there one allowed step per publish. A
  refused publish is logged and the next one is tried.
- **Bots.** Each bot is an ordinary trader: its own seat, its own private view, one-time
  order keys. Its owner key comes from its seed; its order keys are drawn fresh at every
  start and written to its view. Bots are topped up from the faucet to their starting
  balance, never above it, so a restart does not pay them twice. Every resting quote
  carries a 30 second expiry of its own. Funding is advanced by the rollup's scheduler;
  `updateFunding` sends the instruction only for a market that has none scheduled.
- **Liquidation.** Nobody can read the ledger, so the liquidator tries a few seat numbers
  per tick, blind, and starts over after a long run of empty seats.
- **Public data.** The tape, the price feeds and the stats are read from the chain over
  the rollup's websocket, anonymously, and re-read in full every five seconds. Fills are
  followed by sequence number, so a dropped notification is filled in from the tape
  account and nothing is recorded twice. `/v1/markets`, `/v1/tape`, `/v1/candles` and the
  outgoing websocket are fed from that and from nothing this process remembers sending.
- **Bot or user.** A fill names nobody. A bot's side is recognised by recomputing its
  receipt from the secret of an order a bot placed. A fill counts as bot activity only
  when both sides are bots; anything else has a user on a side. User orders are the
  chain's order count less the bots' own.
- **Latency.** `/v1/stats` reports the time from a bot's send to the result showing in
  its private view, labelled with `SERVICE_LOCATION`.
- **Health.** `/v1/health` answers 200 only when the public accounts were read in the
  last 15 seconds, every market's price on chain is fresh and was published by this
  process, and every bot is open and funded.

### Funding a user

Two steps, one transaction:

1. `POST /v1/fund/prepare` with the user's owner key and four order keys. The service
   builds one transaction, open the account then deposit 5,000 nUSD of collateral from
   the faucet, and returns it unsigned (base64). It is valid for 45 seconds.
2. The user signs it with the owner key and sends it to `POST /v1/fund/submit`. The
   service checks the message is byte for byte the one it built and that the owner's
   signature is valid, adds the gate's and the faucet's signatures, sends it, and answers
   once it executed. Opening and funding succeed or fail together.

One grant per owner address and the per-IP limit apply to both steps.

A deposit names a seat by number, and the program does not tell anyone but the owner
which seat a new account got. It does give out the lowest free seat. So `prepare` finds
that seat first, by blind liquidation attempts whose result says only whether a seat is
open, and the deposit names it. If the seat is taken in between, the deposit fails and
the whole transaction with it: nothing is opened, and the user prepares again. This is
safe only while this process is the only holder of the gate key, which is one reason for
one replica. The search is one attempt per open seat on the first request after a start
and one or two afterwards.

### Local run in Docker

`make docker-up` starts the local network on this machine, from the order book
repository's Makefile, sets it up, then starts this service in a container
(`compose.yaml`, project `noirwire-sim`) that reaches the network through
`host.docker.internal`. `--profile terminal` adds the trading terminal from
`../terminal-noirwire`.

The network is not in a container. MagicBlock ships its rollup and query filter for Linux
on arm64 and x64, but the Solana test validator underneath has no Linux arm64 release, and
Docker on an Apple machine is arm64. Running the whole network as an emulated x64
container was not tried.

## Deployment

One Railway service, one replica (the fund limits and candles live in memory, with a
small JSON snapshot on a volume so a restart keeps candles and does not count the same
fills twice). Configuration by environment variables only; secrets are never logged.
Steps: [deploy.md](deploy.md).
