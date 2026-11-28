---
title: "The browser app"
description: "Seams, routing, viewers, caches, export and the WebAssembly rules."
weight: 3072
extra:
  reader: contributor
  type: reference
---

# The browser app

How the browser app is put together: its seams, routing, viewers, caches,
export and the WebAssembly rules. Why: [How the browser paces its work](@/contributor/browser-app.md).
Adding a kind of file touches most of these: [Add a file type](@/contributor/file-type.md).

## Seams

`main.ts` wires four seams. Each has a real implementation and a fake one;
development and the e2e suite run on the fakes, and `?real` or `?fake` in the
URL overrides the choice.

| Seam | Real | What it owns |
|---|---|---|
| `Api` (`api/types.ts`) | `createHttpApi()` | The wire contract. `api/fake.ts` is the reference behaviour. |
| `NoteRenderer` (`render/types.ts`) | `createWasmRenderer()` | SNPG page bytes to RGBA, in `note-decode.wasm`. |
| `RenderCache` (`cache/types.ts`) | `renderCache.ts` | Rendered pixels (see Caches below). |
| `LiveChannel` (`sync/types.ts`) | `live.ts`, server-sent events | Freshness ([Serving and caching](@/contributor/serving-rules.md)). |

Golden wire fixtures in `webapp/tests/fixtures/wire/` pin the server's JSON
as it passes through the client's normalisers;
`INK_UPDATE_WIRE_FIXTURES=1 zig build test` regenerates them.

## Routing

Routes live in the URL's hash, because the server has no fallback route for a
single-page app. Every place has a URL. Navigating pushes a history entry;
adjusting (a page turn, a find query) replaces one, so Back leaves a notebook
in one step. Pages in URLs are one-based. A trashed file lives under
`#/bin/note/:id`, because the live routes answer 404 for it; a past version is
addressed by a prefix of its md5.

## Viewers

Four viewers share one `Viewer` interface of four methods (`el`, `open`,
`hide`, `destroy`) and compose shared services (the viewer chrome, the toolbar,
the side panel, the page index, the layers panel, thumbnails, the virtual list)
rather than inheriting. Reach for those before writing a private copy.

A PDF is its own viewer, and an XPS's or a comic book's too
(`PAGED_DOCUMENT_TYPES`): MuPDF opens all three alike. A PDF's pages share
resources through its xref, so the document is opened once in a worker (MuPDF,
about 5 MB of wasm, one session for the viewer's life) and read by Range
requests through a 32 KB block cache. A PDF has no version history of its own;
its `.mark` does.

## Caches

- Four layers. L0, the app shell: fingerprinted, immutable. L1, listings and
  metadata: the only layer that revalidates, stale-while-revalidate gated on
  the sync version. L2, page bytes: immutable under `?v=`, in the browser's
  HTTP cache. L3, rendered pixels: `RenderCache`, keyed by content hash, size
  tier and theme, and never a source of truth.
- **One persistent pixel store**, `sn-thumbs`, shared by the render cache and
  the thumbnails under one byte budget. Thumbnails persist as WebP; raw RGBA
  was 20 to 40 times larger. Reader pages stay in memory.
- **Drawn thumbnails** (a `.txt`'s first lines, a glyph) are painted in the
  colours of the theme they are filed under (`THUMB_PALETTES`, from the
  tokens), never the page's current theme, because the page can be in the
  other theme while a switch is under way. A `.txt` card reads only the file's
  head: 4 KB, by a `Range` request on `/file/:id`, the same ranged route a PDF
  reads. Never the whole file.
- Every other IndexedDB cache has a database of its own, so adding a store
  never needs a version bump that another module's open connection would block.
  All of them degrade to doing nothing when storage is unavailable.
- Never paint a page that is off screen: every canvas renders lazily through an
  `IntersectionObserver`, and a theme toggle repaints only what is visible.

## Export

- Always in the browser, at native resolution, in the light theme, bypassing
  the render cache. Download only: an export never enters the tablet's
  `EXPORT/` folder.
- The PDF writer has no dependencies and streams: it pulls one page at a time
  and returns a Blob made of chunks, so a whole notebook peaks at about one
  page of memory.
- An invisible text layer is written only at a **verified** scale in
  millimetres (`pxPerMm`, an allowlist of measured hardware; only `N6`, the
  Nomad, today). A missing text layer is obvious; a mis-scaled one is silently
  wrong.
- An annotated PDF exports as an incremental update over the original bytes,
  keeping its forms, bookmarks and annotations. The ink is drawn into the page's
  content, not added as an annotation.

## WebAssembly rules

- Any call can grow linear memory and detach `memory.buffer`. Create views
  after the call that produces the data, never keep them, and copy out before
  the next call.
- `sqlite-core.wasm` serves both the `.spd` viewer and the search index (SQLite
  is most of its size). It runs on a null VFS, so `SQLITE_TEMP_STORE=3` is
  mandatory and is checked when the database opens.
- MuPDF needs the WebAssembly exception-handling proposal, which puts the
  browser floor at about Chrome 95, Firefox 131 and Safari 18.4. Every export
  that can suspend on `ink.host_read` must be wrapped for JSPI.
- MuPDF is a pinned, unpatched dependency. An upstream bug is worked around by
  excluding sources and supplying stubs, never by patching.
- A book (EPUB) is laid out as the tablet's reader lays it out, so its pages
  are the tablet's pages: `fz_layout_document` at 1200 x 1600 with a 100/3
  em, the numbers at which the reader's MuPDF 1.17 reproduces its own page
  33 of Moby Dick (`ink_layout_book` in `pdf_shim.c`; layout is not
  scale-invariant, so not 288 x 384 with 8). A user stylesheet undoes what
  our MuPDF does and 1.17 doesn't (`ink_tablet_css`: no automatic
  hyphenation, though a soft hyphen still breaks a line; no `hgroup`
  margins). The book face is the reader's: Charis SIL, and Noto
  Serif as the fallback for characters it lacks (U+FEFF, which would
  otherwise take a stand-in's width and move line breaks). The wasm build
  keeps them (`TOFU_NOTO`; `book_fonts.zig`: +479 KB raw, +264 KB brotli);
  Noto Serif reaches MuPDF through its public system-fallback hook, for the
  scripts its own font table gives it. `pdf_decode_abi/book.mjs` pins all of
  it on a small fixture. The layout and the stylesheet are never applied to
  a PDF, XPS or CBZ; the fallback font can reach a PDF only where MuPDF
  draws text itself (a form field's or note's generated appearance), as in
  a stock MuPDF build.
- `pdf-decode.wasm` declares a 1 GiB memory maximum (`pdf_decode_max_memory`
  in `build.zig`, pinned by `pdf_decode_abi/memory_cap.mjs`). A hostile
  document then fails as MuPDF's out-of-memory error instead of growing the
  worker until the tab dies. It is sized never to refuse what opens today: a
  scanned page at the largest raster (16 M px) peaks near 580 MiB, a session
  of them near 730 MiB, since wasm memory is never returned. After that error
  (or a trap) the instance is never used again: the request fails with its
  usual message ("Couldn't draw this page"), and the worker reopens the same
  document on a fresh instance (`spentDecoder`, `browserLoader().reset`,
  `replaceSpentDecoder`); a failed open is not retried. Calls that answer
  "nothing here" (words, links, the outline) throw instead when the instance
  ran out, so it is replaced too. A backstop, not a phone's protection.
