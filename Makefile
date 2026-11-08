# Inkhold — dev & run helpers.
# Run `make help` for the list.

BIN  := zig-out/bin/inkhold
PORT ?= 8089

WEB  := webapp

# ONE PORT, and `PORT=` overrides it. `serve` used to default to 8090 while
# `PORT` said 8089 and the data directory was named `server/8089`, so the help
# text, the variable and the path disagreed three ways — a beta report started
# by trying to reconcile them.
SERVE_PORT := $(PORT)

TARGET ?= native-linux-musl

.PHONY: help build release-artifact web-dist print-zig-cpu print-docker-arches docker-context docker-image docker-image-host run serve test parser-test test-all web-test web-test-unit web-lint web-test-e2e web-test-setup fmt fmt-fix commit-check commit-hook lan-ip clean docs docs-build

help:
	@echo "Inkhold"
	@echo "  make build          build the server (Debug)"
	@echo "  make release-artifact build statically against musl, build frontend, and package into a tarball. Accepts TARGET (e.g. TARGET=aarch64-linux-musl)"
	@echo "  make run            build + run (uses config.zon if present, else defaults; --config=PATH to override)"
	@echo "  make serve          build wasm+SPA+server, then serve device sync AND the browser UI on ONE port ($(PORT); PORT= to override)"
	@echo "  make test           run the root Zig suite (backend + note unit tests)"
	@echo "  make footprint      build ReleaseSafe and check the server's memory ceilings"
	@echo "  make parser-test    run the standalone parser suites (note + spd, incl. property/golden)"
	@echo "  make test-all       run the root Zig suite, the parser suites, AND the web suite"
	@echo "  make web-test       run the web suite (unit + e2e)"
	@echo "  make web-test-unit  run the web unit tests (Vitest; needs Node only)"
	@echo "  make web-test-e2e   run the web e2e tests (Playwright; needs Chromium)"
	@echo "  make web-test-setup one-time web deps (npm install + Playwright Chromium)"
	@echo "  make docs           preview the website and manuals at http://127.0.0.1:1111"
	@echo "  make docs-build     build the website into docs/public"
	@echo "  make fmt            check formatting        make fmt-fix   reformat in place"
	@echo "  make commit-check   check commit titles (RANGE=, default origin/main..HEAD)"
	@echo "  make commit-hook    check each title as you commit (installs a git hook)"
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

# THE FRESH-CLONE GUARD. `npm run build` needs `tsc`, which lives in
# `webapp/node_modules` — absent in a clone that has only ever been built, so
# the first `make serve` died on `tsc: command not found` with nothing to
# suggest `npm ci`. Order-only would be wrong (a directory's timestamp moves),
# so this is a plain existence check that installs once and is a no-op after.
#
# KEYED ON `.package-lock.json`, NOT ON THE DIRECTORY. `npm ci` DELETES
# `node_modules` before it repopulates it, so an install that is interrupted —
# a timeout, a Ctrl-C, a dropped connection — leaves the directory behind and
# EMPTY. A guard watching the directory then reports satisfied for ever and the
# build fails on `tsc: command not found` anyway, which is the exact failure it
# was written to remove. npm writes this file only on success.
# THE OTHER FRESH-CLONE GUARD. `server/` is gitignored — it holds a live database
# — so a clone has no `serve.zon` for the recipe below to read, and `make serve`
# died in `sed` with "No such file or directory" and nothing pointing at a fix.
# A beta report started exactly there.
#
# Written once and never overwritten: it is a real config for a real install, and
# regenerating it would silently move somebody's database. Paths are relative to
# THIS FILE (see config.zig's rebase), which is why they are bare names and the
# web root climbs out with `../..`.
#
# `.host` is 0.0.0.0, not the config default of 127.0.0.1: this target exists to
# serve a tablet on the LAN, and a loopback bind is unreachable from one — the
# failure looks exactly like a firewall problem, which is where the same beta
# report went looking first.
server/8089/serve.zon:
	@mkdir -p $(@D)
	@printf '%s\n' \
	  '// Written by `make serve` on first run. Yours to edit — it is never' \
	  '// regenerated, because it names a live database.' \
	  '//' \
	  '// Paths are relative to THIS file. `.host` must be reachable from the' \
	  '// tablet: 0.0.0.0 binds every interface, 127.0.0.1 would be loopback-only.' \
	  '.{' \
	  '    .host = "0.0.0.0",' \
	  '    .port = $(PORT),' \
	  '    .db_path = "minicloud.db",' \
	  '    .cred_key_path = "cred.key",' \
	  '    .data_dir = "data",' \
	  '    .web_dir = "../../webapp/dist",' \
	  '' \
	  '    // Login of the administrator created on the FIRST run only, with a' \
	  '    // temporary password printed to this terminal. Must be an email:' \
	  '    // the sign-in form will not submit anything else. Changing it after' \
	  '    // that first run renames nothing — the account already exists.' \
	  '    .admin_email = "admin@home.lan",' \
	  '}' > $@
	@echo ">>> Created $@ (host 0.0.0.0, port $(PORT)). Edit it to taste."

