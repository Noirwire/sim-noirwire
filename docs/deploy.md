# Deploying on Railway

One Railway service, `sim`, running `VENUE=rollup` against MagicBlock's public devnet
endpoints. There is no local network in this deployment. Everything except nine values is
code: `.railway/railway.ts` (builder, health check, restart policy, one replica, the data
volume) and the defaults in `src/config/config.ts`.

Not done yet, stated plainly: this file has not been applied, and the service has never
run against devnet. Read "Before the first deploy" before trusting it.

## What must already exist on chain

The order book repository sets all of this up (`make devnet-setup` there) and prints the
deployment description this service reads:

1. The program deployed at its declared address, and the exchange delegated to the rollup.
2. The ledger, the stats account and the three markets (`NSOL-PERP`, `NNVDA-PERP`,
   `NSOL-NUSD`), each with a first price published and funding scheduled on the perps.
3. The two test mints with their custody accounts, and a faucet key holding test nUSD and
   nSOL inside the rollup. The bots take about 3,000,000 nUSD and 16,000 nSOL at their
   first start; every user grant takes 5,000 nUSD.
4. The gate, oracle and faucet keys that set-up wrote under `.keys/` in that repository.
   This service needs all three secret keys.

## Keys

| Variable            | What it is                                                   | Where it comes from                                                                                      |
| ------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `ORACLE_SECRET_KEY` | Publishes every market's price                               | `.keys/devnet-oracle.json` from the order book repository, the JSON array on one line                    |
| `GATE_SECRET_KEY`   | Co-signs every account opening                               | `.keys/devnet-gate.json`, same form                                                                      |
| `FAUCET_SECRET_KEY` | Holds the test tokens and signs every deposit                | `.keys/devnet-faucet.json`, same form                                                                    |
| `BOT_TRADER_SEEDS`  | One 32-byte seed per bot trader, in hex, separated by commas | Generate: `for i in $(seq 10); do openssl rand -hex 32; done \| paste -sd, -` (10 with the default bots) |

The service checks at start that the first three are the keys the deployment description
names, and refuses to start otherwise. A bot's seed is its owner key: keep the seeds, or
the bots' balances stay behind in seats nobody can sign for. The count is three makers,
`NOISE_TAKER_COUNT` takers (six by default) and one liquidator. Keep all four values in
Railway only, sealed. Nothing logs them.

## Steps

1. Railway CLI 5.42.1 or newer, logged in, with Railway's GitHub app allowed to read this
   repository.
2. `railway link` (choose the project), then `railway add --service sim`.
3. In the dashboard, open `sim`, Variables, Raw Editor, and paste the block below with
   your values.
4. `(cd .railway && npm install) && railway config apply`. Railway builds from GitHub now
   and on every push to `main`. The volume `sim-data` is mounted at `/app/data`.
5. `railway domain --service sim`, then point the terminal at that domain.

```
ALLOWED_ORIGINS=https://<the terminal's origin>
SOLANA_RPC_URL=https://api.devnet.solana.com
ROLLUP_RPC_URL=https://devnet-tee.magicblock.app
ROLLUP_WS_URL=wss://devnet-tee.magicblock.app
DEPLOYMENT_JSON=<the whole of .keys/devnet-deployment.json, on one line>
ORACLE_SECRET_KEY=<JSON array of 64 bytes>
GATE_SECRET_KEY=<JSON array of 64 bytes>
FAUCET_SECRET_KEY=<JSON array of 64 bytes>
BOT_TRADER_SEEDS=<seed>,<seed>,...
```

Set by the code, not by hand: `VENUE=rollup`, `NETWORK=devnet`, `DATA_DIR=/app/data`,
`SERVICE_LOCATION` (the Railway region, which labels the latency figure). Do not set
`ROLLUP_DIRECT_RPC_URL`: it is the rollup's own port on a local network and does not exist
on a hosted one.

## Check it

```bash
curl -s https://<domain>/v1/health    # 200 {"ok":true,"connected":true,"pricesFresh":true,"botsFunded":true,...}
curl -s https://<domain>/v1/markets   # every market with a markPrice
curl -s https://<domain>/v1/stats     # latency.measuredFrom names the Railway region
npx tsx scripts/smoke.ts --url https://<domain>   # also opens and funds one fresh key
```

`/v1/health` answers 503 with the three flags until all are true. Railway waits up to
five minutes for the first 200: signing ten bots in, opening and funding them takes most
of the first start, and walking a price that has moved far since set-up takes one second
per 2.5%.

## Before the first deploy

- **Deposits through the hosted endpoint are unproven.** On the local network the query
  filter refuses every deposit transaction, signed in or not, and the service sends
  deposits to the rollup's own port instead (`ROLLUP_DIRECT_RPC_URL`). A hosted rollup
  has no such port. If devnet's endpoint refuses deposits as well, the bots cannot be
  funded and `/v1/health` will stay at `botsFunded: false`. Try one deposit there first.
- The local rollup is version 0.14.10 and devnet's is newer. Nothing here was measured
  there.

## Do not change

Keep it at one replica. The fund limits are counted in one process's memory, two oracles
would refuse each other's prices, and the fund routes are only safe while one process
holds the gate key (see `docs/DESIGN.md`, "Funding a user").
