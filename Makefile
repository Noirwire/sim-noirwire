# Everything this repository does goes through here.
#
#   make install        install dependencies
#   make dev            run the service locally, with live reload
#   make build          compile TypeScript to dist/
#   make start          run the compiled service from dist/
#   make test           run the vitest suite (no network needed)
#   make test-rollup    start the local network from the order book repository, set it up,
#                       run the service on it with VENUE=rollup and assert the whole path
#   make check          lint, type check and formatting check, as CI runs them
#   make format         fix formatting
#   make loadtest       drive the venue with concurrent traders and write a report
#                       (VENUE=memory by default; VENUE=rollup needs a running service)
#   make sdk-update     copy a fresh order book client release into vendor/
#   make docker-up      local network on this machine, the service in a container on it
#   make docker-down    stop both
#   make docker-logs    follow the service's container log
#   make docker-test    docker-up, wait for health, smoke check, docker-down
#   make docker-up-all  the local network in a container too (emulated x64 on an arm64
#                       machine), set up by a one-shot container, then the service
#   make docker-down-all  stop and remove all of it
#   make docker-test-all  docker-up-all, wait for health, smoke check, docker-down-all
#   make devnet-start   run the built service against Solana devnet in the background, from
#                       .env.devnet.local (docs/deploy.md); log and pid under data/devnet/
#   make devnet-stop    stop it
#   make clean          remove build and local-data leftovers
#
# ORDERBOOK_REPO is the order book repository beside this one. Its Makefile
# starts the local network (ports 8899, 7799, 6699) and sets it up.
#
# The -all targets touch nothing on those ports: the containerised network is
# published on 18899/18900, 17799/17800 and 16699/16700 (NETWORK_PORT_PREFIX,
# 1 by default, goes before each port) and the service on ALL_SIM_HOST_PORT
# (14100 by default). TERMINAL=1 adds the trading terminal to docker-up-all.

SHELL := /bin/bash
.SHELLFLAGS := -euo pipefail -c
.DEFAULT_GOAL := help

ORDERBOOK_REPO ?= ../orderbook-noirwire
SDK_VERSION ?= 0.4.0
SDK_FILE := noirwire-orderbook-$(SDK_VERSION).tgz

VENUE ?= memory
LOADTEST_TRADERS ?= 20
LOADTEST_SECONDS ?= 10
LOADTEST_ARGS ?=

SIM_HOST_PORT ?= 4100
COMPOSE := ORDERBOOK_REPO=$(abspath $(ORDERBOOK_REPO)) SIM_HOST_PORT=$(SIM_HOST_PORT) docker compose
ALL_SIM_HOST_PORT ?= 14100
NETWORK_PORT_PREFIX ?= 1
TERMINAL ?=
COMPOSE_ALL := ORDERBOOK_REPO=$(abspath $(ORDERBOOK_REPO)) SIM_HOST_PORT=$(ALL_SIM_HOST_PORT) \
	NETWORK_HOST=network NETWORK_PORT_PREFIX=$(NETWORK_PORT_PREFIX) \
	DEPLOYMENT_SOURCE=noirwire-sim-deployment docker compose --profile network
ORDERBOOK_OUTPUTS := target/deploy/noirwire_orderbook.so sdk/dist/index.js ops/network.ts
# lsof exits non-zero when any one of the ports is free, so its output is what counts.
NETWORK_PORTS := lsof -nP -iTCP:8899 -iTCP:7799 -iTCP:6699 -sTCP:LISTEN 2>/dev/null || true

.PHONY: help install dev build start test test-rollup check format loadtest sdk-update \
	network-up network-down docker-up docker-down docker-logs docker-test \
	orderbook-outputs docker-up-all docker-down-all docker-test-all devnet-start devnet-stop clean

help:
	@grep -E '^#( |$$)' Makefile | sed -E 's/^# ?//' | sed '/^ORDERBOOK_REPO is/,$$d'

install:
	npm ci

dev:
	npm run dev

build:
	npm run build

start:
	npm run start

test:
	npm test

check:
	npm run lint
	npm run typecheck
	npm run format:check

format:
	npm run format

loadtest:
	npx tsx scripts/loadtest.ts --venue $(VENUE) --traders $(LOADTEST_TRADERS) --seconds $(LOADTEST_SECONDS) $(LOADTEST_ARGS)