$(WEB)/node_modules/.package-lock.json:
	npm --prefix $(WEB) ci

build:
	zig build -Doptimize=$(OPTIMIZE)

# ---- Container images -------------------------------------------------------
#
# One `platform=zig-target` pair per architecture, kept in step with the release
# matrix in `.github/workflows/ci.yaml`: these are the same four binaries the
# tarballs ship — literally the same, since CI now builds each once and hands it
# to both. Adding an architecture is one line here and one entry there.
#
# 32-bit ARM is `v6`, NOT `v7`, and that follows from the reuse: the shared
# binary carries the ARMv6 baseline the tarball needs for a Pi 1, so `v7` would
# be a label the bytes do not support. It costs nothing — Docker serves a v6
# image to a v7 host, so this covers strictly more machines than v7 did.
DOCKER_ARCHES = \
	linux/amd64=x86_64-linux-musl \
	linux/386=x86-linux-musl \
	linux/arm64=aarch64-linux-musl \
	linux/arm/v6=arm-linux-musleabihf

COMMA := ,
EMPTY :=
SPACE := $(EMPTY) $(EMPTY)

# The `--platform` argument buildx wants: the left-hand sides, comma-joined.
DOCKER_PLATFORMS = $(subst $(SPACE),$(COMMA),$(foreach a,$(DOCKER_ARCHES),$(firstword $(subst =, ,$(a)))))

IMAGE ?= inkhold
TAG   ?= dev

