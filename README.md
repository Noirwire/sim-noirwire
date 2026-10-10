# sim-noirwire

One always-on Node service that makes the NoirWire test-network order book feel alive and
measurable. It never runs against a real-money network: the markets are real prices on
test tokens, traded by a house market maker and a handful of noise-trading bots, with the
numbers reported over HTTP and one websocket.

Full design: [docs/DESIGN.md](docs/DESIGN.md).

## What it does

1. **Prices in.** Polls Jupiter's price API v3 (no key) for SOL and NVDAx every couple of
   seconds and publishes them to the order book.
2. **Markets.** `NSOL-PERP` and `NNVDA-PERP` (perpetuals, cross-margined, 10% initial / 5%
   maintenance margin, funding, liquidation) and `NSOL-NUSD` (spot). All three trade against
   `MemoryVenue`, an in-process matching engine with price-time priority and integer
   (`bigint`) math throughout.
3. **Bots.** A house market maker quotes a ladder on each side of the mark price, skewed
   away from its own inventory and capped at a hard position limit. A pool of noise takers
   sends small random market orders so the tape moves. A liquidator scans for
   undercollateralized accounts. A funding updater ticks the funding index.
4. **Fund button.** `POST /v1/fund` gives a new address 5,000 test dollars, once, with a
   per-IP rate limit on top.
5. **Public data.** Markets, tape, candles (1m/5m/15m/1h) and counters over HTTP and one
   websocket, with bot and user activity always counted and labelled separately.
6. **Dev trading.** Three routes let a browser trade against `MemoryVenue` directly, for
   local development only.
7. **Load test.** `make loadtest` drives `MemoryVenue` with concurrent traders and reports
   throughput and time-to-ack.

## Run locally

```sh
make install
cp .env.example .env
make dev            # http://localhost:4100, VENUE=memory, DEV_TRADING=1
```

```sh
curl http://localhost:4100/v1/health
curl http://localhost:4100/v1/markets
curl -X POST http://localhost:4100/v1/fund -H 'content-type: application/json' \
  -d '{"address":"5B9h8RBpkNhRJkWGZMUAtsf3AZsDpAfKfpLm7dY9xyW8"}'
```

With `DEV_TRADING=1` (the `.env.example` default), a browser can trade before the on-chain
client exists:

```sh
curl -X POST http://localhost:4100/v1/dev/orders -H 'content-type: application/json' \
  -d '{"address":"my-dev-trader","market":"NSOL-NUSD","side":"buy","type":"ioc","price":"100","size":"1"}'
```

## Run on the real program

`VENUE=rollup` runs the same service on the on-chain order book program instead of the
in-process engine: the oracle key publishes prices, every bot is an ordinary trader with
its own seat and one-time order keys, and the tape, marks and counters are read back from
the chain. How it works: [docs/DESIGN.md](docs/DESIGN.md), "The rollup venue".

It needs the order book repository beside this one (`../orderbook-noirwire`, or set
`ORDERBOOK_REPO`), built, with its own tools installed (see its README).

```sh
make docker-up      # local network on this machine, set up, this service in a container on it
curl http://localhost:4100/v1/health
make docker-logs
make docker-down
make docker-test    # up, wait for health, smoke check over the published port, down
make test-rollup    # the integration suite: local network, service in-process, real transactions
```

`docker compose --profile terminal up` after `make docker-up` adds the trading terminal
from `../terminal-noirwire` on port 3100. Set `SIM_HOST_PORT` to publish the service on
another port. The local network uses ports 8899, 7799 and 6699; these targets refuse to
start a second one and never stop one they did not start.

With `make docker-up` the local network itself runs on this machine, not in a container,
and the containers reach it through `host.docker.internal`.

To run everything in containers, the network included:

```sh
make docker-up-all    # network container, one-shot set-up container, then this service
curl http://localhost:14100/v1/health
make docker-down-all
make docker-test-all  # up, wait for health, smoke check over the published port, down
```

This needs only Docker and the order book repository's build outputs
(`target/deploy/noirwire_orderbook.so` and `sdk/dist`); it says which one is missing. It
uses none of the ports above, so it runs beside a network on this machine: the service is
published on 14100 (`ALL_SIM_HOST_PORT`) and the network on 18899/18900, 17799/17800 and
16699/16700 (`NETWORK_PORT_PREFIX`, `1` by default, goes before each port).
`make docker-up-all TERMINAL=1` adds the trading terminal.

