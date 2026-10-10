# Load test on Solana devnet, 2026-10-10

What one client machine measured against the order book program on Solana devnet,
through MagicBlock's hosted private endpoint (`https://devnet-tee.magicblock.app`). Read
the caveats before quoting a number.

## Caveats, first

- **A shared test server.** Other people use the same endpoint. Its speed changed during
  the day with nothing changing on our side: the same 10-trader run took a median of
  535 ms in the morning and 908 to 1,040 ms two hours later.
- **One client machine**, a laptop in Europe (Apple M4, 10 cores, 32 GB, Node 26.10), over
  the public internet. The server's address is in Google's network and public
  geolocation puts it in Singapore (see "Where the server is"); a TCP round trip took
  215 to 222 ms. Every figure includes that distance.
- **The client waits for each result.** A trader's order is confirmed by reading the
  trader's own private view until the result shows, about every 50 ms plus the round
  trip. So each order costs several requests, and orders per second is bounded by the
  round trip and by how many requests the endpoint serves, not by the program.
- **The counterparty is the house maker** of the simulation service, which requotes every
  five seconds. Takers that outrun its quotes get a result with nothing filled. Fills are
  reported apart from confirmed results for that reason.
- **Test money on a test network.** Nothing here is user activity.
- The simulation service and its ten bots ran on the same laptop throughout and used the
  same endpoint. Another engineer was using the service from a browser during the
  morning's later runs.

## Method

`scripts/loadtest-rollup.ts` (`make loadtest VENUE=rollup`). Each trader is an ordinary
account with its own seat, private view and one-time order keys, opened and funded with
5,000 nUSD by the same open-and-deposit transaction the service's fund routes build
(for these runs signed directly with the gate and faucet keys, `--open keys`, so the
running service was not disturbed). Each trader sends immediate-or-cancel orders on
`NSOL-PERP`, 1% through the mark so they cross the maker's quotes, a little over the
1 nUSD minimum each, with the client's 5 second expiry. Every order is its own
transaction: a fresh one-time key, secret and id. One step is 120 seconds.

"Send to result" is the client's own timing, from sending the transaction to its result
showing in the trader's private view. "Late" is a result that took more than one second.
"Health" is how many of the 5-second samples of the service's `/v1/health` were ready
during the step. "Tape" compares the last fill sequence the service serves with the
chain's, six seconds after the step.

## Results

| Step    | When (CEST) | Traders x in flight | Sent  | Confirmed | Unknown | Expired | Refused by program | Requests timed out | Orders with a fill | Fills on chain | Confirmed/s | Median   | p95      | p99       | Max          | Over 1 s     | Health | Tape         |
| ------- | ----------- | ------------------- | ----- | --------- | ------- | ------- | ------------------ | ------------------ | ------------------ | -------------- | ----------- | -------- | -------- | --------- | ------------ | ------------ | ------ | ------------ |
| morning | about 08:00 | 10 x 1              | 932   | 932       | 0       | 0       | 0                  | 0                  | 786                | 913            | 7.7         | 535 ms   | 814 ms   | 1,012 ms  | not recorded | 12 (1.3%)    | 25/25  | not recorded |
| a       | about 09:38 | 10 x 1              | 606   | 605       | 0       | 0       | 1                  | 0                  | 489                | 597            | 5.0         | 908 ms   | 2,238 ms | 3,353 ms  | 8,727 ms     | 271 (45%)    | 18/24  | equal        |
| b       | about 09:34 | 25 x 1              | 1,256 | 1,256     | 0       | 0       | 0                  | 0                  | 999                | 1,108          | 10.3        | 1,067 ms | 2,603 ms | 3,970 ms  | 5,772 ms     | 688 (55%)    | 21/24  | equal        |
| c       | about 09:41 | 40 x 1              | 1,094 | 1,093     | 0       | 0       | 1                  | 0                  | 840                | 948            | 8.8         | 2,037 ms | 3,366 ms | 4,037 ms  | 4,426 ms     | 1,081 (99%)  | 23/24  | equal        |
| d       | about 09:44 | 40 x 4              | 1,909 | 1,526     | 0       | 0       | 63                 | 320                | 1,061              | 1,189          | 11.6        | 3,866 ms | 8,294 ms | 10,281 ms | 11,289 ms    | 1,526 (100%) | 25/26  | equal        |

