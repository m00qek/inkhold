---
title: "The browser app"
description: "Seams, routing, viewers, caches, export and the WebAssembly rules."
weight: 3072
extra:
  reader: contributor
  type: reference
---

# The browser app

Seams, routing, viewers, caches, export and the WebAssembly rules. Why they are this way: [Browser app decisions](@/contributor/browser-app.md).

## Seams

## Routing

Hash routing (the server has no SPA fallback). Every place has a URL;
navigation pushes, adjustments (page turns, find queries) replace, so Back
leaves a note in one step. URL pages are one-based. Trashed files live under
`#/bin/note/:id` because live routes 404 them; past versions are addressed by an
md5 prefix.

## Viewers

Four viewers share one four-method `Viewer` interface (`el`/`open`/`hide`/
`destroy`) and compose shared services (viewer chrome, toolbar, side panel,
page index, layers panel, thumbnails, virtual list) instead of inheriting.
Reach for those before writing a private copy.

A PDF is its own viewer: its pages share resources through the xref, so the
document is opened once in a worker (MuPDF, ~5 MB of wasm, one session for the
viewer's life), streamed by Range requests through a 32 KB block cache. A PDF
has no version history of its own; its `.mark` does.

## Caches

- L0 app shell: fingerprinted, immutable. L1 listing/metadata: the only layer
  that revalidates, stale-while-revalidate gated on the sync version. L2 page
  bytes: immutable under `?v=`, browser HTTP cache. L3 rendered pixels:
  `RenderCache`, keyed by (content hash, size tier, theme), never a source of
  truth.
- **One persistent pixel store**, `sn-thumbs`, shared by the render cache and
  thumbnails under one byte budget. Thumbnails persist as WebP (raw RGBA was
  20–40× larger); reader pages stay in memory.
- **Drawn thumbnails** (a `.txt`'s first lines, a glyph) are painted in the
  colours of the theme they are filed under (`THUMB_PALETTES`, the tokens),
  never the page's: the page can be in the other theme mid-switch. A `.txt`
  card reads only the file's head, 4 KB by `Range` on `/file/:id` (the same
  ranged route a PDF reads), never the whole file.
- Other IndexedDB caches each have their own database, so adding a store never
  needs a version bump another module's open connection would block. All
  degrade to no-ops when storage is unavailable.
- Never paint an off-screen page: every canvas renders lazily through
  `IntersectionObserver`; a theme toggle repaints only what is visible.

## Export

- Client-side, always: native resolution, light theme, bypassing the render
  cache. Download-only — exports never enter the device's `EXPORT/` folder.
- The PDF writer is dependency-free and streaming: it pulls one page at a time
  and returns a Blob of chunks, so a whole notebook peaks at about one page.
- An invisible text layer only at a **verified** mm scale (`pxPerMm`, an
  allowlist of measured hardware; only `N6`, the Nomad, today). A missing text layer is
  obvious; a mis-scaled one is silently wrong.
- Annotated PDFs export as an incremental update over the original bytes
  (keeping forms, bookmarks, annotations); ink is drawn into page content, not
  as an annotation.

## WASM rules

- Any call can grow linear memory and detach `memory.buffer`: create views after
  the producing call, never keep them, copy out before the next call.
- `sqlite-core.wasm` serves both the `.spd` viewer and the search index (SQLite
  is most of its size). It runs on a null VFS, so `SQLITE_TEMP_STORE=3` is
  mandatory and checked at open.
- MuPDF needs the wasm exception-handling proposal: the browser floor is about
  Chrome 95 / Firefox 131 / Safari 18.4. Every export that can suspend on
  `ink.host_read` must be wrapped for JSPI.
- MuPDF is a pinned, unpatched dependency; upstream bugs are worked around by
  excluding sources and supplying stubs (`load-jpx.c`), not by patching.