The network image is linux/amd64, because the Solana test validator has no Linux arm64
build. On an Apple machine it runs under Docker Desktop's Rosetta emulation, which is on
by default; see [docs/DESIGN.md](docs/DESIGN.md), "Local run in Docker", for what was
measured. The first build downloads the Solana release and takes several minutes.

The client package is consumed as a release file, `vendor/noirwire-orderbook-<version>.tgz`.
`make sdk-update` copies a fresh build from the order book repository (`make sdk` there).
Once releases are published, the `file:` path in `package.json` becomes the release URL
and `vendor/` goes away.

Variables for `VENUE=rollup` (all in [.env.example](.env.example); the service refuses to
start when a required one is missing or a key is not the one the deployment names):

| Variable                                                                   | Required | What it is                                                                               |
| -------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------- |
| `SOLANA_RPC_URL`                                                           | yes      | Solana. Checked once at start: the service stops if it is mainnet                        |
| `ROLLUP_RPC_URL`, `ROLLUP_WS_URL`                                          | yes      | The rollup's private endpoint through the query filter, and its websocket                |
| `DEPOSIT_RPC_URL`                                                          | no       | Overrides where deposits are sent; by default the deployment's `depositUrl`              |
| `PUBLIC_SOLANA_RPC_URL`, `PUBLIC_ROLLUP_RPC_URL`, `PUBLIC_ROLLUP_WS_URL`   | no       | The URLs `GET /v1/deployment` tells browsers to use; by default the service's own        |
| `DEPLOYMENT_PATH` or `DEPLOYMENT_JSON`                                     | yes      | The deployment description the order book repository's set-up prints                     |
| `ORACLE_SECRET_KEY`, `GATE_SECRET_KEY`, `FAUCET_SECRET_KEY`                | yes      | Secret keys as JSON arrays of 64 bytes: publish prices, co-sign openings, deposit        |
| `ORACLE_SECRET_KEY_FILE`, `GATE_SECRET_KEY_FILE`, `FAUCET_SECRET_KEY_FILE` | instead  | The path of each keypair file, in place of the key itself, for a run on your own machine |
| `BOT_TRADER_SEEDS`                                                         | yes      | One 32-byte hex seed per bot trader, comma separated (10 with the defaults)              |
| `SERVICE_LOCATION`                                                         | no       | Where the service runs; labels the latency figure                                        |
| `PRICE_PUBLISH_INTERVAL_MS`, `ROLLUP_QUOTE_EXPIRY_SECONDS`                 | no       | Publish cadence (2 s) and how long a resting bot quote stays valid by itself (30 s)      |
| `ROLLUP_MAKER_LEVEL_NUSD`, `ROLLUP_TAKER_MIN_NUSD` / `_MAX_`               | no       | Bot order sizes as notional                                                              |
| `LIQUIDATOR_SEATS_PER_TICK`, `LIQUIDATOR_EXTRA_SEATS`                      | no       | Seats the liquidator tries blind per market per tick; seats this service did not open    |

The fund button with `VENUE=rollup` is two steps, because the user's own key has to sign:

```sh
# 1. The service builds the transaction that opens the account and deposits 5,000 nUSD.
curl -X POST http://localhost:4100/v1/fund/prepare -H 'content-type: application/json' \
  -d '{"owner":"<owner address>","orderKeys":["<key 1>","<key 2>","<key 3>","<key 4>"]}'
# -> { "transaction": "<base64, unsigned>", "expiresAtMs": ..., "amount": "5000.000000" }

# 2. The user signs it with the owner key and sends it back within 45 seconds.
curl -X POST http://localhost:4100/v1/fund/submit -H 'content-type: application/json' \
  -d '{"owner":"<owner address>","transaction":"<base64, signed by the owner>"}'
# -> { "amount": "5000.000000", "reference": "<transaction signature>" }
```

`submit` refuses anything that is not byte for byte the transaction `prepare` built (400),
a request with nothing prepared or prepared too long ago (410), an owner that was funded
before or whose account exists already (409) and too many grants from one IP (429). It
answers 503 `daily limit reached` when the program has opened its daily number of new
seats, and 502 with the endpoint's own status and body when the rollup refuses the
transaction. In every refusal nothing was opened. `scripts/smoke.ts` is a working client
of both steps.

## Configuration

Every variable and its default is in [.env.example](.env.example). The most load-bearing
ones:

| Variable                                        | Default                 | What it does                                                                         |
| ----------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------ |
| `PORT`, `HOST`                                  | `4100`, `0.0.0.0`       | Where the HTTP server listens                                                        |
| `VENUE`                                         | `memory`                | `memory` (in-process engine) or `rollup` (the on-chain program, see above)           |
| `DEV_TRADING`                                   | `0`                     | Set to `1` to register the `/v1/dev/*` routes. Only takes effect with `VENUE=memory` |
| `NETWORK`                                       | `devnet`                | The label every response carries                                                     |
| `ALLOWED_ORIGINS`                               | `http://localhost:3000` | Comma-separated CORS allow-list                                                      |
| `DATA_DIR`                                      | `./data`                | Where candles and fund grants are snapshotted                                        |
| `FUND_AMOUNT_NUSD`                              | `5000`                  | One-time grant size                                                                  |
| `FUND_IP_RATE_LIMIT` / `FUND_IP_RATE_WINDOW_MS` | `20` / `3600000`        | Per-IP cap on fund grants                                                            |
| `JUPITER_POLL_INTERVAL_MS`                      | `2000`                  | How often every market's price is fetched, in one request                            |
| `HOUSE_MAKER_*`                                 | see file                | Ladder depth, spread, requote thresholds, position limit, skew                       |
| `NOISE_TAKER_*`                                 | see file                | How many bot traders, how often, how big                                             |
| `LIQUIDATOR_INTERVAL_MS`, `FUNDING_INTERVAL_MS` | `3000`, `60000`         | Scan/update cadence                                                                  |

## API

Prefix `/v1`. Every price, size and balance in a response is a plain decimal string (never
a float, never a raw `bigint`), scaled from the engine's internal fixed-point integers.

