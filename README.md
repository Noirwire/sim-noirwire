# sim-noirwire

One always-on Node service that makes the NoirWire test-network order book feel alive and
measurable. It never runs against a real-money network: the markets are real prices on
test tokens, traded by a house market maker and a handful of noise-trading bots, with the
numbers reported over HTTP and one websocket.

Full design: [docs/DESIGN.md](docs/DESIGN.md).

## What it does

1. **Prices in.** With `VENUE=memory`, polls Jupiter's price API v3 (no key) for SOL and
   NVDAx every couple of seconds and publishes them to the in-process order book. With
   `VENUE=rollup` the mark is the program's own, read from chain.
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
in-process engine: every bot is an ordinary trader with its own seat and one-time order
keys, and the tape, marks and counters are read back from the chain. The marks and
funding are the program's own; this service publishes no price. How it works: [docs/DESIGN.md](docs/DESIGN.md), "The rollup venue".

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

| Variable                                                                 | Required   | What it is                                                                                                                                                   |
| ------------------------------------------------------------------------ | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `SOLANA_RPC_URL`                                                         | yes        | Solana. Checked once at start against `NETWORK`: mainnet only with `NETWORK=mainnet`                                                                         |
| `ROLLUP_RPC_URL`, `ROLLUP_WS_URL`                                        | yes        | The rollup's private endpoint through the query filter, and its websocket                                                                                    |
| `DEPOSIT_RPC_URL`                                                        | no         | Overrides where deposits are sent; by default the deployment's `depositUrl`                                                                                  |
| `PUBLIC_SOLANA_RPC_URL`, `PUBLIC_ROLLUP_RPC_URL`, `PUBLIC_ROLLUP_WS_URL` | no         | The URLs `GET /v1/deployment` tells browsers to use; by default the service's own                                                                            |
| `DEPLOYMENT_PATH` or `DEPLOYMENT_JSON`                                   | yes        | The deployment description the order book repository's set-up prints                                                                                         |
| `GATE_SECRET_KEY`, `FAUCET_SECRET_KEY`                                   | yes        | Secret keys as JSON arrays of 64 bytes: co-sign openings, deposit (faucet: only if any)                                                                      |
| `GATE_SECRET_KEY_FILE`, `FAUCET_SECRET_KEY_FILE`                         | instead    | The path of each keypair file, in place of the key itself, for a run on your own machine                                                                     |
| `BOT_TRADER_SEEDS`                                                       | yes        | One 32-byte hex seed per bot trader, comma separated (10 with the defaults)                                                                                  |
| `NOISE_TAKERS_ENABLED`, `LIQUIDATOR_ENABLED`                             | no         | `0` opens and starts none of them, leaving the house makers alone (both `1` by default)                                                                      |
| `SERVICE_LOCATION`                                                       | no         | Where the service runs; labels the latency figure                                                                                                            |
| `HOUSE_MAKER_RISK_RULES`                                                 | no         | `1` makes the house maker follow the risk rules (always on, mainnet; see below)                                                                              |
| `IDLE_AFTER_MS`                                                          | no         | How long the service keeps trading after the last request, with no socket (10 minutes)                                                                       |
| `IDLE_AFTER_LAST_SOCKET_MS`                                              | no         | How long it keeps trading after the last stream socket closes (15 seconds)                                                                                   |
| `HEALTHCHECK_URL`                                                        | no         | An address the maker calls after a good requote, at most every 15 s, for an outside monitor                                                                  |
| `KEEPER_HEARTBEAT_FILE`, `KEEPER_HEARTBEAT_MAX_AGE_MS`                   | mainnet    | The keeper writes the time of its last healthy sweep (Unix ms) here; trading is not ready when it is old or missing (30 s)                                   |
| `HEDGE_ENABLED`                                                          | no         | `1` runs the hedge controller (off by default; needs the risk rules; see "The hedge controller")                                                             |
| `HEDGE_VENUE_MODULE`, `HEDGE_VENUE_*`                                    | with hedge | Absolute path of the hedge venue module (required with `HEDGE_ENABLED=1`, ignored otherwise); every other `HEDGE_VENUE_*` is passed to it without the prefix |
| `HEDGE_SOFT_UNHEDGED_NUSD`, `HEDGE_HARD_UNHEDGED_NUSD`                   | no         | Unhedged exposure that makes the hedge lagging (100) and blind (250); soft must be below hard                                                                |
| `HEDGE_CONFIRM_TIMEOUT_SECONDS`, `HEDGE_MAX_LEVERAGE`                    | no         | Seconds without a venue confirmation before lagging (60); margin cap as a multiple of the hedge account's margin (3)                                         |
| `ROLLUP_MAKER_LEVEL_NUSD`, `ROLLUP_TAKER_MIN_NUSD` / `_MAX_`             | no         | Bot order sizes as notional                                                                                                                                  |
| `LIQUIDATOR_SEATS_PER_TICK`, `LIQUIDATOR_EXTRA_SEATS`                    | no         | Seats the liquidator tries blind per market per tick; seats this service did not open                                                                        |

