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
| `GET /deployment` | `VENUE=rollup` only, public, cacheable for five minutes. What a browser needs to trade on the program directly: `network`, `programId`, `solanaRpcUrl`, `rollupRpcUrl`, `rollupWsUrl` (the URLs a browser should use), `exchange`, `stats`, and per market `marketId` (the on-chain id), `symbol`, `kind`, `market`, `tape`, `priceFeed`, `baseToken` and `quoteToken` (`symbol`, `mint`, `decimals`; `baseToken` is null on a perpetual), `baseDecimals`, `quoteDecimals`, `lotSize` (base atoms per lot) and `tick` (quote atoms per lot), both as decimal text. No key and no role address |
| `GET /markets` | per market: id, kind, names, tick, lot, max leverage, mark price, 24h change, 24h volume, open interest, `warmingUp` (true with `VENUE=rollup` until the chain's price has first reached the real one) |
| `GET /tape?market=&limit=` | latest fills: price, size, taker side, time, sequence, `makerTag`, `takerTag`. With `VENUE=rollup` each tag is that side's 8-byte receipt from the chain's tape, read as a big-endian unsigned integer and written as decimal text; the websocket's `fill` message carries the same two fields |
| `GET /candles?market=&interval=1m\|5m\|15m\|1h&limit=` | open, high, low, close, volume, start time |
| `GET /stats` | orders, fills, volume, traders, latency (median, p99, sample size, where measured), updated at. With `VENUE=rollup` also `botOrdersOutcomeUnknown` `{ total, settledExecutedLate, settledExpired, stillUnknown }`: bot orders, never users', whose outcome could not be told in time and what became of them |
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
- **Warming up.** A deployment starts at its set-up price, which can be far from the real
  one, and every start walks from wherever the chain's price was left. Until the chain's
  price has first come within one allowed step of the real price, the market is
  `warmingUp`: the bots place nothing on it, its price updates are not sent to the
  websocket or kept for the 24h change, any fill on it goes to the tape only and not into
  candles or counters, and `/v1/health` does not call prices fresh. So the walk never
  shows as a wick on a chart.
- **Unknown outcomes.** The client can stop waiting for an order while it may still run;
  it then says `unknown` and settles it once the rollup's clock is past the order's
  expiry. Until that settles, the bot sends nothing else (no requote, no resend), and the
  order is counted neither as placed nor as failed. It then counts as an executed order,
  late, or as expired. Cancels, syncs and liquidations wait the same way.
- **Bots.** Each bot is an ordinary trader: its own seat, its own private view, one-time
  order keys. Its owner key comes from its seed, and its order keys follow from the owner
  key. Where each bot's keys stand is saved in the snapshot (indices, no secret) and
  picked up at the next start; without a usable checkpoint the owner replaces all four
  keys. An order the client refuses before signing, or the program refuses after, comes
  back to the bot as a rejected order at once. Bots are topped up from the faucet to their starting
  balance, never above it, so a restart does not pay them twice. Every resting quote
  carries a 30 second expiry of its own.
- **Funding.** This service advances it: `update_funding` for each perpetual once per
  funding interval, sent right after a successful price publish. No rollup scheduler is
  relied on, because the instruction fails on a stale price and a scheduled task that
  met one failure is never called again. `/v1/health` counts the updates per market.
- **Liquidation.** Nobody can read the ledger, so the liquidator tries a few seat numbers
  per tick, blind. An attempt on an empty seat reads the same as one on a healthy trader,
  so the sweep cannot see where the occupied seats end. It walks as many seats as this
  service ever opened (its bots plus every user it funded; seats fill from the lowest
  number) and starts over. Seats opened with the gate key by anything else lie outside it.
  A liquidation adds nothing to the public order, fill or volume counters.
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
  its private view, as the client itself times it, labelled with `SERVICE_LOCATION`.
- **Deposits** go to the deployment's `depositUrl`: the rollup's own port on the local
  stack, the private endpoint on a hosted one. `DEPOSIT_RPC_URL` overrides it. An endpoint
  that refuses a deposit at the door is reported with its HTTP status and body.
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

A deposit names its beneficiary by owner key, so the grant can only reach the account the
same transaction opens. `submit` answers:

| Status | Meaning |
| --- | --- |
| 200 | Opened and funded |
| 400 | Not the transaction that was prepared, or the owner's signature is missing or wrong |
| 409 | This owner was funded before, or the program refused the opening (the account exists). Nothing changed |
| 410 | Nothing prepared for this owner, or prepared more than 45 seconds ago |
| 429 | Too many grants from this IP |
| 502 | The rollup endpoint refused the transaction; the body carries its HTTP status and answer |
| 503 | `daily limit reached`: the program opens only so many new seats a day (`maxSeatsPerDay`) |

### Local run in Docker

`make docker-up` starts the local network on this machine, from the order book
repository's Makefile, sets it up, then starts this service in a container
(`compose.yaml`, project `noirwire-sim`) that reaches the network through
`host.docker.internal`. `--profile terminal` adds the trading terminal from
`../terminal-noirwire`.

`make docker-up-all` puts the network in a container as well (`--profile network`):

| Container | What it is |
| --- | --- |
| `network` | `docker/network.Dockerfile`: Node 24 on Debian 13, the Solana 2.3.11 test validator and MagicBlock's stack from the order book repository's lockfile. `docker/network-entry.mjs` makes a throwaway admin key and starts the stack with the program loaded, as the order book repository's Makefile does. Healthy once the stack reports ready |
| `setup` | the same image, one shot: the order book repository's `ops/network.ts setup` against `network`, writing the deployment description and the local keys to the `noirwire-sim-deployment` volume |
| `sim` | starts once `setup` has exited successfully and reads that volume read-only |

The order book repository reaches the image as the additional build context `orderbook`
(`ORDERBOOK_REPO`): its package files, `sdk/dist`, `ops/`, the validator identity fixture
and `target/deploy/noirwire_orderbook.so` are copied in, so they must be built first.
Nothing is written back to it. Inside the compose network the containers use service
names (`http://network:8899`); the host ports are shifted (18899, 17799, 16699, 14100) so
the stack never collides with a network on the machine. Each start is a fresh network: the
entry script empties the deployment volume first.

Three things that are not obvious:

- MagicBlock's stack binds the rollup and the query filter to 127.0.0.1 with no setting
  for it, so the entry script offers those four ports on the container's own address and
  passes them through. The Solana validator already listens on every address.
- MagicBlock's Linux binaries need glibc 2.39, so the image is Debian 13, not 12.
- The set-up keeps keys readable by their owner only, so the network image runs as the
  same `node` user as the service image.

The network image is linux/amd64 on every machine. MagicBlock ships its rollup and query
filter for Linux on arm64 and x64, but the Solana test validator underneath has no Linux
arm64 release, and Docker on an Apple machine is arm64, so there the image is emulated.
Measured on an Apple M4 with Docker Desktop's Rosetta emulation (the virtual CPU reports
AVX2, which the x64 validator needs): the validator produces slots within a second,
`make docker-test-all` takes about 50 seconds with the images built, and the service's
`/v1/stats` showed a send-to-result median of 18 ms and a p99 of 99 ms over 477 bot
orders. With Rosetta switched off Docker falls back to QEMU, which was not tried.

## Deployment

One Railway service, one replica (the fund limits and candles live in memory, with a
small JSON snapshot on a volume so a restart keeps candles and does not count the same
fills twice). Configuration by environment variables only; secrets are never logged.
Steps: [deploy.md](deploy.md).
