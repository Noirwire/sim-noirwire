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

## Running on mainnet

`NETWORK=mainnet` is a separate mode, not a bigger devnet: it runs the house maker, the
gate and the read-only market data, and refuses to start anything else (see "Mainnet mode"
in the README). It is for a dedicated host that mounts its secrets as files; the Railway
steps above do not apply to it. The files and variables it takes, and what each holds:

| Name                                                                     | What it is                                                                                                                                                |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DEPLOYMENT_PATH`                                                        | The mainnet description: `network` `mainnet`, the real USDC mint, no faucet                                                                               |
| `GATE_SECRET_KEY_FILE`                                                   | The gate keypair file (64-byte JSON array): must be the gate the description names                                                                        |
| `BOT_TRADER_SEEDS_FILE`                                                  | The maker's seed in hex. It is the maker's seat: back it up offline, never rotate it casually, since a new seed is a new seat and strands the old balance |
| `SOLANA_RPC_URL`, `ROLLUP_RPC_URL`, `ROLLUP_WS_URL`                      | Private endpoints, which may carry an API key. Never served and never logged                                                                              |
| `PUBLIC_SOLANA_RPC_URL`, `PUBLIC_ROLLUP_RPC_URL`, `PUBLIC_ROLLUP_WS_URL` | What browsers are told. Separate from the private ones, no key in them                                                                                    |
| `GATE_INVITES_FILE`                                                      | The invite list: a text file in a folder mounted read-only, edited by the operator on the host. The service reads it again when it changes                |
| `GATE_SEATS_PER_DAY`, `GATE_SEATS_PER_IP_PER_DAY`                        | The day's limits on new accounts (defaults 3 and 1). Always kept below the exchange's `max_seats_per_day`                                                 |
| `DATA_DIR`                                                               | A writable folder that survives restarts and redeploys. Holds `gate-seats.json`, the gate's record of every seat it signed for                            |
| `TRUSTED_PROXY_HOPS`                                                     | Reverse proxies in front of the service (`0` for none)                                                                                                    |
| `ALLOWED_ORIGINS`                                                        | The production terminal's origin only                                                                                                                     |

**Where the service may be reached from.** The per-address limits (the gate's seats per
address per day and the rate limit) read the caller's address from `X-Forwarded-For`, as
many hops deep as `TRUSTED_PROXY_HOPS` says. So the service must sit behind the server's
tunnel and local proxy and be reachable by nothing else: bind it to the private interface
or firewall its port. If anyone can reach the port directly they can send their own
`X-Forwarded-For` and get a fresh address on every request, which defeats both limits (the
day's total of seats still holds). Set `TRUSTED_PROXY_HOPS` to the real number of proxies
in the chain: too low and every user shares the proxy's address, so one person's seat uses
up the address limit for everybody that day.

**No liquidator runs here, on purpose.** Mainnet mode never starts one
(`LIQUIDATOR_ENABLED=1` is refused at start). Liquidating under-margined seats is the
order book repository's keeper, which runs separately and which this service does not
start. Mount the keeper's heartbeat file read-only and set `KEEPER_HEARTBEAT_FILE` to it:
without it mainnet trading is never ready, and a heartbeat older than
`KEEPER_HEARTBEAT_MAX_AGE_MS` (30 s) makes it not ready too. While the heartbeat is not
fresh each maker also pulls its quotes and places none until it is fresh again; only a
flatten trades the position down. A line that says the liquidation keeper is
not sweeping starts with `ALERT`, and a notice follows when the heartbeat is fresh again.

Do not set the faucet, noise taker, liquidator, oracle or `DEV_TRADING` variables, nor an
inline `GATE_SECRET_KEY`, `BOT_TRADER_SEEDS` or `DEPLOYMENT_JSON`: the service refuses to
start and lists each one. It checks Solana's genesis hash against `NETWORK` before it sends
anything, and a `DATA_DIR` that holds a snapshot from another network.

Check it with `GET /v1/health` (the container probe): 200 once the maker is open and its
seat funded and, as the service is never put to sleep on mainnet, the chain is connected
and the mark is fresh; 503 with a `reason` otherwise.

### The gate on mainnet: invites and seats

The rules are in the README ("The gate: who gets an account on mainnet"). What an operator
does:

- **Invite someone:** add their owner public key on a line of the invite list on the host,
  or a line `<code> <owner public key>` and give them the code. Save. It takes effect on the
  next request; no restart. Remove the line to withdraw an invite that is not used yet.
- **The folder is mounted, not the file.** The deployment mounts the folder that holds the
  list into the container read-only, and `GATE_INVITES_FILE` names the file in it. A
  one-file mount follows the file, not its name, so an editor that saves by replacing it
  would leave the service reading the old list.
- **Watch the log** for lines that start `sim-noirwire: gate:`. Each decision is one line
  with the owner's public key. A line about the invite list that "cannot be used" names the
  line number; fix it and save. The list file "cannot be read" line means nobody is being
  admitted until it can be.
- **`gate-seats.json` in `DATA_DIR`** is the record of every seat the gate signed for. Back
  it up with `DATA_DIR`; never delete it to "reset" a day, since it also stops an invite
  from opening a second account. If it is damaged the service stops at start and says so:
  restore it from a backup. Beside it, `gate-seats.json.key` holds the key its address hashes
  are made with; if it is damaged the service stops at start and says to delete it, which only
  restarts the day's count per address.
- **Raising the day's limit** takes two changes, in this order: the exchange's admin raises
  `max_seats_per_day` with `update_exchange`, then `GATE_SEATS_PER_DAY` is raised and the
  service restarted. The gate always stays one seat under the program's limit.
- **A person who says their account did not open** after an error that said it "may have
  been opened": check the chain for their owner key before anything else. If the seat is
  there they are done; if not they can try again with the same invite.

### The maker on mainnet: risk rules, alerts, kill switch

The maker follows its risk rules (README, "The maker's risk rules"). What an operator needs:

- **The host's clock must be right** (NTP running). Quote expiries are set against the
  host's clock, and a price source more than 10 s from it is not believed.
- **Alerts are log lines** that start with `sim-noirwire: ALERT`. One means the maker is
  no longer quoting freely: it is flattening after a loss limit, it is at the soft stop
  (the kill switch, an error it does not understand, or a control file it cannot read), or
  it has stopped quoting altogether. It stays that way until it is resumed. Watch the log
  for the word `ALERT`. Lines saying it `pulled its quotes` are not alerts: the price
  sources disagreed, a price was old, or the market moved fast, and it quotes again by
  itself after 10 quiet seconds.
- **A heartbeat for an outside monitor.** Set `HEALTHCHECK_URL` to a ping address (for
  example a healthchecks.io check) and the maker calls it after a good requote of both
  sides, at most once every 15 s (the maker requotes about every 10 s, so in practice
  about every 20 s; a monitor such as healthchecks.io takes five pings a minute per
  check). It sends none while a loss limit or the kill switch has the maker reducing, or
  while the program's market is reduce-only. Set the monitor's period to 1 minute with a
  short grace, and have it message you when the calls stop. That also fires when the
  maker is stopped, flattening or reducing, or the prices are pulled for long, which is
  the point. **A page during a reduce-only market is expected, not a fault:** the maker
  is doing what it should (it pulled its quotes; only a flatten reduces the position)
  and silences the heartbeat on purpose. Check the market's status first; if
  it is reduce-only the page is that, and it clears by itself with the first full
  two-sided requote after the market opens again. The address is never logged; if a call
  fails the log says `health check ping failing` with what to check, and quoting goes on.
- **Two stops, and what each does to users.** The soft stop pulls the maker's
  quotes and places none; only a flatten reduces its position. The hard stop quotes
  nothing as well, so **users cannot close their positions until the maker is resumed**; the
  exchange admin can pause the market in the meantime, and a restart does not resume it,
  since the stop is kept in `DATA_DIR`. Nothing starts the hard stop where the soft stop
  would do. A loss limit flattens (below), an error it does not understand or a control
  file it cannot read falls back to the soft stop, and the hard stop comes only from the
  operator or from an escalation: five errors it does not understand in a row at the soft
  stop (a good requote in between starts the count again), an error it does not
  understand while flattening, the wider loss limit, a flattening that fails or takes over
  ten minutes (three while the reference price is down, see below).
- **A loss limit flattens.** Past 3% of the day's start or 5% from the peak (counted at the
  worse of the venue's mark and the reference price) the maker works its position down
  with one reduce-only order, at most 25 bps through the fresh reference price, replaced
  at each requote. It pulls the order on a stale or disagreeing reference, a mark far from
  it or a fast move, rather than chase. Past 6% or 10%, or when an order fails, or when a
  position remains after ten minutes, it stops altogether. Reduce-only orders carry no
  program expiry (the venue sends none for them), so they stand until the maker cancels
  them at the next requote, at a stop of the service or at its next start.
  - **Flat means dark.** A flattening that completes leaves the maker with no position and
    quoting nothing, so new users find an empty book, until an operator resumes it. The
    breach alert says so when the flattening starts, and when the position reaches flat the
    log gets one more `ALERT` line: it has reduced its position to flat, quotes nothing
    until an operator resumes it, and to resume it run the kill switch with `resume` once
    the market has been checked (see "Resuming" below). That line is the end of a
    successful flattening, not a new problem.
  - **Midnight does not reset the loss line.** While the maker still holds a position to
    flatten, the UTC day's starting equity is kept across 00:00 UTC, so the 6% line keeps
    counting from where the day began. It starts the new day's count once the position is
    flat, or when an operator resumes it.
  - **While the reference price is down,** the loss limits are counted at the last good
    reference price from the past hour instead of the venue's mark, which may be stale. With
    no good reference price in the past hour they are counted at the worse of the mark and
    the last good price known (the mark alone if there never was one), and a flattening gets
    three minutes before it stops the maker, not ten.
- **A reduce-only market.** If the exchange admin sets the market to reduce-only, the
  maker cancels what it has and holds, placing nothing: the program never rests a
  reduce-only order, so only a flatten still goes out. No heartbeat is sent meanwhile, on purpose, so the outside monitor
  pages for as long as the market is reduce-only: that page means the market is
  reduce-only and the maker is working as designed. Any other reason the program refuses
  quotes (paused, a stale mark, a dislocation, a tripped USDC guard) holds all quotes back.
- **The kill switch** is a command on the machine the service runs on, with the service's
  `DATA_DIR`: `docker exec <container> node dist/kill-switch.js reduce`, `resume`, or
  `stop --confirm-strands-users`. `stop` is the hard stop and is refused without the flag,
  which names what it does. It writes a small file the maker reads every second, so it
  works while the API is busy, needs no network and no key, and a restart keeps what it
  set. Check the log for the line that says the maker followed it. If the file cannot be
  read, the maker holds itself at the soft stop with an `ALERT` and stays there after the
  file parses again, until a newer `resume` is written.
- **Resuming** after a loss limit: check the position, the market and the seat's equity
  first, and that the exchange's keeper is running. `resume` makes the loss limits count
  from the equity then, so it accepts the loss that stopped the maker. A maker that
  flattened successfully does not resume by itself: it stays dark, quoting nothing, until
  `resume` is run (`docker exec <container> node dist/kill-switch.js resume`).
- **Files in `DATA_DIR`:** `maker-NSOL-PERP.json` (mode, the equity the limits count from)
  and `maker-control.json` (the last kill switch request). If the first cannot be read, the
  service stops at start and says so: fix or move it away on purpose, since starting
  without it would forget the limits.
- **Outbound addresses the maker needs** (public, no key): `hermes.pyth.network`,
  `api.exchange.coinbase.com`, `api.kraken.com` and `www.okx.com`, on port 443. With one of
  them blocked the maker keeps quoting on the rest as long as Pyth and two exchanges
  answer; with Pyth blocked, or two of the exchanges, it pulls its quotes.

### The hedge controller on mainnet (off by default)

`HEDGE_ENABLED` is unset by default and nothing hedge-related runs. This repository contains
no client for a real hedge venue. With `HEDGE_ENABLED=1` the service loads one from a module
implementing the `HedgeVenue` interface, supplied separately and kept out of this repository:

- `HEDGE_VENUE_MODULE`: the absolute path of the module's JavaScript file. Required with
  `HEDGE_ENABLED=1`; a relative path or a missing file stops the start. Ignored, and never
  imported, when the hedge is off.
- `HEDGE_VENUE_*`: every other variable with this prefix is handed to the module with the prefix
  removed (`HEDGE_VENUE_API_URL` becomes `API_URL`). Values are never logged; errors name keys only.

The venue must declare `maxCallMs`, the longest one `placeIoc` or `cancel` call stays alive
before the module aborts it: a finite number above 0 and at most 30000 (half of the 60 s
late-dispatch quarantine). The service refuses to start without it. At start the service calls the venue's `health()` and `rules()` once and refuses to start if
either fails or returns nothing. Try the module by hand before enabling it. The settings, all
optional:

- `HEDGE_SOFT_UNHEDGED_NUSD` (100): unhedged exposure from which the hedge is lagging and the
  maker quotes 10 bps wider.
- `HEDGE_HARD_UNHEDGED_NUSD` (250): from which the hedge is blind and the maker pulls
  its quotes; only a flatten reduces the position. Must be above the soft limit, or the start is refused.
- `HEDGE_CONFIRM_TIMEOUT_SECONDS` (60): without a venue confirmation for this long the hedge
  is lagging, and with no answer from the venue at all for this long it is blind.
- `HEDGE_MAX_LEVERAGE` (3): the hedge position never grows past the hedge account's margin
  times this.

A blind hedge takes the maker fully dark: it pulls its quotes whatever its position, so it
quotes nothing. The same holds at startup, before the hedge venue has answered once. This
is an intended fail-safe. To start the maker without the hedge, unset `HEDGE_ENABLED` (or set it
to `0`) and restart the service.

What an operator sees: a line that says the maker's hedge is blind starts with `ALERT`; lines
about a lagging hedge, a venue that cannot be reached or answers again, a refused order or an
order of unknown outcome are notices. The kill switch covers the hedge: at the soft stop it
opens no new hedge, and at the hard stop it trades nothing and logs an `ALERT` that the hedge
position is unmanaged, so check that position on the venue and close it by hand if it should
not stay open. The hedge account's key is a separate hot key holding only the hedge margin.

## Do not change

Keep it at one replica, and never run a second copy with the same keys. Two processes
would move the same bots' order keys under each other, the fund limits are counted in one
process's memory, and where the liquidator runs, its sweep covers the seats this process
opened plus `LIQUIDATOR_EXTRA_SEATS`.