# The client is consumed as a release file. Until releases are published at a
# URL, the file is copied from the order book repository (`make sdk` there).
sdk-update:
	@[ -f $(ORDERBOOK_REPO)/sdk/$(SDK_FILE) ] || { \
		echo "$(ORDERBOOK_REPO)/sdk/$(SDK_FILE) is missing: run 'make sdk' in $(ORDERBOOK_REPO)." >&2; exit 1; }
	mkdir -p vendor
	rm -f vendor/noirwire-orderbook-*.tgz
	cp $(ORDERBOOK_REPO)/sdk/$(SDK_FILE) vendor/$(SDK_FILE)
	npm install --no-audit --no-fund @noirwire/orderbook@file:vendor/$(SDK_FILE)

# A network somebody else started is never touched: these refuse instead.
network-up:
	@[ -f $(ORDERBOOK_REPO)/Makefile ] || { echo "No order book repository at $(ORDERBOOK_REPO). Set ORDERBOOK_REPO." >&2; exit 1; }
	@[ -z "$$($(NETWORK_PORTS))" ] || { echo "A local network is already running on 8899, 7799 or 6699. Stop it first." >&2; exit 1; }
	$(MAKE) -C $(ORDERBOOK_REPO) up
	$(MAKE) -C $(ORDERBOOK_REPO) local-setup > /dev/null
	@echo "Network is set up: $(ORDERBOOK_REPO)/.localnet/deployment.json"

network-down:
	$(MAKE) -C $(ORDERBOOK_REPO) down

test-rollup: network-up
	trap '$(MAKE) network-down' EXIT; \
	ORDERBOOK_LOCALNET=$(abspath $(ORDERBOOK_REPO))/.localnet npx vitest run --config vitest.rollup.config.ts

# The local network cannot run in a Linux container on an arm64 machine (see
# docs/DESIGN.md), so it runs here and the containers reach it through
# host.docker.internal.
docker-up: network-up
	$(COMPOSE) up --build --detach --wait

docker-down:
	$(COMPOSE) --profile terminal down --volumes
	$(MAKE) network-down

docker-logs:
	$(COMPOSE) logs --follow sim

docker-test: network-up
	trap '$(COMPOSE) --profile terminal down --volumes; $(MAKE) network-down' EXIT; \
	{ $(COMPOSE) up --build --detach --wait || { $(COMPOSE) logs --tail 40 sim; exit 1; }; } && \
	npx tsx scripts/smoke.ts --url http://127.0.0.1:$(SIM_HOST_PORT)

# The network image copies the program binary, the set-up script and the
# built client out of the order book repository.
orderbook-outputs:
	@for file in $(ORDERBOOK_OUTPUTS); do \
		[ -f $(ORDERBOOK_REPO)/$$file ] || { \
			echo "$(ORDERBOOK_REPO)/$$file is missing: run 'make build' and 'make sdk-build' in $(ORDERBOOK_REPO), or set ORDERBOOK_REPO." >&2; exit 1; }; \
	done

docker-up-all: orderbook-outputs
	$(COMPOSE_ALL) $(if $(TERMINAL),--profile terminal) up --build --detach --wait

docker-down-all:
	$(COMPOSE_ALL) --profile terminal down --volumes

docker-test-all: orderbook-outputs
	trap '$(COMPOSE_ALL) --profile terminal down --volumes' EXIT; \
	{ $(COMPOSE_ALL) up --build --detach --wait || { $(COMPOSE_ALL) logs --tail 40; exit 1; }; } && \
	npx tsx scripts/smoke.ts --url http://127.0.0.1:$(ALL_SIM_HOST_PORT)

# Its data folder holds the bots' order key checkpoints and the fund grants:
# `make clean` would remove it, and the bots would then replace their keys.
DEVNET_DIR := data/devnet
DEVNET_PID := $(DEVNET_DIR)/sim.pid

devnet-start: build
	@[ -f .env.devnet.local ] || { echo ".env.devnet.local is missing: see docs/deploy.md, 'Run against devnet from this machine'." >&2; exit 1; }
	@mkdir -p $(DEVNET_DIR)
	@! { [ -f $(DEVNET_PID) ] && kill -0 $$(cat $(DEVNET_PID)) 2>/dev/null; } || { echo "Already running, pid $$(cat $(DEVNET_PID))." >&2; exit 1; }
	nohup node --env-file .env.devnet.local dist/main.js >> $(DEVNET_DIR)/sim.log 2>&1 & echo $$! > $(DEVNET_PID)
	@echo "Started, pid $$(cat $(DEVNET_PID)). Log: $(DEVNET_DIR)/sim.log"

devnet-stop:
	@[ -f $(DEVNET_PID) ] && kill $$(cat $(DEVNET_PID)) 2>/dev/null && echo "Stopped." || echo "Not running."
	@rm -f $(DEVNET_PID)

clean:
	rm -rf dist coverage data loadtest-reports
