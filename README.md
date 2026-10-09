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

## Configuration

Every variable and its default is in [.env.example](.env.example). The most load-bearing
ones:

| Variable                                        | Default                 | What it does                                                                         |
| ----------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------ |
| `PORT`, `HOST`                                  | `4100`, `0.0.0.0`       | Where the HTTP server listens                                                        |
| `VENUE`                                         | `memory`                | `memory` only for now; `rollup` is reserved for the on-chain client                  |
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

| Route                                                    | Returns                                                                                                                          |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `GET /health`                                            | `{ ok, venue, network }`                                                                                                         |
| `GET /markets`                                           | Per market: id, kind, names, tick, lot, max leverage, mark price, 24h change, 24h volume, open interest                          |
| `GET /tape?market=&limit=`                               | Latest fills: price, size, taker side, time, sequence, both tags - never a trader identity                                       |
| `GET /candles?market=&interval=1m\|5m\|15m\|1h&limit=`   | OHLCV candles                                                                                                                    |
| `GET /stats`                                             | Orders, fills, volume (user and bot counted separately), traders, latency (median, p99, sample size, where measured), updated at |
| `POST /fund` `{ address }`                               | `{ amount, reference }`; one grant per address, rate limited per IP                                                              |
| `WS /stream?market=`                                     | `price`, `fill`, `candle`, `stats` messages for one market (`stats` goes to every subscriber)                                    |
| `POST /dev/orders`, `/dev/cancel-all`, `GET /dev/trader` | Trade against `MemoryVenue` directly. Only registered when `VENUE=memory` and `DEV_TRADING=1`                                    |

## How numbers are labelled

- Every market, tape, candle and stats response carries `network` and `simulated: true`.
- Bot volume, bot orders and bot fills are counted in their own bucket, never merged with a
  user's. The house maker and noise takers trade as `bot:maker:<market>`, `bot:taker:<n>`
  and `bot:liquidator`; a fill never carries a trader identity at all (only two opaque
  64-bit tags), so bot/user classification for a fill happens server-side against a
  registry of tags this service itself handed out to a bot order.
- A latency figure states where it was measured from (`measuredFrom`).

## Development

| Command         | What it covers                                                                                                                                       |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `make test`     | The vitest suite: matching engine, perp margin/funding/liquidation, a 3,000-operation property test, the house maker, candle bucketing, the HTTP API |
| `make check`    | `eslint`, `tsc --noEmit`, `prettier --check`                                                                                                         |
| `make build`    | Compiles `src/` to `dist/`                                                                                                                           |
| `make loadtest` | Drives `MemoryVenue` with `LOADTEST_TRADERS` concurrent traders for `LOADTEST_SECONDS`, writes `loadtest-reports/latest.{json,md}`                   |

No end-to-end browser tests: this is a backend service, and the suite above (engine,
property, API, websocket) covers its observable behaviour. See [CONTRIBUTING.md](CONTRIBUTING.md)
for the test rules a new change is held to.

## Architecture

`src/engine`, `src/prices`, `src/bots`, `src/data` and `src/config` are plain TypeScript:
none of them import Fastify, so none of their tests need a running server. `src/http` is
the thin Fastify layer around them. `src/main.ts` wires everything together.

```
src/
  engine/      MemoryVenue: the Venue interface, markets, matching, money, perp margin/funding/liquidation
  prices/      PriceSource port, JupiterPriceSource, FixedPriceSource
  bots/        HouseMaker, NoiseTaker, Liquidator, FundingUpdater, the seeded RNG
  data/        Tape store, candle aggregator, stats (bot/user split), fund ledger, snapshot persistence
  config/      Environment schema (zod), validated once at start
  http/        Fastify server, routes, the websocket hub
  main.ts      Wiring and the process lifecycle
```

## Deployment

One Railway service, one replica. The fund ledger and candles live in memory, snapshotted
to a JSON file on `DATA_DIR` on an interval and on shutdown, and reloaded at start so a
restart does not lose them. Configuration is environment variables only; nothing secret is
logged. See [Dockerfile](Dockerfile) for the production image (multi-stage, Node 24,
non-root).

## Licence

Proprietary, all rights reserved. See [LICENSE](LICENSE).
