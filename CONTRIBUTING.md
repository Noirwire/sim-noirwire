# Contributing

## Before you commit

Run all of these. CI runs the same checks and a pull request does not merge until they pass.

```sh
make check
make test
make build
```

`make check` runs lint, the type check and the formatting check. `make format` fixes formatting.

## Commits

- Keep the subject under 50 characters.
- Start it with a conventional prefix: `feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`, `ci:` or `build:`.
- Write it in the imperative: `fix: release spot locks on cancel`, not `fixed` or `fixes`.
- One change per commit. Explain why in the body when the reason is not obvious from the change.

## Tests

Every change comes with its tests. A new rule has a test for each branch; a fixed bug has a test that failed before the fix.

- Give each test one failure it uniquely catches; repeat across layers only where the boundary changes (the engine rule, then the HTTP route that exercises it).
- Assert money, a position, a lock, a rejection reason or another observable decision; never exact prose or an input echoed back.
- Keep one real network call per boundary (the Jupiter poll, proven against the live API); seed fixtures elsewhere and use controlled clocks, not sleeps.

## The structure rule

`src/engine`, `src/prices`, `src/bots`, `src/data` and `src/config` are plain TypeScript: no Fastify import, nothing that needs a running server. `src/http` is the thin layer around them. `npm run lint` enforces this, so the engine's tests never need a server.

## Code

- Small modules with one job each, named in the product's words: venue, market, trader, fill.
- No dead code and no commented-out code. A well named function replaces a comment that restates what the code does.
- Build what the change needs and nothing more. A new dependency needs a reason in the pull request.
- Use relative imports with the `.js` extension. The service runs as ES modules.
- Every input at the HTTP boundary is validated with zod.
- Prices, sizes and balances are `bigint` everywhere. A float never crosses the venue boundary.

## Text people read

- No em dashes. Use a hyphen.
- Say plainly what happened and what to do next.
- Never present bot activity as user activity. Label it.

## Security issues

Do not open an issue or a pull request for a vulnerability. See [SECURITY.md](SECURITY.md).
