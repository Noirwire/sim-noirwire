# Everything this repository does goes through here.
#
#   make install        install dependencies
#   make dev            run the service locally, with live reload
#   make build          compile TypeScript to dist/
#   make start          run the compiled service from dist/
#   make test           run the vitest suite
#   make check          lint, type check and formatting check, as CI runs them
#   make format         fix formatting
#   make loadtest       drive MemoryVenue with concurrent traders and report throughput
#   make clean          remove build and local-data leftovers

SHELL := /bin/bash
.SHELLFLAGS := -euo pipefail -c
.DEFAULT_GOAL := help

LOADTEST_TRADERS ?= 20
LOADTEST_SECONDS ?= 10

.PHONY: help install dev build start test check format loadtest clean

help:
	@grep -E '^#( |$$)' Makefile | sed -E 's/^# ?//'

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
	npx tsx scripts/loadtest.ts --traders $(LOADTEST_TRADERS) --seconds $(LOADTEST_SECONDS)

clean:
	rm -rf dist coverage data loadtest-reports
