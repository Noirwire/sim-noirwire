# The local network and its one-shot set-up, for `make docker-up-all`.
#
# compose.yaml builds and runs it as linux/amd64 on every machine: the Solana
# test validator has no Linux arm64 release, so on an arm64 machine this
# image runs under Docker's x86_64 emulation (docs/DESIGN.md, "Local run in
# Docker").
#
# The order book repository is the additional build context `orderbook`. Its
# build outputs (the program binary and the built client) must exist already.
#
# MagicBlock's Linux binaries need glibc 2.39 or newer, which Debian 12 does
# not have.
FROM node:24-trixie-slim

ARG SOLANA_VERSION=2.3.11

RUN apt-get update \
    && apt-get install -y --no-install-recommends bzip2 ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL "https://github.com/anza-xyz/agave/releases/download/v${SOLANA_VERSION}/solana-release-x86_64-unknown-linux-gnu.tar.bz2" \
        | tar -xj -C /usr/local/bin --strip-components=2 \
            solana-release/bin/solana-test-validator solana-release/bin/solana-keygen

WORKDIR /orderbook
COPY --from=orderbook package.json package-lock.json tsconfig.json Anchor.toml ./
COPY --from=orderbook sdk/package.json sdk/
RUN npm ci --no-audit --no-fund

COPY --from=orderbook sdk/dist sdk/dist
COPY --from=orderbook ops ops
COPY --from=orderbook tests/fixtures/local-validator-identity.json tests/fixtures/
COPY --from=orderbook target/deploy/noirwire_orderbook.so target/deploy/

COPY docker/network-entry.mjs /local/network-entry.mjs

# The keys the set-up writes are readable by their owner only, and the service
# container reads them as the same `node` user.
RUN mkdir -p /deployment /network && chown node:node /deployment /network
USER node

CMD ["node", "/local/network-entry.mjs"]