### Mainnet mode

`NETWORK=mainnet` runs only what a live market needs: the house maker, the gate and the
read-only market data API. It never starts a faucet, noise takers, the test liquidator, a
price publisher or the test endpoints, and it stops at start-up, naming everything wrong
at once, if any of them is configured. No other `NETWORK` value changes behaviour: it stays
a label, and a service whose `SOLANA_RPC_URL` is mainnet but whose `NETWORK` is not
`mainnet` still refuses to start.

What mainnet requires (the service says which is missing):

- `VENUE=rollup`, and a Solana at `SOLANA_RPC_URL` whose genesis hash is mainnet's.
- Everything secret or definitive comes from a mounted file, never an environment
  variable's content: `GATE_SECRET_KEY_FILE`, `BOT_TRADER_SEEDS_FILE` (hex seeds, one per
  line or comma separated) and `DEPLOYMENT_PATH`. `GATE_SECRET_KEY`, `BOT_TRADER_SEEDS` and
  `DEPLOYMENT_JSON` are refused.
- The deployment description must be a mainnet one: `network` is `mainnet`, no faucet, and
  the quote token is the real USDC mint.
- `PUBLIC_SOLANA_RPC_URL`, `PUBLIC_ROLLUP_RPC_URL` and `PUBLIC_ROLLUP_WS_URL`, different
  from the private three and carrying no user name, password or query string. The rollup pair
  may equal its private address only when that is exactly `https://mainnet-tee.magicblock.app`
  for the RPC address and `wss://mainnet-tee.magicblock.app` for the websocket, with no
  trailing slash, since that endpoint signs each user in with their own token. These are the
  only addresses `GET /v1/deployment` serves; the private ones may hold an API key and are
  never served. They are also hidden from every logged or served error text.
- `TRUSTED_PROXY_HOPS`: how many reverse proxies sit in front (`0` if none), so the
  per-IP limits see the caller and not the proxy.
- `GATE_INVITES_FILE`: the invite list the gate signs for (see "The gate" below). An
  empty file is valid and admits nobody.
- An empty `DATA_DIR`, or one a mainnet run saved: a snapshot from another network is
  refused. It must be a disk that survives restarts, because the gate's record of the
  seats it signed for lives in it.

