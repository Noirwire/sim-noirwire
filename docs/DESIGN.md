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
}
```

Prices and sizes cross this boundary as integers (`bigint`), never floats.

## HTTP and websocket API (prefix `/v1`)

| Route | Returns |
| --- | --- |
| `GET /health` | `{ ok, venue, network, awake }`; with `VENUE=rollup` also `connected`, `pricesFresh`, `botsFunded`, a `reason` while something is missing, and 503 until the start-up work is done, the bots are funded and, while awake, the other two hold. While awake it also carries `trading: { ready, reason? }`, not ready while a maker is stopped or held by an order of unknown outcome, or its hedge is blind (a hedge hold nothing has explained for 2 minutes counts as blind); it never changes the status code, so a probe does not restart the process for it. The service raises one alert when it turns not ready and a notice when it recovers (through the maker's alert voice). A `lagging` hedge counts as ready, and the price crank is not covered. The liquidation keeper is, through the heartbeat file named by `KEEPER_HEARTBEAT_FILE` (stale, missing or malformed is not ready; unset is not ready on mainnet only). Never wakes the service |
| `GET /deployment` | `VENUE=rollup` only, public, cacheable for five minutes. What a browser needs to trade on the program directly: `network`, `programId`, `solanaRpcUrl`, `rollupRpcUrl`, `rollupWsUrl` (the URLs a browser should use), `exchange`, `stats`, and per market `marketId` (the on-chain id), `symbol`, `kind`, `market`, `tape`, `priceFeed`, `baseToken` and `quoteToken` (`symbol`, `mint`, `decimals`; `baseToken` is null on a perpetual), `baseDecimals`, `quoteDecimals`, `lotSize` (base atoms per lot) and `tick` (quote atoms per lot), both as decimal text. No key and no role address |
| `GET /markets` | per market: id, kind, names, tick, lot, max leverage, mark price, 24h change, 24h volume, open interest, `warmingUp` (true with `VENUE=rollup` while the service wakes) |
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
(`@noirwire/orderbook`, a release file under `vendor/`). Everything else sees the plain
types of `src/rollup/chain-types.ts`, so a new client release is an edit to that one file.

- **Prices.** The service reads the mark from each market's price feed on chain and
  never sets it: on a test network whoever holds the oracle key publishes it, on a
  mainnet-profile deployment a crank syncs it from Pyth. `/v1/health` calls prices fresh
  while every followed market's mark is within that market's own age limit. Funding is
  advanced by the program's own schedule.
- **Which markets.** Only the markets the deployment description has are followed, under
  this service's id (`SOL-PERP` of a mainnet-profile deployment is followed as
  `NSOL-PERP`, its `USDC` counted as nUSD). The bots quote on those alone.
- **A network that fails or goes silent.** Every request to the rollup is given up after a
  few seconds. So a request that is never answered costs its loop one turn, not all of
  them: the chain feed, the bots and the liquidator each try again on their next tick.
  Two full reads of the public accounts failing in a row count as the rollup being away:
  the service rests and wakes again. A key's signed-in
  connection is made afresh after any failure on it, since a token can expire silently.
  `/v1/health` turns 503 while the network is away and 200 again within seconds of its
  return, with no restart. The integration suite cuts the service's network (refused,
  then silent) and asserts exactly that. A stop never waits on the network for more than
  twenty seconds.
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
  balance, never above it, so a restart does not pay them twice. On a deployment without
  a faucet nothing is deposited: a bot counts as funded once it holds any collateral, and
  start-up waits, naming the owner key, until the operator has deposited some. Every
  resting quote carries an expiry of its own, the maker's requote interval plus 10 s. A
  resting quote the program refuses is logged by its error number and name with the
  seat's owner key (`MakerNotListed`, 6091, also names `set_seat_access`, which the
  exchange admin lists the seat with): once, then once a minute, until one goes through.
- **When a market will not take quotes.** The feed also reads each market's status,
  oracle health and position cap, and the exchange's pause and USDC guard. While a market
  would refuse a resting order that adds exposure (a stale mark, paused, reduce-only,
  dislocated, the exchange paused or its USDC guard tripped), the house maker holds its
  quotes: it sends nothing and logs why (a reduce-only market first cancels what stands,
  once, since only a flatten may trade there), and requotes on its first tick
  after the market takes quotes again. Each side of its ladder stops at the market's
  position cap, which counts the position on that side, the open orders there and the
  new order together.
- **Which bots.** A house maker per followed market always; the noise takers and the
  liquidator only with `NOISE_TAKERS_ENABLED` and `LIQUIDATOR_ENABLED` (both on by
  default, and refused on a deployment without a faucet, which could not fund them).
- **Funding.** The program's own schedule advances it: `update_funding` does nothing and
  succeeds while the price is stale, so a scheduled task keeps running. This service does
  not call it.
- **Liquidation.** Nobody can read the ledger, so the liquidator tries a few seat numbers
  per tick, blind. An attempt on an empty seat reads the same as one on a healthy trader,
  so the sweep cannot see where the occupied seats end. It walks as many seats as this
  service ever opened (its bots plus every user it funded; seats fill from the lowest
  number) and starts over. Seats opened with the gate key by anything else lie outside it.
  A liquidation adds nothing to the public order, fill or volume counters.
- **Public data.** The tape, the price feeds, the markets, the exchange and the stats are
  read from the chain over the rollup's websocket, anonymously, and re-read in full every
  minute. Fills are
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
- **Health.** `/v1/health` answers 200 only when the start-up work is done and every bot
  is open and funded and, while the service is awake, the public accounts were read in the
  last 45 seconds and every followed market's mark on chain is within its age limit. An
  asleep service reads nothing, so stale prices do not count against it;
  the answer carries `awake`, and `reason` while start-up or a wake keeps failing. The
  route never wakes the service.
- **Awake and asleep.** A hosted endpoint blocks a client that never stops asking, so the
  service sends to the rollup only while somebody wants it to. `src/activity/activity.ts`
  is the state machine: `asleep`, `waking`, `awake`. A request to any route but
  `/v1/health` (an `onRequest` hook in `src/http/server.ts`; a path that matches no route
  is not one) and an open `/v1/stream` socket ask for activity. The first one moves it
  from asleep to waking and the request goes on without waiting. Waking is the lifecycle
  in `src/app.ts`: wait for the start-up work, then `RollupVenue.resume()` (read every
  public account, subscribe) and start the bots' loops. A wake that fails is
  retried after 5 s, 10 s, ... up to 5 minutes while it is still wanted. While it runs,
  `/v1/markets` shows every market as `warmingUp`. The service stays awake while a socket
  is open and `IDLE_AFTER_MS` (10 minutes) after the last request or the last socket
  closing; then it sleeps: the bots' loops stop, the chain feed's websocket is ended and
  its reads stop, each bot's client lets go of its websocket and timer, and each key's
  connection is opened afresh at the next use (a token may have run out). Snapshots keep
  being saved. No price source runs with `VENUE=rollup`. The service
  starts asleep once its start-up work is done. `VENUE=memory` sends nothing outside the
  process and holds itself awake.
- **Cost while awake.** The makers requote a market every 90 s or when its mark moves
  12 bps, with quotes valid for 180 s; where enabled, two of the six takers trade and the
  liquidator tries 2 seats a minute; the chain feed re-reads every account once a minute
  under the websocket. The bots' view subscriptions share one backoff (`bot-socket.ts`).
- **Generations.** Each wake is a generation (`generation.ts`) that ends when the service
  goes to sleep, after the reads in flight have had two seconds to end.
  Every connection of the gate, the faucet, the chain feed and the bots is
  made for one generation: once it ends a request in flight is aborted and a later one
  is not sent, so a confirmation loop or an order's result poll stops whatever code runs
  it. A bot's connection does not even answer a later request, which ends the order
  client's own retry loop instead of leaving it to spin on refusals. The bots are let go
  of, not paused: the next call opens a new trader for the new generation from the order
  key checkpoint of the old one, so nothing waits behind an old order's unsettled
  promise, and a sign-in that finishes after the sleep installs nothing. The venue's
  calls for a bot are refused while it rests and rejected the moment their generation
  ends.
- **The fund desk.** Only on a deployment with a faucet; without one the fund routes
  answer 503. One call at a time; a throw, or an answer that the rollup refused
  or could not be reached, stops the desk being asked for 5 s. A submit for a transaction
  `prepare` made is not turned away by the per-IP limit that `prepare` paid.
- **A rollup that refuses.** The HTTP API starts before the rollup is reached. The
  start-up work (network check, reading the markets, the first read of the public
  accounts, opening and funding the bots) is retried after 5 s, doubling to 5 minutes;
  every step of it is safe to repeat. Until it is done `/v1/markets`, `/v1/deployment` and
  the fund routes answer 503 and `/v1/health` answers 503 with the reason; tape, candles
  and stats come from the snapshot. Only a `SOLANA_RPC_URL` on the wrong network ends the process: mainnet without
  `NETWORK=mainnet`, or `NETWORK=mainnet` on anything but mainnet (`NetworkMismatch`). The
  rollup websocket waits 5 s before its first reconnect and twice as long after each
  refusal, up to 5 minutes (`backOffReconnects`), and a loop that fails repeatedly skips
  turns, at most 30 s apart. A failing thing is logged when it starts failing, as a
  summary a minute while it goes on, and when it works again (`ProblemLog`).
  A rollup that starts refusing an awake service is caught by the chain feed: two full
  reads in a row that fail make the service rest and wake again, so the wake's retry (5 s
  doubling to 5 minutes, only while wanted) sends one probe at a time instead of every
  loop backing off alone.

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
