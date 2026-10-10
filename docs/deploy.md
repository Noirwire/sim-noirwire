# Deploying against Solana devnet

The service runs with `VENUE=rollup` against the order book program on Solana devnet,
through MagicBlock's hosted private endpoint. This page covers both ways to run it: from
this machine, and as one Railway service. Nothing has been applied to Railway yet.

## What already exists on chain

The order book repository set this up (`make devnet-setup` there) and wrote the
description this service reads, `.keys/devnet-deployment.json`:

- the program at `9YiFamFrLbCiNYQczPwKfSwnnaTjDNWm9guokUGxB1z8`, its exchange delegated to
  the rollup, the ledger, the stats account;
- three markets, `NSOL-PERP`, `NNVDA-PERP`, `NSOL-NUSD`;
- two test mints, nUSD and nSOL, with their custody accounts;
- the gate, oracle and faucet keys, in `.keys/` of that repository. The faucet holds the
  test tokens inside the rollup.

## Every variable

Required with `VENUE=rollup`. The service refuses to start when one is missing, malformed,
or a key is not the one the description names for its role.

| Variable                                        | Devnet value                                                            |
| ----------------------------------------------- | ----------------------------------------------------------------------- |
| `VENUE`                                         | `rollup`                                                                |
| `SOLANA_RPC_URL`                                | `https://api.devnet.solana.com` (read once at start, to refuse mainnet) |
| `ROLLUP_RPC_URL`                                | `https://devnet-tee.magicblock.app`                                     |
| `ROLLUP_WS_URL`                                 | `wss://devnet-tee.magicblock.app`                                       |
| `DEPLOYMENT_JSON` or `DEPLOYMENT_PATH`          | the content of, or the path to, `.keys/devnet-deployment.json`          |
| `ORACLE_SECRET_KEY` or `ORACLE_SECRET_KEY_FILE` | `.keys/devnet-oracle.json`: publishes prices and advances funding       |
| `GATE_SECRET_KEY` or `GATE_SECRET_KEY_FILE`     | `.keys/devnet-gate.json`: co-signs every account opening                |
| `FAUCET_SECRET_KEY` or `FAUCET_SECRET_KEY_FILE` | `.keys/devnet-faucet.json`: signs every deposit                         |
| `BOT_TRADER_SEEDS`                              | ten 32-byte seeds in hex, comma separated: one per bot, generated once  |

A key variable takes the JSON array of 64 bytes that is in the keypair file, on one line.
The `_FILE` form takes a path to that file instead, so a local run never copies a key.

Worth setting:

| Variable                                                                 | Default                        | For devnet                                                                       |
| ------------------------------------------------------------------------ | ------------------------------ | -------------------------------------------------------------------------------- |
| `NETWORK`                                                                | `devnet`                       | the label every response carries                                                 |
| `ALLOWED_ORIGINS`                                                        | `http://localhost:3000`        | the terminal's origin or origins, comma separated                                |
| `DATA_DIR`                                                               | `./data`                       | on Railway the volume, `/app/data`                                               |
| `SERVICE_LOCATION`                                                       | `unnamed machine`              | where it runs: it labels the latency figure                                      |
| `PUBLIC_SOLANA_RPC_URL`, `PUBLIC_ROLLUP_RPC_URL`, `PUBLIC_ROLLUP_WS_URL` | the three URLs above           | what `GET /v1/deployment` tells browsers; leave unset on devnet                  |
| `DEPOSIT_RPC_URL`                                                        | the description's `depositUrl` | leave unset on devnet                                                            |
| `HOUSE_MAKER_POSITION_LIMIT_NUSD`                                        | `50000`                        | a maker is funded with four times this                                           |
| `NOISE_TAKER_STARTING_NUSD`, `NOISE_TAKER_STARTING_BASE`                 | `100000`, `1000`               | each of six takers; the spot maker holds ten times the base                      |
| `LIQUIDATOR_STARTING_NUSD`                                               | `1000000`                      | the liquidator's collateral                                                      |
| `LIQUIDATOR_SEATS_PER_TICK`, `LIQUIDATOR_EXTRA_SEATS`                    | `4`, `8`                       | seats tried per market per tick; seats on the exchange this service did not open |
| `FUND_AMOUNT_NUSD`, `FUND_IP_RATE_LIMIT`                                 | `5000`, `20` an hour           | the grant and its per-IP limit                                                   |