# Lay out what the Dockerfile copies: one binary per platform, under the exact
# `TARGETPLATFORM` path buildx asks for, plus the SPA once (it is
# architecture-independent, so it is built and copied a single time).
#
# STRIPPED, unlike the tarballs. An image is pulled repeatedly over a home
# connection and debug info is 48 MB of the 58 MB it would otherwise cost; a
# tarball is fetched once by someone who may have to file a bug report from it,
# so that one keeps its symbols.
docker-context: $(if $(SKIP_WEB),,web-dist)
	rm -rf docker/context
	mkdir -p docker/context/webapp
	cp -r $(WEB)/dist docker/context/webapp/
	@set -e; for a in $(DOCKER_ARCHES); do \
		p=$${a%%=*}; t=$${a##*=}; \
		echo ">>> $$p  ($$t)"; \
		zig build -Doptimize=ReleaseSafe -Dstrip=true -Dtarget=$$t --prefix docker/build-$$t; \
		mkdir -p "docker/context/$$p"; \
		cp "docker/build-$$t/bin/inkhold" "docker/context/$$p/inkhold"; \
		rm -rf "docker/build-$$t"; \
	done
	@echo ">>> docker/context ready"

# A local multi-arch build. `--load` cannot take a manifest LIST, so this builds
# and caches without loading; use `docker-image-host` for something runnable here.
docker-image: docker-context
	docker buildx build --file docker/Dockerfile \
		--platform "$(DOCKER_PLATFORMS)" \
		--build-arg VERSION=$(TAG) --tag $(IMAGE):$(TAG) docker

# The one for THIS machine, loaded into the local daemon so `docker run` works.
docker-image-host: docker-context
	docker buildx build --file docker/Dockerfile --load \
		--build-arg VERSION=$(TAG) --tag $(IMAGE):$(TAG) docker

# THE CPU BASELINE, where the target alone is not specific enough.
#
# `arm-linux-musleabihf` defaults to ARMv7 with VFPv3, and the oldest machine
# this project advertises -- the Pi 1 B+ and the original Zero, which every ARM
# measurement in this repo was taken on -- is an ARM1176: ARMv6, VFPv2. The
# default artifact therefore died on the hardware it was built for with
# `Illegal instruction`, VERIFIED on the real board before and after this line
# existed. Nothing warns you: the ELF loads, the first NEON-era instruction
# faults, and the exit code is 132.
#
# The cost is real and is accepted deliberately: an ARMv6 binary gives up
# ARMv7's instructions on a Pi 2 or a 32-bit Pi 3/4. Those machines have a
# 64-bit artifact (`aarch64-linux-musl`) and, on a 32-bit OS, still run this
# one -- ARMv6 code runs on every later ARM. An ARMv7 build runs on NONE of the
# older ones, so this is the direction that loses nobody.
#
# Empty for every other target: `x86_64-linux-musl` and friends have a baseline
# that already matches what they claim.
CPU_arm-linux-musleabihf = arm1176jzf_s
ZIG_CPU = $(if $(CPU_$(TARGET)),-Dcpu=$(CPU_$(TARGET)))

# THE SPA IS ARCHITECTURE-INDEPENDENT, so it is built once and reused. Set
# `SKIP_WEB=1` when `webapp/dist` is already in place — CI builds it in a job of
# its own and hands the same bytes to every architecture and to the image, which
# is how one `npm run build` replaced eight.
SKIP_WEB ?=

# Two accessors so CI does not have to restate what this file already knows:
# the CPU baseline for a target, and the platform=target mapping. A second copy
# of either in the workflow is a second place for them to drift.
print-zig-cpu:
	@echo '$(ZIG_CPU)'

print-docker-arches:
	@echo '$(DOCKER_ARCHES)'

web-dist: $(WEB)/node_modules/.package-lock.json
	npm --prefix $(WEB) run build

release-artifact: $(if $(SKIP_WEB),,web-dist)
	zig build -Doptimize=ReleaseSafe -Dtarget=$(TARGET) $(ZIG_CPU)
	mkdir -p release-tmp/webapp
	cp zig-out/bin/inkhold release-tmp/
	cp -r webapp/dist release-tmp/webapp/
	cp config.example.zon README.md LICENSE release-tmp/
	tar -czf inkhold-$(TARGET).tar.gz -C release-tmp .
	rm -rf release-tmp
	@echo ">>> Created inkhold-$(TARGET).tar.gz"

# No `--config=` needed: the binary already defaults to `config.zon`, and
# `serve` tolerates it being absent (first run is a real case). This used to
# pass `$(wildcard config.zon)` positionally, which stopped parsing when the
# config became an option.
run: build
	$(BIN)

# Single-port serve: builds the single-page decoder wasm, the web SPA (Vite
# `dist/`, which bundles that wasm from public/), and the server; then runs ONE
# process that serves BOTH the device sync protocol (Face 1) AND the browser UI
# (control-plane Face 2) + the SPA itself, all on one plaintext port.
#
# Point the Nomad's Private Cloud server address AND your browser at the same
# URL: http://<this machine's LAN IP>:$(SERVE_PORT)  (run `make lan-ip` for it).
# A production SPA build defaults to the REAL backend (no ?real needed).
# Port is $(PORT) by default; `make serve PORT=9000` overrides it.
serve: build $(WEB)/node_modules/.package-lock.json server/8089/serve.zon
	npm --prefix $(WEB) run build
	@sed 's/\.port = [0-9][0-9]*,/.port = $(SERVE_PORT),/' server/8089/serve.zon > server/8089/serve-run.zon
	@echo ""
	@echo ">>> SINGLE-PORT SERVE — device sync AND the browser UI + SPA on one port."
	@echo ">>> Point the Nomad's server address AND your browser at  http://<LAN-IP>:$(SERVE_PORT)  (make lan-ip)."
	@echo ">>> Ctrl-C to stop."
	@echo ""
	$(BIN) --config=server/8089/serve-run.zon

test:
	zig build test --summary all

# The server's memory footprint against its ceilings (scripts/footprint.py):
# idle, per parked socket, and that threads do not grow with sockets. Builds
# ReleaseSafe first, since Debug numbers mean nothing.
# BIN= measures a binary already built (CI: the shipped x86_64 musl one).
footprint:
ifeq ($(BIN),)
	zig build -Doptimize=ReleaseSafe
	python3 scripts/footprint.py zig-out/bin/inkhold
else
	python3 scripts/footprint.py $(BIN)
endif

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

web-lint:
	cd $(WEB) && npm run lint:styles

# SHARD=1/4 runs one slice. E2E_PREBUILT=1 uses the wasm already in public/.
web-test-e2e:
	cd $(WEB) && npx playwright test $(if $(SHARD),--shard=$(SHARD))

# One-time: install web dev deps and the Playwright Chromium build (needs
# network). Unit tests need only Node; e2e additionally needs this Chromium.
web-test-setup:
	cd $(WEB) && npm install && npx playwright install chromium

# Commit titles: Conventional Commits, under 120 characters
# (docs/content/contributor/commit-messages.md). CI checks what a push adds.
RANGE ?= origin/main..HEAD
commit-check:
	@scripts/commit-titles.sh $(RANGE)

# The same check on every `git commit`, before the commit is made.
commit-hook:
	ln -sf ../../scripts/commit-titles.sh .git/hooks/commit-msg

fmt:
	zig fmt --check backend webapp/wasm parsers build.zig

fmt-fix:
	zig fmt backend webapp/wasm parsers build.zig

lan-ip:
	@echo "This machine's LAN IP(s): $$(hostname -I 2>/dev/null || ip -4 addr show scope global | awk '/inet /{print $$2}' | cut -d/ -f1 | tr '\n' ' ')"

clean:
	rm -rf zig-out .zig-cache

# ---- Documentation site ----------------------------------------------------
# The website and both manuals: a Zola site in docs/ (docs/Makefile has the rest).
docs:
	$(MAKE) -C docs serve

docs-build:
	$(MAKE) -C docs build
