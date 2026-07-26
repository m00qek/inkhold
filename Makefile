# Inkhold — dev & run helpers.
# Run `make help` for the list.

BIN  := zig-out/bin/inkhold
PORT ?= 8089

WEB  := webapp

# `make serve` defaults to port 8090 (as in serve.zon); `make serve PORT=9000`
# overrides it for the run.
ifeq ($(origin PORT),command line)
SERVE_PORT := $(PORT)
else
SERVE_PORT := 8090
endif

TARGET ?= native-linux-musl

.PHONY: help build release-artifact run serve test parser-test test-all web-test web-test-unit web-test-e2e web-test-setup fmt fmt-fix lan-ip clean docs docs-build docs-deps

help:
	@echo "Inkhold"
	@echo "  make build          build the server (Debug)"
	@echo "  make release-artifact build statically against musl, build frontend, and package into a tarball. Accepts TARGET (e.g. TARGET=aarch64-linux-musl)"
	@echo "  make run            build + run (uses config.zon if present, else defaults)"
	@echo "  make serve          build wasm+SPA+server, then serve device sync AND the browser UI on ONE port (8090; PORT= to override)"
	@echo "  make test           run the root Zig suite (backend + note unit tests)"
	@echo "  make parser-test    run the standalone parser suites (note + spd, incl. property/golden)"
	@echo "  make test-all       run the root Zig suite, the parser suites, AND the web suite"
	@echo "  make web-test       run the web suite (unit + e2e)"
	@echo "  make web-test-unit  run the web unit tests (Vitest; needs Node only)"
	@echo "  make web-test-e2e   run the web e2e tests (Playwright; needs Chromium)"
	@echo "  make web-test-setup one-time web deps (npm install + Playwright Chromium)"
	@echo "  make docs           serve the docs site locally (live-reload; MkDocs Material)"
	@echo "  make docs-build     build the static docs site into release/docs (strict)"
	@echo "  make fmt            check formatting        make fmt-fix   reformat in place"
	@echo "  make lan-ip         print this machine's LAN IP (to enter on the Nomad)"
	@echo "  make clean          remove build artifacts"

# OPTIMIZE defaults to ReleaseSafe, NOT Debug.
#
# `zig build` with no flag takes `standardOptimizeOption`'s default, which is
# Debug — and a Debug server is 6-10x slower under the coarse `db_lock`: measured
# 82 lock windows/s against ReleaseSafe's 810, with `list_folder` and the bin
# listing already past the saturation line unaided. That is not a development
# nicety when `make serve` IS the deployment; it is the household's server
# running an order of magnitude slow for no reason.
#
# ReleaseSafe rather than ReleaseFast on purpose: this project keeps its bounds
# and overflow checks, which is the same posture as the wasm overflow guard and
# the md5 length guard. Override with `make serve OPTIMIZE=Debug` when a debug
# build is genuinely what you want.
OPTIMIZE ?= ReleaseSafe

build:
	zig build -Doptimize=$(OPTIMIZE)

release-artifact:
	zig build -Doptimize=ReleaseSafe -Dtarget=$(TARGET)
	npm --prefix $(WEB) run build
	mkdir -p release-tmp/webapp
	cp zig-out/bin/inkhold release-tmp/
	cp -r webapp/dist release-tmp/webapp/
	cp config.example.zon README.md LICENSE release-tmp/
	tar -czf inkhold-$(TARGET).tar.gz -C release-tmp .
	rm -rf release-tmp
	@echo ">>> Created inkhold-$(TARGET).tar.gz"

run: build
	$(BIN) $(wildcard config.zon)

# Single-port serve: builds the single-page decoder wasm, the web SPA (Vite
# `dist/`, which bundles that wasm from public/), and the server; then runs ONE
# process that serves BOTH the device sync protocol (Face 1) AND the browser UI
# (control-plane Face 2) + the SPA itself, all on one plaintext port.
#
# Point the Nomad's Private Cloud server address AND your browser at the same
# URL: http://<this machine's LAN IP>:$(SERVE_PORT)  (run `make lan-ip` for it).
# A production SPA build defaults to the REAL backend (no ?real needed).
# Port is 8090 by default (serve.zon); `make serve PORT=9000` overrides it.
serve: build
	npm --prefix $(WEB) run build
	@mkdir -p server/8089
	@sed 's/\.port = [0-9][0-9]*,/.port = $(SERVE_PORT),/' server/8089/serve.zon > server/8089/serve-run.zon
	@echo ""
	@echo ">>> SINGLE-PORT SERVE — device sync AND the browser UI + SPA on one port."
	@echo ">>> Point the Nomad's server address AND your browser at  http://<LAN-IP>:$(SERVE_PORT)  (make lan-ip)."
	@echo ">>> Ctrl-C to stop."
	@echo ""
	$(BIN) server/8089/serve-run.zon

test:
	zig build test --summary all

# The standalone parser suites. The root `test` above builds the note/spd
# parsers as MODULES and runs their colocated unit tests, but the SPD suite and
# the note property/golden integration tests are wired into each parser's OWN
# build.zig and run ONLY from its directory — so they are invisible to the root
# suite unless invoked here.
parser-test:
	cd parsers/note && zig build test --summary all
	cd parsers/spd && zig build test --summary all

# Root Zig suite + parser suites + web suite (unit + e2e). Web e2e needs the
# Chromium binary — run `make web-test-setup` once first (see below).
test-all: test parser-test web-test

web-test:
	cd $(WEB) && npm test

web-test-unit:
	cd $(WEB) && npm run test:unit

web-test-e2e:
	cd $(WEB) && npm run test:e2e

# One-time: install web dev deps and the Playwright Chromium build (needs
# network). Unit tests need only Node; e2e additionally needs this Chromium.
web-test-setup:
	cd $(WEB) && npm install && npx playwright install chromium

fmt:
	zig fmt --check backend webapp/wasm parsers build.zig

fmt-fix:
	zig fmt backend webapp/wasm parsers build.zig

lan-ip:
	@echo "This machine's LAN IP(s): $$(hostname -I 2>/dev/null || ip -4 addr show scope global | awk '/inet /{print $$2}' | cut -d/ -f1 | tr '\n' ' ')"

clean:
	rm -rf zig-out .zig-cache

# ---- Documentation site (MkDocs + Material) --------------------------------
# Self-contained: creates/reuses a local venv (.venv-docs, gitignored) and
# installs docs/requirements.txt into it. No system Python packages touched.
DOCS_VENV := .venv-docs
DOCS_MKDOCS := $(DOCS_VENV)/bin/mkdocs

# Sentinel: (re)build the venv only when requirements change. `python3 -m venv`
# then pip-install the pinned toolchain.
$(DOCS_MKDOCS): docs/requirements.txt
	python3 -m venv $(DOCS_VENV)
	$(DOCS_VENV)/bin/pip install --upgrade pip
	$(DOCS_VENV)/bin/pip install -r docs/requirements.txt
	@touch $(DOCS_MKDOCS)

docs-deps: $(DOCS_MKDOCS)

# Live-reload preview. Prints the local URL; Ctrl-C to stop.
docs: docs-deps
	@echo ""
	@echo ">>> Docs preview (live-reload) at  http://127.0.0.1:8000/"
	@echo ">>> Ctrl-C to stop."
	@echo ""
	$(DOCS_MKDOCS) serve

# Static build into release/docs (strict: fails on broken links / nav warnings).
docs-build: docs-deps
	$(DOCS_MKDOCS) build --strict
	@echo ">>> Static docs site built into release/docs"
