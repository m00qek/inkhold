---
title: "Run the tests"
description: "Run the backend and web app suites, and the e2e tests in Chromium and WebKit."
weight: 2010
extra:
  reader: contributor
  type: how-to
---

# Run the tests

Run the server's, the parsers' and the browser app's suites. A change is ready
when all of them pass.

## Once

Install the browser app's dependencies and the Chromium the end-to-end tests
drive:

```sh
make web-test-setup
```

## Everything

```sh
make test-all
```

That is `make test`, `make parser-test` and `make web-test` (the browser app's
style lint, unit and end-to-end suites), in that order.

## One suite at a time

| Command | What it runs |
|---|---|
| `make fmt` | Zig formatting, checked first: cheap to find, cheap to fix |
| `make test` | The server's unit and HTTP tests (`zig build test`) |
| `make parser-test` | The `.note` and `.spd` parsers' own suites, which the root suite cannot see |
| `make web-test-unit` | The browser app's unit tests (Vitest) |
| `make web-lint` | Every size in the stylesheets is a design token |
| `make web-test-e2e` | The browser app end to end, in Chromium, against a fake server; `SHARD=1/4` runs one slice |
| `make smoke` | The built server serving the built browser app, nothing faked: first sign-in, an upload, a page painted. `SERVER=` and `DIST=` pick builds already made |

In `webapp/`, `npm run typecheck` checks the types.

## The gate

The gate is `make fmt`, `make test` and `make parser-test`, and a commit lands
only when `make test`'s summary line reads `N/N tests passed`. The sample
notebooks the tests embed (`sample.note`, `sample-2.note`, `layers_edited.note`)
are named modules supplied by `build.zig` from `parsers/note/tests/fixtures/`,
so `@embedFile("sample.note")` is the same spelling from any directory.

## Read the result, not the tail

`zig build test` prints its verdict in a **Build Summary**, and its exit code
is the truth. Piping it through `tail` or `grep` hides both: the pipe's exit
code is the last command's, and a failure scrolls by. Run it as it is, or
capture the exit code before you filter.

## In Safari's engine

Every iPhone browser is WebKit, so the phone layouts are also tested in it:

```sh
cd webapp
E2E_BROWSER=webkit npx playwright test
```

WebKit needs Debian or Ubuntu system libraries. On another distribution, run
it inside a Debian or Ubuntu container, never by installing those libraries on
your own machine.

## What CI runs

On every push and pull request: the suites above, side by side, the browser
suite in four slices, and `make smoke`. A test that passed only on its retry is
listed as a warning on the run: it still passes, but it is a flake to fix.

Every Monday, the weekly check runs what a push doesn't: the Zig suites with
nothing cached, the browser suite in WebKit, the docs' links to the web,
`npm audit`, and a cross-build on the newest runner. A failure opens an issue
labelled `weekly`.

## Long runs

The whole end-to-end suite takes minutes. Run it with `--workers=4` on a
machine with the cores for it; a tired laptop makes timing-sensitive tests
look flaky when they aren't.
