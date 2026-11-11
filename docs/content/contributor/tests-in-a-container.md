---
title: "Run long test jobs in a container"
description: "Run the full e2e suite and other long jobs in a container, not on your machine."
weight: 2020
extra:
  reader: contributor
  type: how-to
---

# Run long test jobs in a container

The full end-to-end suite takes minutes and wants every core; WebKit needs
Debian or Ubuntu libraries. Run such jobs in a container, never by installing
their dependencies on your own machine.

## A container for the e2e suite

Any Debian or Ubuntu container with Node and the repository in it will do. With
Podman:

```sh
podman run -it --name inkhold-ci -v "$PWD:/work" -w /work/webapp \
  docker.io/library/node:24-bookworm bash
```

Inside it, once:

```sh
npm ci
npx playwright install --with-deps chromium webkit
```

The suite needs the WebAssembly decoders built from the Zig sources. Build them
on your machine first (`npm run build:wasm` in `webapp/`, which writes them
into `webapp/public/`), or install Zig 0.17.1 in the container too.

## Run it

```sh
npx playwright test --workers=4                      # Chromium, everything
E2E_BROWSER=webkit npx playwright test --workers=4    # Safari's engine
npx playwright test -c playwright.pwa.config.ts        # the installed app, on a production build
```

Four workers is a good number: more makes timing-sensitive tests fail for the
wrong reason on a busy machine.

## Read the result

`--reporter=line` keeps the log short; the failures are listed at the end with
their file and line. A test that fails only under load is still a bug worth
reading, not a flake to retry: the ones found so far were real.
