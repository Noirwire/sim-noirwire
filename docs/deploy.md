# Deploying against Solana devnet

The service runs with `VENUE=rollup` against the order book program on Solana devnet,
through MagicBlock's hosted private endpoint. On devnet it runs against the order book's
mainnet-profile deployment, with the house maker alone. This page covers both ways to run
it: from this machine, and as one Railway service. Nothing has been applied to Railway yet.

## What exists on chain

The order book repository's mainnet launch, rehearsed on devnet (`make rehearsal-setup`
there), is the deployment this service runs against. It is at program
`3LTYp7hQEtu53UHZRhTHHacC1X1PL6hhE9dSK2U6pgr3` and described in
`.keys/rehearsal-deployment.json` of that repository:

- one market, `SOL-PERP`, which this service follows as its `NSOL-PERP`, and one token,
  `USDC` (a test mint of six decimals), which it counts as nUSD;
- its mark is Pyth's, synced by the order book repository's crank (`make rehearsal-crank`),
  and its liquidations are swept by that repository's keeper (`make rehearsal-keeper`);
- no faucet: nothing here can fund a seat, so test funds are not handed out
  (`/v1/fund/*` answers 503) and only the house maker runs;
- the gate key, in `.keys/rehearsal-gate.json` of that repository.

### The earlier devnet test network is retired here

The test network the order book repository set up before (`make devnet-setup` there,
`.keys/devnet-deployment.json`: three markets, test mints, a faucet) no longer works with
this service, and `make devnet-start` against it does not start:

- its description names no custody nonce for its tokens, which every deposit of the
  current client names. The service refuses it at start with a message that says so;
- even with the nonces added, nothing publishes its marks any more: this service used to,
  and no longer sets a price anywhere.

The same goes for the local network flows (`make test-rollup` and the docker targets):
nothing publishes their marks either.

## Every variable

Required with `VENUE=rollup`. The service refuses to start when one is missing, malformed,
or a key is not the one the description names for its role.

| Variable                                     | Devnet value                                                                    |
| -------------------------------------------- | ------------------------------------------------------------------------------- |
| `VENUE`                                      | `rollup`                                                                        |
| `SOLANA_RPC_URL`                             | `https://api.devnet.solana.com` (read once at start, to refuse mainnet)         |
| `ROLLUP_RPC_URL`                             | `https://devnet-tee.magicblock.app`                                             |
| `ROLLUP_WS_URL`                              | `wss://devnet-tee.magicblock.app`                                               |
| `DEPLOYMENT_JSON` or `DEPLOYMENT_PATH`       | the content of, or the path to, `.keys/rehearsal-deployment.json`               |
| `GATE_SECRET_KEY` or `GATE_SECRET_KEY_FILE`  | `.keys/rehearsal-gate.json`: co-signs every account opening                     |
| `NOISE_TAKERS_ENABLED`, `LIQUIDATOR_ENABLED` | `0` and `0`: a deployment without a faucet refuses to start with either on      |
| `BOT_TRADER_SEEDS`                           | one 32-byte seed in hex per bot: here one, the maker's, generated once and kept |

`FAUCET_SECRET_KEY` (or `FAUCET_SECRET_KEY_FILE`) is read only on a deployment whose
description names a faucet; this one has none.

No oracle key: the service publishes no price and advances no funding. The mark is the
program's own, synced from Pyth by the crank, and the program's own schedule advances
funding.

A key variable takes the JSON array of 64 bytes that is in the keypair file, on one line.
The `_FILE` form takes a path to that file instead, so a local run never copies a key.

Worth setting:

| Variable                                                                 | Default                        | For devnet                                                                   |
| ------------------------------------------------------------------------ | ------------------------------ | ---------------------------------------------------------------------------- |
| `NETWORK`                                                                | `devnet`                       | the label every response carries                                             |
| `ALLOWED_ORIGINS`                                                        | `http://localhost:3000`        | the terminal's origin or origins, comma separated                            |
| `DATA_DIR`                                                               | `./data`                       | on Railway the volume, `/app/data`                                           |
| `SERVICE_LOCATION`                                                       | `unnamed machine`              | where it runs: it labels the latency figure                                  |
| `PUBLIC_SOLANA_RPC_URL`, `PUBLIC_ROLLUP_RPC_URL`, `PUBLIC_ROLLUP_WS_URL` | the three URLs above           | what `GET /v1/deployment` tells browsers; leave unset on devnet              |
| `DEPOSIT_RPC_URL`                                                        | the description's `depositUrl` | leave unset on devnet                                                        |
| `ROLLUP_MAKER_LEVEL_NUSD`, `HOUSE_MAKER_LEVELS`                          | `400`, `5`                     | the first level's notional and how many levels; level n is n times the first |
| `HOUSE_MAKER_POSITION_LIMIT_NUSD`                                        | `50000`                        | the maker's own inventory limit, which its skew is measured against          |

