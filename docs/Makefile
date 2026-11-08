# The documentation site (Zola). Run from the repository root with `make -C docs <target>`.
#
#   serve   preview at http://127.0.0.1:1111, reloading as you write
#   build   the static site, in docs/public/
#   check   links and anchors, offline
#   test    the built site against the quality bar: every page, four widths,
#           light and dark (tools/check-site.mjs; the docs CI runs check and test)
#   clean   drop everything generated
#
# Zola is downloaded once, pinned and checksummed, into .tools/: the same
# version on every machine and in CI, no system install.

ZOLA_VERSION := 0.23.6

OS   := $(shell uname -s)
ARCH := $(shell uname -m)
ifeq ($(OS)-$(ARCH),Linux-x86_64)
  ZOLA_TARGET := x86_64-unknown-linux-gnu
  ZOLA_SHA256 := 8f5132b3522412d04e395e0b25f6d68613ad272a873e54a2b3ebf664873024a4
else ifeq ($(OS)-$(ARCH),Linux-aarch64)
  ZOLA_TARGET := aarch64-unknown-linux-gnu
  ZOLA_SHA256 := 266448fffbf7c7004ca399d0e76dd699541771096d8a42aede98cebe2a029d02
else ifeq ($(OS)-$(ARCH),Darwin-x86_64)
  ZOLA_TARGET := x86_64-apple-darwin
  ZOLA_SHA256 := 79a4d0ab51a4d863c068e6e594c6fce36f0aa17429a414ea63066f5910d14460
else ifeq ($(OS)-$(ARCH),Darwin-arm64)
  ZOLA_TARGET := aarch64-apple-darwin
  ZOLA_SHA256 := cbffbd29b3f59c3f52633507c8cb945a7a02d8b1399b43b235f5932912297aa3
else
  $(error no pinned Zola for $(OS)-$(ARCH); add its archive and sha256 here)
endif

ZOLA_DIR := .tools/zola-$(ZOLA_VERSION)
ZOLA     := $(ZOLA_DIR)/zola
ZOLA_URL := https://github.com/getzola/zola/releases/download/v$(ZOLA_VERSION)/zola-v$(ZOLA_VERSION)-$(ZOLA_TARGET).tar.gz

# The app's design tokens and fonts, copied in, never forked.
APP_TOKENS := ../webapp/src/styles/00-tokens.css
APP_FONTS  := $(wildcard ../webapp/public/fonts/*.woff2)

TEST_PORT := 1112

.PHONY: serve build check test clean assets diagrams

serve: $(ZOLA) assets diagrams
	@trap 'kill 0' INT TERM EXIT; \
	node tools/diagrams.mjs watch content static/diagrams & \
	$(ZOLA) serve --interface 127.0.0.1 --port 1111

build: $(ZOLA) assets diagrams
	$(ZOLA) build
	node tools/diagrams.mjs inline public static/diagrams

check: $(ZOLA) assets diagrams
	$(ZOLA) check --skip-external-links

test: $(ZOLA) assets diagrams
	$(ZOLA) build --base-url http://127.0.0.1:$(TEST_PORT) --output-dir .test-site --force
	node tools/diagrams.mjs inline .test-site static/diagrams
	node tools/check-site.mjs .test-site $(TEST_PORT)

clean:
	rm -rf public .test-site static/diagrams static/fonts static/tokens.css

assets: static/tokens.css $(patsubst ../webapp/public/fonts/%,static/fonts/%,$(APP_FONTS))

static/tokens.css: $(APP_TOKENS)
	cp $< $@

static/fonts/%.woff2: ../webapp/public/fonts/%.woff2
	@mkdir -p $(@D)
	cp $< $@

diagrams: node_modules/.package-lock.json
	node tools/diagrams.mjs render content static/diagrams

node_modules/.package-lock.json: package.json package-lock.json
	npm ci --no-audit --no-fund
	@touch $@

$(ZOLA):
	@mkdir -p $(ZOLA_DIR)
	curl -sSfL -o $(ZOLA_DIR)/zola.tar.gz $(ZOLA_URL)
	echo "$(ZOLA_SHA256)  $(ZOLA_DIR)/zola.tar.gz" | sha256sum -c --quiet - 2>/dev/null \
	  || echo "$(ZOLA_SHA256)  $(ZOLA_DIR)/zola.tar.gz" | shasum -a 256 -c --quiet -
	tar -xzf $(ZOLA_DIR)/zola.tar.gz -C $(ZOLA_DIR) zola
	rm $(ZOLA_DIR)/zola.tar.gz