The morning run read the mark once per order; steps a to d read it once a second for all
traders, so their orders per trader are not comparable with the morning's one to one. An
earlier attempt at step a, at 09:31, ran during a network failure on the client side
(median 1,296 ms, p95 10.7 s, health 9/24) and is kept only as raw JSON.

The endpoint answered no 429, no 403 and no 5xx in any step. In step d, 320 reads of a
trader's own view got no answer within the load test's 8 second request timeout; those
orders are counted as neither confirmed nor filled, and whether they executed was not
established. No order came back with an unknown outcome from the client, and none expired.

## What this supports

- **Sustained on the shared test server from one laptop:** 7.7 confirmed orders a second
  from 10 traders, one order in flight each, median 535 ms, p95 814 ms, 1.3% over a
  second, nothing expired or refused, for 121 seconds (the morning run).
- **First unclean step:** every step later in the morning. With 10 traders the median was
  already 0.9 s. Adding traders did not add throughput: 25, 40 and 160 orders in flight
  all landed between 8.8 and 11.6 confirmed orders a second while the median rose from
  1.1 s to 3.9 s, and at 160 in flight requests began to time out.
- So the ceiling seen from this one client, with this client's read-until-result
  confirmation, is **about 10 confirmed orders a second**, and the best latency is at 10
  orders in flight or fewer. Whether the limit is the endpoint's request handling, the
  rollup, or this laptop's single path to it was not separated; a second client machine,
  or a client that confirms over a subscription, would tell.
- The service stayed up in every step and its public tape matched the chain after each.
  Its health dipped during steps a and b (prices older than the 10 second limit while
  requests were slow).

## Where the server is

- `devnet-tee.magicblock.app` resolves to `34.87.52.79`.
- Reverse DNS: `79.52.87.34.bc.googleusercontent.com`. Whois: Google LLC (`GOOGL-2`,
  `34.64.0.0/10`), registered address Mountain View, US, which is the owner's office, not
  the server.
- ipinfo.io places the address in Singapore (AS396982, Google Cloud).
- TCP connect from the laptop in Europe, 20 tries: median 215 to 222 ms, minimum 215 ms.

How reliable: the owner (Google Cloud) is certain. Singapore comes from one public
geolocation database and is consistent with a 215 ms round trip from central Europe, but
it is an inference, not a statement by the operator. Before choosing a region, measure
from candidate regions (the bots' `latency.medianMs` in `/v1/stats`), as
[deploy.md](deploy.md) describes.

## Seats used

The exchange opens 100 new seats a day. Today: 10 bots, 3 test users, 10 load-test
traders from the first run, and 40 for these steps: 63. The first ten load-test traders
can no longer be used: a faulty invocation of the load test overwrote the file holding
their keys. The load test now only ever adds to that file. The 40 are in
`data/loadtest-traders.json` and are reused by every later run.

## Raw reports

`loadtest-reports/` (git-ignored): `devnet-step-a-10x1.json`, `devnet-step-b-25x1.json`,
`devnet-step-c-40x1.json`, `devnet-step-d-40x4.json`,
`devnet-earlier-10x1-price-read-per-order.json` (the morning run) and
`devnet-step-a-10x1-degraded-0931.json`.

## Repeat it

```sh
K=../orderbook-noirwire/.keys
DEPLOYMENT_PATH=$K/devnet-deployment.json GATE_SECRET_KEY_FILE=$K/devnet-gate.json \
FAUCET_SECRET_KEY_FILE=$K/devnet-faucet.json npx tsx scripts/loadtest.ts --venue rollup \
  --traders 10 --in-flight 1 --seconds 120 --open keys --label devnet-step-a-10x1 \
  --sim-url http://127.0.0.1:4100 \
  --rollup-rpc https://devnet-tee.magicblock.app --rollup-ws wss://devnet-tee.magicblock.app \
  --allow-rpc https://devnet-tee.magicblock.app --allow-rpc wss://devnet-tee.magicblock.app
```