With the defaults the bots take about 3,000,000 nUSD and 16,000 nSOL from the faucet at
their first start. The faucet is shared: the local run below uses a sixth of that. Every
other variable is in `.env.example` and keeps its default.

**The bot seeds are the bots.** A seed is a bot's owner key, and its owner key is its
seat. The exchange opens 100 new seats a day and a seat is not given back. Generate the
ten seeds once (`for i in $(seq 10); do openssl rand -hex 32; done | paste -sd, -`), keep
them, and use the same ten on every restart and redeploy: the bots then reuse their seats
and their balances. New seeds cost ten new seats and strand the old balances.

## Run against devnet from this machine

1. Build the order book repository beside this one, so `.keys/` holds the description and
   the three role keys.
2. Write `.env.devnet.local` (git-ignored) with the variables above: the `_FILE` form for
   the three keys and `DEPLOYMENT_PATH`, pointing into `../orderbook-noirwire/.keys/`,
   `DATA_DIR=./data/devnet`, `PORT=4100`, and your ten `BOT_TRADER_SEEDS`.
3. `make devnet-start`. It builds, starts the service in the background and writes its
   log to `data/devnet/sim.log` and its pid to `data/devnet/sim.pid`.
4. `curl -s localhost:4100/v1/health` answers 503 with what is missing, then 200. A first
   start takes a minute or two: ten bots sign in, open their seats and are funded, and the
   price is walked from wherever it was left.
5. `make devnet-stop` stops it.

`data/devnet/` holds the bots' order key checkpoints, the fund grants and the candles.
Keep it: without it the bots replace their order keys at the next start (which works) and
every address can be granted again.

## Deploy on Railway

One service, `sim`, defined in `.railway/railway.ts`: Dockerfile build, health check on
`/v1/health`, one replica, a volume at `/app/data`.

1. Railway CLI 5.42.1 or newer, logged in, with Railway's GitHub app allowed to read this
   repository.
2. `railway link` (choose the project), then `railway add --service sim`.
3. In the dashboard, open `sim`, Variables, Raw Editor, and paste the block below with
   your values. Seal the last four.
4. `(cd .railway && npm ci) && railway config apply`. Railway builds from GitHub now and
   on every push to `main`.
5. `railway domain --service sim`, then point the terminal at that domain.

```
ALLOWED_ORIGINS=https://<the terminal's origin>
SOLANA_RPC_URL=https://api.devnet.solana.com
ROLLUP_RPC_URL=https://devnet-tee.magicblock.app
ROLLUP_WS_URL=wss://devnet-tee.magicblock.app
DEPLOYMENT_JSON=<the whole of .keys/devnet-deployment.json, on one line>
ORACLE_SECRET_KEY=<the array in .keys/devnet-oracle.json>
GATE_SECRET_KEY=<the array in .keys/devnet-gate.json>
FAUCET_SECRET_KEY=<the array in .keys/devnet-faucet.json>
BOT_TRADER_SEEDS=<the same ten seeds as any earlier run>
```

Set by `.railway/railway.ts`, not by hand: `VENUE=rollup`, `NETWORK=devnet`,
`DATA_DIR=/app/data`, `SERVICE_LOCATION` (the Railway region). The `_FILE` variables are
for a local run; Railway has no key files.

Moving the service here from a local run: stop the local one first, use the same seeds,
and expect the bots to replace their order keys once, because the checkpoints stayed in
the local data folder.

### Which region

MagicBlock's devnet endpoint answered a read in about 340 ms and a bot's order in about
550 ms from a laptop in Europe (measured, see below). Where their server is has not been
published and is not guessed here. Measure it: deploy to one region, read
`latency.medianMs` in `/v1/stats` after a few minutes (the bots' own send-to-result time,
labelled with the region), move the service to another region in its settings, and
compare. Keep the lowest. The price stays valid on chain for 10 seconds and is published
every 2, so every region works; the region only changes how quick the bots and the fund
flow are.