**The bot seeds are the bots.** A seed is a bot's owner key, and its owner key is its
seat. The exchange opens only so many new seats a day and a seat is not given back.
Generate the seeds once (`openssl rand -hex 32` for each), keep them, and use the same
ones on every restart and redeploy: the bots then reuse their seats and their balances.
New seeds cost new seats and strand the old balances.

**A seed's role is its place in the list, among the bots that are on.** The makers come
first, one per market the deployment has, then the noise takers when they are on, then
the liquidator when it is on. Turning a flag on or off moves the seeds after it to other
roles: with the takers off and the liquidator on, the liquidator takes the seed the first
taker had. Here only the maker runs, so the one seed is the maker's.

## Run against devnet from this machine

1. Build the order book repository beside this one, so its `.keys/` holds the rehearsal
   description and the gate key.
2. Write `.env.devnet.local` (git-ignored) with the variables above: the `_FILE` form for
   the gate key and `DEPLOYMENT_PATH`, pointing into `../orderbook-noirwire/.keys/`,
   `DATA_DIR=./data/devnet`, `PORT=4100`, the two flags at `0` and the maker's seed:

   ```
   DEPLOYMENT_PATH=../orderbook-noirwire/.keys/rehearsal-deployment.json
   GATE_SECRET_KEY_FILE=../orderbook-noirwire/.keys/rehearsal-gate.json
   NOISE_TAKERS_ENABLED=0
   LIQUIDATOR_ENABLED=0
   BOT_TRADER_SEEDS=<one seed: the maker's>
   ```

3. `make devnet-start`. It builds, starts the service in the background and writes its
   log to `data/devnet/sim.log` and its pid to `data/devnet/sim.pid`.
4. Take the two operator steps below, once.
5. `curl -s localhost:4100/v1/health` answers 503 with what is missing (a `reason` when the
   rollup refuses or the seat is not funded; the start-up work is retried by itself), and
   then 200. The service then sleeps, sending nothing to the rollup, until a request or a
   stream socket wakes it, and the maker quotes around the chain's mark once it is awake.
6. `make devnet-stop` stops it.

`data/devnet/` holds the maker's order key checkpoints and the candles. Keep it: without
it the maker replaces its order keys at the next start (which works).

### The operator's two steps

1. **Fund the maker's seat.** The service opens the seat (with the gate's signature) and
   then waits, retrying its start-up, until the seat holds collateral, logging the owner
   key a deposit has to credit. Deposit test USDC to that owner from any account that
   holds it. The maker counts as funded with any collateral at all, so deposit enough for
   its whole ladder: both sides, each up to the market's position cap, at the market's
   initial margin. While the program refuses quotes for margin the log says
   `InsufficientMargin (6024)` with that owner key.
2. **List the maker's seat, if the market keeps a maker list.** On a market whose maker
   list is on, the program refuses resting orders from an unlisted seat with
   `MakerNotListed` (6091). The exchange admin lists the seat by its owner key with
   `set_seat_access` (the order book's access-list instruction); this service never
   sends it. At start the service logs each maker's owner key, and while its quotes are
   refused it logs `MakerNotListed (6091)` with that key.

### What the maker does when the market will not take its quotes

The maker reads the market's status, its oracle health and position cap, and the
exchange's pause and USDC guard, along with the mark. While the program would refuse its
quotes (a mark older than the market's age limit, a paused or reduce-only market, a
dislocated oracle, a paused exchange, a tripped USDC guard) it keeps what rests, cancels
nothing and sends nothing, and logs why, naming the program's error (for instance
`StalePrice, 6038: is the price crank running?`). It quotes again on its first tick after
the market takes quotes, which the log reports as the maker tick working again. Each side
of its ladder stops at the market's position cap, the last level trimmed to fit.

Any quote the program still refuses is logged with its error number and name and the
seat's owner key: once when it starts, then once a minute while it goes on, and once more
when a quote goes through again.

## Deploy on Railway

One service, `sim`, defined in `.railway/railway.ts`: Dockerfile build, health check on
`/v1/health`, one replica, a volume at `/app/data`.

1. Railway CLI 5.42.1 or newer, logged in, with Railway's GitHub app allowed to read this
   repository.
2. `railway link` (choose the project), then `railway add --service sim`.
3. In the dashboard, open `sim`, Variables, Raw Editor, and paste the block below with
   your values. Seal the last two.
4. `(cd .railway && npm ci) && railway config apply`. Railway builds from GitHub now and
   on every push to `main`.
5. `railway domain --service sim`, then point the terminal at that domain.