While it runs: the service is never put to sleep (the maker quotes whether or not anyone is
watching); `/v1/fund/*` and `/v1/dev/*` answer 404, and `/v1/open/*` is the only route that
writes; markets, tape and candles carry
`simulated: false` and the quote is `USDC`; each address is limited to
`PUBLIC_RATE_LIMIT_PER_MINUTE` requests a minute (429 with `retry-after`) and
`PUBLIC_SOCKETS_PER_IP` open stream sockets; and `GET /v1/health` is the container's
health probe (the image's `HEALTHCHECK` already calls it).

#### The gate: who gets an account on mainnet

The gate co-signs `open_trader`, the transaction that gives a person a seat on the
exchange. On mainnet it signs only for invited people. Devnet is unchanged: it keeps the
fund routes and signs for anyone, within its per-IP limit.

A person opens an account in two requests, like the devnet fund button but with no grant
(they deposit their own USDC in a transaction of their own):

1. `POST /v1/open/prepare` with `{ owner, orderKeys: [4 keys], invite? }`. If the rules
   below say yes, the answer is `{ transaction, expiresAtMs }`: one transaction whose only
   instruction is `open_trader`, with the gate as fee payer, already signed by the gate
   (wallets only leave a transaction alone when it carries a signature) and waiting for
   the owner's.
2. `POST /v1/open/submit` with `{ owner, transaction }`, the same transaction signed by
   the owner. The gate checks it is byte for byte the one it prepared, that the gate's
   signature is still on it and every signature is valid, checks the rules again, writes
   the seat down on disk, and only then sends it. The answer is `{ reference }`.

A prepared transaction is signed by the gate, so whoever holds it and the owner's
signature could send it to the rollup without calling submit. It can only open a seat for
that same invited owner, it expires with its blockhash, and the program's own daily seat
limit still counts it; the gate's seat record and per-address counts would not.

The rules, in the order they are checked. A refusal says why in `error` and what to do:

| Status | Why                                                                                                  |
| ------ | ---------------------------------------------------------------------------------------------------- |
| 403    | The owner key is not on the invite list, the invite needs its code and none was sent, or it is wrong |
| 409    | The invite was used already (an invite opens one account), or the owner key already has an account   |
| 503    | The day's seats are all given out, the service is still starting, or the seat could not be recorded  |
| 429    | This network address has opened its account for the day                                              |

**The invite list** is a text file the operator edits, named by `GATE_INVITES_FILE`. It is
read again whenever its size or modified time changes, so adding or removing a line needs
no restart and takes effect on the next request. One entry per line, `#` starts a comment:

```
# an owner key invited by address
<owner public key>
# an invite code (12 to 64 letters, digits, - or _), good only for the key after it
launch-friends-0001 <owner public key>
```

A line that cannot be used is logged with its line number and left out, and a code given
to two keys is left out entirely, so a typo admits nobody rather than the wrong person. If
the file cannot be read after it once could, nobody is admitted until it can be again. A
missing file stops the start. A code is a secret the person must send as `invite`; a key
line needs nothing but the key.

**At most one seat per invite.** Each seat the gate signs for is written to `gate-seats.json`
in `DATA_DIR` before the signature goes on, under its invite (the key, or a hash of the
code). That file is what makes an invite single use and what the limits count, so a restart
does not reset them. If it exists and cannot be read, the service does not start, because
starting would forget who already has a seat. Back it up with the rest of `DATA_DIR`. A seat
the rollup refused, or that never left the gate, is taken out again and the invite works
again; a seat that was sent and never confirmed stays on record, can be tried again, and
counts once however many times it is tried. If the rollup then answers that the account exists
already, the earlier try did open it, and the seat is kept. It keeps no network address, only a
short keyed hash of one, and drops even that once its UTC day is over. The key is
`gate-seats.json.key`, created on the first seat with mode 0600 and read by this service alone.
If the key file is lost or damaged, delete it: the day's count per address then starts over.

**Limits per day** (a UTC day, like the program's own):

- `GATE_SEATS_PER_DAY` (default 3): accounts the gate signs for. The limit that applies is
  the smaller of this and one under the exchange's `max_seats_per_day`, which the service
  reads from the chain, so the program's own limit is never the first to refuse and one
  seat stays free for the operator. Until the service has read the exchange it signs
  nothing.
- `GATE_SEATS_PER_IP_PER_DAY` (default 1, not more than the one above): accounts for one
  network address. With `TRUSTED_PROXY_HOPS` set right, that is the caller's address.

Seats opened by the operator's own keys count in the program's limit but not in these;
leave room for them when you set `max_seats_per_day`.

**What is logged.** One line per decision, to the service's log, with the owner's public
key and nothing else about the person: no invite code, no network address.

```
sim-noirwire: gate: <owner public key> prepare admitted
sim-noirwire: gate: <owner public key> submit admitted, sending
sim-noirwire: gate: <owner public key> account opened
sim-noirwire: gate: <owner public key> prepare refused: this address is not on the invite list. Ask for an invite, then try again
```

**The files and settings the gate needs on mainnet,** and how the deployment provides them:

| What                                                | Where it comes from                                                                                                                                                                                 |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GATE_SECRET_KEY_FILE`                              | A keypair file mounted read-only. It must be the gate key the exchange names, and the service user must be able to read it                                                                          |
| `GATE_INVITES_FILE`                                 | The invite list. Mount the folder that holds it, read-only, not the single file: an editor that saves by replacing the file leaves a one-file mount looking at the old copy, and edits never arrive |
| `DATA_DIR`                                          | A writable folder that survives restarts and redeploys. Holds `gate-seats.json` and the maker's files. Wiping it forgets who has a seat                                                             |
| `GATE_SEATS_PER_DAY`                                | Environment variable, optional                                                                                                                                                                      |
| `GATE_SEATS_PER_IP_PER_DAY`                         | Environment variable, optional                                                                                                                                                                      |
| `TRUSTED_PROXY_HOPS`                                | Environment variable, required: without the right number the per-address limit counts the proxy as the one caller                                                                                   |
| `ALLOWED_ORIGINS`                                   | Environment variable: the terminal's origin, so a browser may call `/v1/open`                                                                                                                       |
| `SOLANA_RPC_URL`, `ROLLUP_RPC_URL`, `ROLLUP_WS_URL` | Environment variables as for the rest of mainnet. The gate sends the opening through the rollup endpoint as the gate key, signed in the same way as the maker                                       |

The gate key needs no funds; it co-signs only `open_trader`, and the program bounds a
stolen one to `max_seats_per_day` seats a day. To change which key is
the gate, the exchange's admin sends `update_exchange`, then the file is replaced and the
service restarted.

#### The maker's risk rules

On mainnet the house maker always follows its risk rules (`HOUSE_MAKER_RISK_RULES=1`, which
elsewhere is off by default and on mainnet cannot be set to 0):

- **Quotes expire.** Every resting order carries the program's own expiry, the requote
  interval plus 10 s, so a maker that dies leaves no quote standing for longer than that.
  A stop of the service cancels its quotes first.
- **A reference price.** It quotes around the median of Pyth's latest price (Hermes) and
  the public tickers of Coinbase, Kraken and OKX, not around the NoirWire mark. It needs the
  oracle and at least two exchanges, none older than 10 s, within 30 bps of each other; else
  it pulls its quotes and, once the prices are back, watches them for 10 s before quoting.
- **Widen and pull.** The half-spread is at least 15 bps and grows by half the price range
  of the last minute. A NoirWire mark more than 10 bps behind the reference widens it by
  the gap; more than 100 bps behind, or a move of more than 0.5% in 10 s, pulls the quotes
  until it settles.
- **Sizes.** Every level holds `ROLLUP_MAKER_LEVEL_NUSD`. Unset on mainnet, the sizes are
  3 levels of 50 nUSD, a position limit of 250 nUSD, a requote at 6 bps or every 10 s.
  Larger than 500 nUSD a level, 250 nUSD of position, a 15 bps floor or a 30 s requote
  interval stops the start.
- **Loss limits flatten the position.** Losing 3% of the equity the UTC day started with,
  or 5% from the peak (both counted at the worse of the venue's mark and the reference
  price), makes it stop growing and work its position down to flat. It places one
  reduce-only order for the whole position, at most 25 bps through the fresh reference
  price, and replaces it at every requote. It never chases: with a stale or disagreeing
  reference, a mark far from it or a fast move, it pulls the order like any other quote.
  It logs a line that starts with `ALERT`. If an order fails, the loss reaches 6% of the
  day's start or 10% from the peak, or it still holds a position ten minutes after it
  began, it stops quoting altogether (the hard stop below), with another `ALERT`. A
  flattening that works leaves the maker flat and dark: it quotes nothing, so new users
  find an empty book, until an operator resumes it, and the log says so in an `ALERT` line
  when the position reaches flat. The state is kept in `DATA_DIR`, so a restart does not
  reset it, and only an operator ends it. While it still holds a position to flatten, the
  UTC day's starting equity is kept across midnight, so the 6% line does not move. While
  the reference price is down, the limits are counted at the last good reference price
  from the past hour instead of the venue's possibly stale mark; with none that recent
  they are counted at the worse of the mark and the last good price known, and a
  flattening gets three minutes, not ten.
- **Reduce-only markets.** When the program has set the market to reduce-only, the maker
  cancels what it has and holds, placing nothing: the program never rests a reduce-only
  order and refuses a post-only one that is reduce-only, so there is no quote it could
  leave that only shrinks its position. Only a flatten (after a loss limit) still goes
  out, as a crossing reduce-only order. The maker sends no heartbeat meanwhile (see "A
  heartbeat" below), so the outside monitor pages until the market opens again. For
  any other reason the program would refuse its quotes (paused, a stale mark, a tripped
  guard, a dislocation) it sends nothing. A reduce-only order carries no program expiry,
  so the maker's own cancels (at every requote and at a stop of the service) are what
  remove it.
- **Kill switch, two stops.** `npm run kill-switch -- reduce | resume | stop
--confirm-strands-users` (or `node dist/kill-switch.js ...` in the container) writes a
  request into `DATA_DIR` that the maker follows within a second.
  - `reduce` is the soft stop. It pulls its quotes and places none; only a flatten
    reduces the position.
  - `stop` is the hard stop. It cancels everything and quotes nothing, so **users cannot
    close a position until the maker is resumed**. The exchange admin can pause the market
    in the meantime. A restart does not resume it, since the stop is kept in `DATA_DIR`.
    The command refuses to run without `--confirm-strands-users`, and logs an `ALERT` that
    says what it does to users.
  - `resume` starts again with the loss limits counting from the equity then.
- **No liquidator here on mainnet, on purpose.** This service never runs a liquidator on
  mainnet (`LIQUIDATOR_ENABLED=1` is refused at start). Liquidation of under-margined
  seats is the order book repository's keeper, which runs separately and which this
  service does not start. It does watch the keeper's heartbeat file
  (`KEEPER_HEARTBEAT_FILE`): trading is not ready when the keeper has not completed a
  healthy sweep within `KEEPER_HEARTBEAT_MAX_AGE_MS`, and every maker pulls its quotes
  and places none, with one `ALERT` line, until the heartbeat is fresh again (a notice says
  so); only a flatten trades the position down. The first second after a start
  or a wake, before the heartbeat has been read, is reduce-only too, but says nothing. A stopped maker does not stop that keeper, but users
  cannot close against a stopped maker, so a hard stop leaves them to be liquidated or to
  wait.
- **Errors it does not understand.** While sending orders, any failure other than the
  rollup being away makes the maker fall back to the soft stop (an `ALERT` line, quotes
  cancelled and none placed until an operator resumes it). The soft stop sends no orders,
  so it meets no further send errors; one while it is flattening stops it altogether at
  once, since a flattening that cannot place its order is not working. Either lasts until
  an operator resumes it. A failed cancel is tried again on the next tick.
- **An unreadable control file.** A control file that cannot be read holds the maker at the
  soft stop (an `ALERT` line). It stays there after the file parses again, until a newer
  `resume` is written. A hard stop or a flattening already in force is not loosened.
- **A heartbeat.** With `HEALTHCHECK_URL` set, the maker calls that address after a
  requote of both sides, at most once every 15 s (a monitor such as healthchecks.io takes
  five pings a minute per check). It sends none while a loss limit, the kill switch or a
  reduce-only market has it reducing only, so the outside monitor alerts when the calls
  stop: the maker is stopped, reducing, pulled, stuck or the machine is down. **A
  reduce-only market silences the heartbeat on purpose,** so a monitor page while the
  program's market is reduce-only is understood, not ignored: the maker has pulled its
  quotes, as designed, and the calls start again with the
  first full requote after the market opens. A failed call is logged without the address
  and never stops the maker.
- **The position limit counts everything.** The position and a side's resting levels
  together never pass the limit: the level that would is cut to what is left and later ones
  are left out.
- **The edge holds under skew.** No quote sits closer than 15 bps to the reference price,
  even at the full skew, so the side that shrinks the position is still sold at an edge.

The risk rules cover SOL perpetuals only; the service refuses to start the maker on any
other market with them on.

#### The hedge controller

An optional controller keeps the maker's net SOL exposure near flat by trading the offsetting
position on an outside perpetuals venue. It is **off unless `HEDGE_ENABLED=1`**: with it unset
nothing hedge-related runs and the maker behaves exactly as before. It needs the risk rules
(`HOUSE_MAKER_RISK_RULES=1`) and a hedge venue. This repository ships only the venue
interface (`src/hedge/hedge-venue.ts`); the venue itself comes from a module implementing that
interface, supplied separately and kept out of this repository.

- **`HEDGE_VENUE_MODULE`** is the absolute path of that module's JavaScript file. It is required
  with `HEDGE_ENABLED=1` and ignored, never imported, when the hedge is off. A relative path or a
  missing file stops the start. The module's default export is a function
  `createVenue(config: Record<string, string>): Promise<HedgeVenue>`.
- **`HEDGE_VENUE_*`** settings are passed to that function: every environment variable starting
  with `HEDGE_VENUE_`, except `HEDGE_VENUE_MODULE`, with the prefix removed (`HEDGE_VENUE_API_URL`
  arrives as `API_URL`). Their values are never logged; start-up errors name only the keys.
- **Start-up checks.** The service refuses to start if the module cannot be imported, does not
  export the function, returns something that lacks any `HedgeVenue` method, does not declare
  `maxCallMs` (a finite number above 0 and at most 30000: the longest one `placeIoc` or `cancel`
  call stays alive before the module aborts it), or if the venue's `health()` or `rules()` fails
  or returns nothing.

- **What it sends.** Each tick it reads the maker's position and the venue's real position and
  sends at most one immediate-or-cancel order that works the difference toward zero, priced at
  most 20 bps through the reference price. The size is rounded down to the venue's increment.
  The venue's minimum order notional is read from the venue: smaller differences are left alone
  until they add up to one. The hedge position never grows past the hedge account's margin times
  `HEDGE_MAX_LEVERAGE`, and nothing is sent without a trusted reference price.
- **It never trusts an order's answer.** After every order it reads the venue's position again.
  A partial fill is just what is left to hedge on the next tick. An order whose outcome is unknown
  (no answer, or accepted with no change in the position yet) is not sent again for 10 s, and a
  refused one for 5 s.
- **Status the maker reads.** `ok`; `lagging` when the unhedged exposure reaches
  `HEDGE_SOFT_UNHEDGED_NUSD` or the venue has confirmed nothing for `HEDGE_CONFIRM_TIMEOUT_SECONDS`;
  `blind` when the venue cannot be reached (or says it is not trading), the controller has not
  heard from it within that timeout, or the unhedged exposure reaches `HEDGE_HARD_UNHEDGED_NUSD`.
  Before the venue has answered once, the status is `blind`.
  - Lagging: the maker quotes 10 bps wider.
  - Blind: the maker stops growing its position and pulls its quotes, with an
    `ALERT` line; only a flatten reduces the position. Both end by themselves once the venue
    confirms the hedge again.
  - So while the hedge is blind the maker quotes nothing at all. That includes startup: with the hedge enabled, the maker quotes nothing until
    the hedge venue has answered once. This is an intended fail-safe, not a fault. To run the
    maker without the hedge, unset `HEDGE_ENABLED` (or set it to `0`) and restart.
- **The kill switch covers the hedge.** At the soft stop, and while the maker flattens, the
  controller opens no new hedge exposure and only shrinks the hedge as the maker's position
  shrinks. At the hard stop it trades nothing and logs an `ALERT` that the hedge position is
  left as it is and is unmanaged: close it by hand on the venue if it should not stay open.

### Awake and asleep

A hosted rollup endpoint rate-limits a client that never stops asking, so with
`VENUE=rollup` the service only works while somebody wants it to. After its one-time
start-up work (connect, open and fund the bots) it is **asleep**: no bot loops, no reads of
the chain, no websocket to the rollup. Snapshots keep being saved.

- **Wakes** on any request to the public API (markets, tape, candles, stats, deployment, fund)
  and on an open `/v1/stream` socket. `/v1/health` and paths that match no route do not wake it.
  The request that wakes it does not wait: `/v1/markets` reports every market as `warmingUp`
  until the chain is followed again and the loops run.
- **Stays awake** while any stream socket is open, and for `IDLE_AFTER_MS` (10 minutes) after
  the last request. When the last socket closes (the page was closed) it sleeps after
  `IDLE_AFTER_LAST_SOCKET_MS` (15 seconds, enough for a reload), whatever requests came before.
- **Starts asleep**, unless a request arrives while it starts.
- `VENUE=memory` sends nothing outside the process, so it never sleeps.

If the rollup refuses or is away at start-up, the HTTP API still starts and serves what needs
no rollup (tape, candles and stats from the snapshot). `/v1/health` answers 503 with a
`reason`, `/v1/markets`, `/v1/deployment` and the fund routes answer 503, and the start-up
work is retried after 5 s, 10 s, 20 s and so on up to 5 minutes, but only while somebody is
using the service: with nobody around, a refusing host is left alone after the first try.
What a failed try opened is stopped before the next one. The rollup websocket
reconnects on the same schedule, and a loop that keeps failing is asked less often (at most
every 30 s) until it works. Logs say when something starts failing, a summary once a minute
while it goes on, and when it works again.

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
| `NETWORK`                                       | `devnet`                | The label every response carries; `mainnet` switches on the mainnet mode (above)     |
| `ALLOWED_ORIGINS`                               | `http://localhost:3000` | Comma-separated CORS allow-list                                                      |
| `DATA_DIR`                                      | `./data`                | Where candles and fund grants are snapshotted                                        |
| `FUND_AMOUNT_NUSD`                              | `5000`                  | One-time grant size                                                                  |
| `FUND_IP_RATE_LIMIT` / `FUND_IP_RATE_WINDOW_MS` | `20` / `3600000`        | Per-IP cap on fund grants                                                            |
| `GATE_INVITES_FILE`                             | none                    | Mainnet, required: the invite list the gate signs for (see "The gate")               |
| `GATE_SEATS_PER_DAY`                            | `3`                     | Mainnet: accounts opened a UTC day, always below the program's own limit             |
| `GATE_SEATS_PER_IP_PER_DAY`                     | `1`                     | Mainnet: accounts opened a UTC day for one network address                           |
| `JUPITER_POLL_INTERVAL_MS`                      | `4000`                  | How often every market's price is fetched, in one request                            |
| `HOUSE_MAKER_*`                                 | see file                | Ladder depth, spread, requote thresholds, position limit, skew                       |
| `NOISE_TAKER_*`                                 | see file                | How many bot traders, how often, how big                                             |
| `LIQUIDATOR_INTERVAL_MS`, `FUNDING_INTERVAL_MS` | `60000`, `60000`        | Scan/update cadence                                                                  |

## API

Prefix `/v1`. Every price, size and balance in a response is a plain decimal string (never
a float, never a raw `bigint`), scaled from the engine's internal fixed-point integers.

| Route                                                    | Returns                                                                                                                                                                                                                                                                                                                      |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /health`                                            | `{ ok, venue, network, awake }`. With `VENUE=rollup` also `connected`, `pricesFresh`, `botsFunded` and, while it is failing, `reason`. 503 until start-up is done and the bots are funded, and while awake also until `connected` and `pricesFresh`. An asleep service is healthy with stale prices. Never wakes the service |
| `GET /markets`                                           | Per market: id, kind, names, tick, lot, max leverage, mark price, 24h change, 24h volume, open interest, and `warmingUp` (true with `VENUE=rollup` while the service wakes, until it follows the chain again)                                                                                                                |
| `GET /deployment`                                        | `VENUE=rollup` only, public, cacheable. Program id, the URLs a browser should use, exchange and stats addresses, and per market its on-chain id, addresses, token mints, decimals, lot size and tick. No key. Fields: [docs/DESIGN.md](docs/DESIGN.md)                                                                       |
| `GET /tape?market=&limit=`                               | Latest fills: price, size, taker side, time, sequence, both tags - never a trader identity. With `VENUE=rollup` `makerTag` and `takerTag` are the chain's 8-byte receipts as big-endian unsigned decimal text                                                                                                                |
| `GET /candles?market=&interval=1m\|5m\|15m\|1h&limit=`   | OHLCV candles                                                                                                                                                                                                                                                                                                                |
| `GET /stats`                                             | Orders, fills, volume (user and bot counted separately), traders, latency (median, p99, sample size, where measured), updated at. With `VENUE=rollup` also `botOrdersOutcomeUnknown`: bot orders whose outcome was not known in time, and how many of them settled as executed late or as expired                            |
| `POST /fund` `{ address }`                               | `VENUE=memory` only. `{ amount, reference }`; one grant per address, rate limited per IP                                                                                                                                                                                                                                     |
| `POST /fund/prepare`, `POST /fund/submit`                | `VENUE=rollup` only, not on mainnet. The same grant in two steps, signed by the user (see "Run on the real program")                                                                                                                                                                                                         |
| `POST /open/prepare`, `POST /open/submit`                | `NETWORK=mainnet` only. Opens an account for an invited person, no funds, in two steps signed by the user (see "The gate: who gets an account on mainnet")                                                                                                                                                                   |
| `WS /stream?market=`                                     | `price`, `fill`, `candle`, `stats` messages for one market (`stats` goes to every subscriber)                                                                                                                                                                                                                                |
| `POST /dev/orders`, `/dev/cancel-all`, `GET /dev/trader` | Trade against `MemoryVenue` directly. Only registered when `VENUE=memory` and `DEV_TRADING=1`                                                                                                                                                                                                                                |

## How numbers are labelled

- Every market, tape, candle and stats response carries `network`, and the market, tape and
  candle responses carry `simulated`: `true`, except on `NETWORK=mainnet`, where the data is
  live and it is `false`.
- Bot volume, bot orders and bot fills are counted in their own bucket, never merged with a
  user's. The house maker and noise takers trade as `bot:maker:<market>`, `bot:taker:<n>`
  and `bot:liquidator`; a fill never carries a trader identity at all (only two opaque
  64-bit tags), so bot/user classification for a fill happens server-side against a
  registry of tags this service itself handed out to a bot order.
- A latency figure states where it was measured from (`measuredFrom`).

## Development

| Command            | What it covers                                                                                                                                                                                                                                                   |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `make test`        | The vitest suite: matching engine, perp margin/funding/liquidation, a 3,000-operation property test, the house maker, candle bucketing, the HTTP API, and the rollup venue's logic without a network (tape tracking, order translation, the fund desk, settings) |
| `make check`       | `eslint`, `tsc --noEmit`, `prettier --check`                                                                                                                                                                                                                     |
| `make build`       | Compiles `src/` to `dist/`                                                                                                                                                                                                                                       |
| `make loadtest`    | Drives `MemoryVenue` with `LOADTEST_TRADERS` concurrent traders for `LOADTEST_SECONDS`, writes `loadtest-reports/latest.{json,md}`                                                                                                                               |
| `make test-rollup` | Starts the local network, sets it up, runs the service on it and asserts prices, fills, the fund flow, the websocket and the bot/user split                                                                                                                      |

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
               connections and timeouts, transactions, one market's state, the chain feed,
               tape tracker, bot accounts and order secrets, translation
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
