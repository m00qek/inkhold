---
title: "Browser app decisions"
description: "Why the app is wired through four seams with fakes, and why it routes by hash."
weight: 4080
extra:
  reader: contributor
  type: explanation
---

# Browser app decisions

How the browser app is put together: its seams, routing, viewers, caches, export and the WebAssembly rules. The rules themselves: [The browser app](@/contributor/browser-app-rules.md).

## Decisions

### Four seams, each with a fake

**Problem.** The app must be testable without a server, and the server's behaviour must be written down somewhere executable.

**Decision.** `main.ts` wires four seams (the API, the renderer, the render cache, the live channel); each has a real and a fake implementation, and the e2e suite runs on the fakes. The fake API is the reference behaviour.

**Cost.** Every server change is made twice: in the server and in the fake.

**Revisit when** never: the fakes are what make the suite fast and deterministic.

### Hash routing

**Problem.** The server has no SPA fallback, and every place should have a URL.

**Decision.** Hash routes; navigation pushes, adjustments replace, so Back leaves a note in one step.

**Cost.** URLs carry a `#`.

**Revisit when** the server gains a fallback route.

`main.ts` wires four seams; each has a real and a fake implementation (dev and
e2e run on the fakes, `?real`/`?fake` override):

| Seam | Real | What it owns |
|---|---|---|
| `Api` (`api/types.ts`) | `createHttpApi()` | the wire contract; `api/fake.ts` is the reference behaviour |
| `NoteRenderer` (`render/types.ts`) | `createWasmRenderer()` | SNPG → RGBA in `note-decode.wasm` |
| `RenderCache` (`cache/types.ts`) | `renderCache.ts` | rendered pixels ([§11.4](@/contributor/browser-app-rules.md)) |
| `LiveChannel` (`sync/types.ts`) | `live.ts` (SSE) | freshness ([§9.3](@/contributor/serving-rules.md)) |

Golden wire fixtures in `webapp/tests/fixtures/wire/` pin the server's JSON The rules themselves: [The browser app](@/contributor/browser-app-rules.md).
through the client normalisers (`INK_UPDATE_WIRE_FIXTURES=1 zig build test`
regenerates them).