```
ALLOWED_ORIGINS=https://<the terminal's origin>
SOLANA_RPC_URL=https://api.devnet.solana.com
ROLLUP_RPC_URL=https://devnet-tee.magicblock.app
ROLLUP_WS_URL=wss://devnet-tee.magicblock.app
NOISE_TAKERS_ENABLED=0
LIQUIDATOR_ENABLED=0
DEPLOYMENT_JSON=<the whole of .keys/rehearsal-deployment.json, on one line>
GATE_SECRET_KEY=<the array in .keys/rehearsal-gate.json>
BOT_TRADER_SEEDS=<the same seed as any earlier run>
```

Set by `.railway/railway.ts`, not by hand: `VENUE=rollup`, `NETWORK=devnet`,
`DATA_DIR=/app/data`, `SERVICE_LOCATION` (the Railway region). The `_FILE` variables are
for a local run; Railway has no key files.

Moving the service here from a local run: stop the local one first, use the same seed,
and expect the maker to replace its order keys once, because the checkpoints stayed in
the local data folder.

### Which region

MagicBlock's devnet endpoint answered a read in about 340 ms and a bot's order in about
550 ms from a laptop in Europe (measured, see below). Where their server is has not been
published and is not guessed here. Measure it: deploy to one region, read
`latency.medianMs` in `/v1/stats` after a few minutes (the bots' own send-to-result time,
labelled with the region), move the service to another region in its settings, and
compare. Keep the lowest. The mark's age limit is the market's own and the crank keeps it
fresh, so every region works; the region only changes how quick the maker is.

## Check it

```bash
curl -s https://<domain>/v1/health      # 200 {"ok":true,"awake":false,...} when idle, awake:true with "connected":true,"pricesFresh":true after a request below
curl -s https://<domain>/v1/markets     # wakes the service; one market, NSOL-PERP, with a markPrice, warmingUp true while it wakes
curl -s https://<domain>/v1/stats       # the maker's orders growing; latency names the region
curl -s https://<domain>/v1/deployment  # what a browser needs to trade on chain
```

`scripts/smoke.ts` opens and funds a fresh key through `/v1/fund/*`, so it needs a
deployment with a faucet and fails its fund checks here.

`pricesFresh` is false while any followed market's mark on chain is older than its own
age limit: this service does not set the mark, so look at the Pyth crank. Railway waits
up to five minutes for the first 200.

## What the hosted endpoint needs, and how the service meets it

- Sending needs a signed-in token: every key that sends (the gate, each bot, and the
  faucet where there is one) signs in first, and signs in again after a failure on the
  wire.
- Public accounts are read anonymously: the tape, the price feeds, the stats, the markets
  and the exchange. Nothing reads a transaction back, a token account or custody.
- Prices are read, never published: the mark comes from the chain's price feed.
- Funding: `update_funding` does nothing and succeeds while the price is stale, so the
  program's built-in schedule advances it and this service does not call it.
- Deposits, where a faucet exists, go through the same endpoint (`depositUrl`), and it
  accepts them.

## Measured on devnet

From one laptop in Europe, over the public internet, against a shared test server, on
2026-10-10, on the test network now retired here. A snapshot of one morning, not a
promise.

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

The load test opens its traders through the service's fund routes, so it needs a
deployment with a faucet; the rehearsal deployment has none. Against one that has, with
the service running:

```sh
DEPLOYMENT_PATH=<a description with a faucet> make loadtest VENUE=rollup \
  LOADTEST_TRADERS=10 LOADTEST_SECONDS=120 LOADTEST_ARGS="--sim-url http://127.0.0.1:4100 \
  --rollup-rpc https://devnet-tee.magicblock.app --rollup-ws wss://devnet-tee.magicblock.app \
  --allow-rpc https://devnet-tee.magicblock.app --allow-rpc wss://devnet-tee.magicblock.app"
```

Its traders are kept in `data/loadtest-traders.json` and reused; the first run opens ten
seats.

## The daily limit on new accounts

The program opens at most `maxSeatsPerDay` new seats a day. On a deployment with a faucet,
once it is reached, `POST /v1/fund/submit` answers 503 `daily limit reached` until the next
day. To raise it, the exchange's admin sends `update_exchange` with a larger
`maxSeatsPerDay` (the order book repository's ops script holds the settings). Seats opened
and never used can be closed by the admin with `close_unused_trader`. The load test keeps
its traders in `data/loadtest-traders.json` and reuses them for this reason.

## Do not change

Keep it at one replica, and never run a second copy with the same keys. Two processes
would move the same bots' order keys under each other, the fund limits are counted in one
process's memory, and where the liquidator runs, its sweep covers the seats this process
opened plus `LIQUIDATOR_EXTRA_SEATS`.