## Check it

```bash
curl -s https://<domain>/v1/health      # 200 {"ok":true,"connected":true,"pricesFresh":true,"botsFunded":true,"fundingUpdates":{...}}
curl -s https://<domain>/v1/markets     # three markets, each with a markPrice and warmingUp false
curl -s https://<domain>/v1/stats       # bot orders and fills growing; latency names the region
curl -s https://<domain>/v1/deployment  # what a browser needs to trade on chain
npx tsx scripts/smoke.ts --url https://<domain>   # also opens and funds one fresh key: one seat
```

`fundingUpdates` counts, per perpetual, how often this process has advanced funding: it
grows by one a minute. Railway waits up to five minutes for the first 200.

## What the hosted endpoint needs, and how the service meets it

- Sending needs a signed-in token: every key that sends (oracle, gate, faucet, each bot)
  signs in first, and signs in again after a failure on the wire.
- Public accounts are read anonymously: the tape, the price feeds, the stats, the markets.
  Nothing reads a transaction back, a token account or custody.
- A price is stale after 10 seconds: each market is published every 2 seconds; a publish
  still on its way is never doubled, so a slow one costs a turn and builds no backlog, and
  none is sent while the rollup's clock still shows the second of the last accepted one.
- Funding: the rollup's scheduler stops for good after one failed call, and
  `update_funding` fails on a stale price. So this service calls `update_funding` for each
  perpetual once per funding interval, right after a successful publish, whatever the
  deployment description says about scheduled tasks.
- Deposits go through the same endpoint (`depositUrl`), and it accepts them.

## Measured on devnet

From one laptop in Europe, over the public internet, against a shared test server, on
2026-10-10. A snapshot of one morning, not a promise.

- An anonymous read of a public account: about 340 ms.
- The bots' own orders, send to result in their private view: median about 530 to 600 ms,
  p99 about 0.9 to 1.3 s, over samples of 420 to 500. No order's outcome was unknown.
- Opening and funding a user through the two fund routes: about 0.9 s.
- Load test, 10 traders reused from an earlier run, 121 s, `NSOL-PERP`, immediate-or-cancel:
  932 sent, 932 confirmed, 0 expired, 0 unknown, 0 refused, 0 failed sends, 786 with a
  fill, 913 fills on chain, 7.7 confirmed orders a second, send to result median 535 ms,
  p95 814 ms, p99 1,012 ms, 12 slower than a second. The service stayed healthy
  throughout (25 of 25 samples). The endpoint returned no rate limit and no error at
  this rate. Each trader waits for its own result before its next order, so the rate is
  set by the round trip, not by the server.

To repeat the load test, with the service running:

```sh
DEPLOYMENT_PATH=../orderbook-noirwire/.keys/devnet-deployment.json make loadtest VENUE=rollup \
  LOADTEST_TRADERS=10 LOADTEST_SECONDS=120 LOADTEST_ARGS="--sim-url http://127.0.0.1:4100 \
  --rollup-rpc https://devnet-tee.magicblock.app --rollup-ws wss://devnet-tee.magicblock.app \
  --allow-rpc https://devnet-tee.magicblock.app --allow-rpc wss://devnet-tee.magicblock.app"
```

Its traders are kept in `data/loadtest-traders.json` and reused; the first run opens ten
seats.

## The daily limit on new accounts

The program opens at most `maxSeatsPerDay` new seats a day (100 on devnet). Once it is
reached, `POST /v1/fund/submit` answers 503 `daily limit reached` until the next day. To
raise it, the exchange's admin sends `update_exchange` with a larger `maxSeatsPerDay` (the
order book repository's ops script holds the settings). Seats opened and never used can be
closed by the admin with `close_unused_trader`. The load test keeps its traders in
`data/loadtest-traders.json` and reuses them for this reason.

## Do not change

Keep it at one replica, and never run a second copy with the same keys. The fund limits
are counted in one process's memory, two oracles would refuse each other's prices, two
processes would move the same bots' order keys under each other, and the liquidator's
sweep covers the seats this process opened plus `LIQUIDATOR_EXTRA_SEATS`.