| Route                                                    | Returns                                                                                                                                                                                                                                                                                           |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /health`                                            | `{ ok, venue, network }`. With `VENUE=rollup` also `connected`, `pricesFresh`, `botsFunded`, and 503 until all three hold                                                                                                                                                                         |
| `GET /markets`                                           | Per market: id, kind, names, tick, lot, max leverage, mark price, 24h change, 24h volume, open interest, and `warmingUp` (true with `VENUE=rollup` until the chain's price first reaches the real one; nothing is charted or traded by the bots before)                                           |
| `GET /deployment`                                        | `VENUE=rollup` only, public, cacheable. Program id, the URLs a browser should use, exchange and stats addresses, and per market its on-chain id, addresses, token mints, decimals, lot size and tick. No key. Fields: [docs/DESIGN.md](docs/DESIGN.md)                                            |
| `GET /tape?market=&limit=`                               | Latest fills: price, size, taker side, time, sequence, both tags - never a trader identity. With `VENUE=rollup` `makerTag` and `takerTag` are the chain's 8-byte receipts as big-endian unsigned decimal text                                                                                     |
| `GET /candles?market=&interval=1m\|5m\|15m\|1h&limit=`   | OHLCV candles                                                                                                                                                                                                                                                                                     |
| `GET /stats`                                             | Orders, fills, volume (user and bot counted separately), traders, latency (median, p99, sample size, where measured), updated at. With `VENUE=rollup` also `botOrdersOutcomeUnknown`: bot orders whose outcome was not known in time, and how many of them settled as executed late or as expired |
| `POST /fund` `{ address }`                               | `VENUE=memory` only. `{ amount, reference }`; one grant per address, rate limited per IP                                                                                                                                                                                                          |
| `POST /fund/prepare`, `POST /fund/submit`                | `VENUE=rollup` only. The same grant in two steps, signed by the user (see "Run on the real program")                                                                                                                                                                                              |
| `WS /stream?market=`                                     | `price`, `fill`, `candle`, `stats` messages for one market (`stats` goes to every subscriber)                                                                                                                                                                                                     |
| `POST /dev/orders`, `/dev/cancel-all`, `GET /dev/trader` | Trade against `MemoryVenue` directly. Only registered when `VENUE=memory` and `DEV_TRADING=1`                                                                                                                                                                                                     |

## How numbers are labelled

- Every market, tape, candle and stats response carries `network` and `simulated: true`.
- Bot volume, bot orders and bot fills are counted in their own bucket, never merged with a
  user's. The house maker and noise takers trade as `bot:maker:<market>`, `bot:taker:<n>`
  and `bot:liquidator`; a fill never carries a trader identity at all (only two opaque
  64-bit tags), so bot/user classification for a fill happens server-side against a
  registry of tags this service itself handed out to a bot order.
- A latency figure states where it was measured from (`measuredFrom`).

## Development

| Command            | What it covers                                                                                                                                                                                                                                                                                 |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `make test`        | The vitest suite: matching engine, perp margin/funding/liquidation, a 3,000-operation property test, the house maker, candle bucketing, the HTTP API, and the rollup venue's logic without a network (price walk and publish times, tape tracking, order translation, the fund desk, settings) |
| `make check`       | `eslint`, `tsc --noEmit`, `prettier --check`                                                                                                                                                                                                                                                   |
| `make build`       | Compiles `src/` to `dist/`                                                                                                                                                                                                                                                                     |
| `make loadtest`    | Drives `MemoryVenue` with `LOADTEST_TRADERS` concurrent traders for `LOADTEST_SECONDS`, writes `loadtest-reports/latest.{json,md}`                                                                                                                                                             |
| `make test-rollup` | Starts the local network, sets it up, runs the service on it and asserts prices, fills, the fund flow, the websocket and the bot/user split                                                                                                                                                    |

`make loadtest VENUE=rollup` sends real orders instead: `LOADTEST_TRADERS` traders, each
opened and funded through a running service's fund routes like any user (raise that
service's `FUND_IP_RATE_LIMIT` for the run), each sending immediate-or-cancel orders for
`LOADTEST_SECONDS`. Every order is its own transaction. The program opens only so many new
seats a day (100 in the local set-up, the service's ten bots included), so the traders are
kept in `data/loadtest-traders.json` and reused by the next run; only the missing ones are
opened. More than about 90 new traders in a day needs the admin to raise `maxSeatsPerDay`
(see [docs/deploy.md](docs/deploy.md)). It needs `DEPLOYMENT_PATH`, takes
`LOADTEST_ARGS="--sim-url ... --rollup-rpc ... --rollup-ws ... --late-ms 1000"`, and writes
`loadtest-reports/latest-rollup.json`: orders sent, results confirmed, expired, fills,
confirmed orders per second, send-to-result median, p95 and p99, and how many orders were
late or expired. It refuses any rollup endpoint that is not this machine unless that exact
endpoint is passed with `--allow-rpc <url>`.

No end-to-end browser tests: this is a backend service, and the suite above (engine,
property, API, websocket) covers its observable behaviour. See [CONTRIBUTING.md](CONTRIBUTING.md)
for the test rules a new change is held to.

## Architecture

`src/engine`, `src/prices`, `src/bots`, `src/data` and `src/config` are plain TypeScript:
none of them import Fastify, so none of their tests need a running server. `src/http` is
the thin Fastify layer around them. `src/app.ts` wires everything together.

```
src/
  engine/      MemoryVenue: the Venue interface, markets, matching, money, perp margin/funding/liquidation,
               the 24 hour volume and price window both venues report from
  prices/      PriceSource port, JupiterPriceSource, the mints each market mirrors
  bots/        HouseMaker, NoiseTaker, Liquidator, FundingUpdater, the seeded RNG
  data/        Tape store, candle aggregator, stats (bot/user split), fund ledger, snapshot persistence
  config/      Environment schema (zod), validated once at start
  scheduling/  The one repeating-task helper every loop runs on: no overlapping runs, failures reported
  rollup/      RollupVenue and its parts: program.ts (the one importer of the client), chain types,
               connections and timeouts, transactions, one market's state, the price publisher and
               price walk, chain feed, tape tracker, bot accounts and order secrets, translation
               between the program's units and the service's, seat sweep, fund desk, settings
  wiring/      What differs between the two venues at start, and the bots' loops
  http/        Fastify server, routes, the websocket hub
  app.ts       Wiring: stores, venue, bots, price source, server
  main.ts      The process lifecycle
```

## Deployment

One Railway service, one replica. The fund ledger and candles live in memory, snapshotted
to a JSON file on `DATA_DIR` on an interval and on shutdown, and reloaded at start so a
restart does not lose them. Configuration is environment variables only; nothing secret is
logged. See [Dockerfile](Dockerfile) for the production image (multi-stage, Node 24,
non-root); the same image runs `VENUE=rollup`. Exact steps, variables and keys for the
devnet deployment: [docs/deploy.md](docs/deploy.md), with `.railway/railway.ts`.

## Licence

Proprietary, all rights reserved. See [LICENSE](LICENSE).
