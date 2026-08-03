# Web app architecture & implementation plan

The static SPA that browses and reads notes synced from the device. Vanilla
TypeScript, **zero runtime dependencies**, strict `tsconfig`, Vite build, Vitest
unit + Playwright e2e. Served as-is by the Zig server (hash routing, no SPA
fallback). Design is the approved mockup (`docs/mockups/web-interface.html`).

## Seams (P0 — done)

Everything decouples through four interfaces so the UI, the control-plane backend, and the
WASM decoder can be built independently and meet here:

| Seam | File | Real impl | Fake impl |
|------|------|-----------|-----------|
| Data/browse | `src/api/types.ts` (`Api`) | `src/api/client.ts` → `createHttpApi()` ✅ (P4) | `src/api/fake.ts` ✅ |
| Rendering | `src/render/types.ts` (`NoteRenderer`) | `src/render/wasm.ts` → `createWasmRenderer()` ✅ (P5) | `src/render/fake.ts` ✅ |
| Render cache (L3) | `src/cache/types.ts` (`RenderCache`) | `src/cache/renderCache.ts` ✅ (P1) | — |
| Live freshness (L1) | `src/sync/types.ts` (`LiveChannel`) | `src/sync/live.ts` ✅ (P1, SSE) | test double |

Domain vocabulary is `src/core/types.ts`. **Do not change a seam signature
without updating this table and pinging the coordinator** — all three tracks
depend on them.

## Export (`src/export/`)

`pdf.ts` is a pure, dependency-free PDF writer (pixels in, bytes out — unit-tested
in Node); `exporter.ts` is the browser half that decodes, rasterises and downloads.

Four rules hold this together:

- **Client-side, always.** Pixels come from the WASM renderer at the `native`
  tier, in the light theme, **bypassing `RenderCache`** — the cache is keyed by
  the on-screen theme and capped at the display tier, and full-resolution export
  bitmaps have no business in its budget.
- **Download-only.** Exports never enter the device's `EXPORT/` folder, which
  keeps them clear of the `absence = deletion` question entirely.
- **A text layer only at a VERIFIED scale.** `NoteMeta.pxPerMm` is null for
  hardware the server has not measured, and null means raster-only. A missing
  text layer is obvious; a mis-scaled invisible one is not, and that asymmetry is
  the whole reason the scale is an allowlist rather than a fallback.
- **One page of heap, whatever the length.** `buildPdf` takes an (async) iterable
  and pulls **one page at a time**, deflating and writing each before asking for
  the next, and returns a **Blob** assembled from chunks — never a joined
  `Uint8Array`. A whole-notebook export therefore peaks at about one 2.63 MB page
  rather than the notebook. The unit tests assert that *ordering* rather than a
  heap reading: a browser has no peak-tracking allocator, but the pull order is
  deterministic and it is what produces the memory behaviour.

The menu itself is three groups — *this page, current view* · *this page,
original view* · *whole notebook* — built in `pages/readerExports.ts`. Rows that
cannot mean anything for the page in front of you are **hidden, not disabled**:
the layered `.ora` row needs a layer stack, and the whole *original view* group
appears only once a layer's live visibility differs from the device-authored one,
because until then the two exports would be byte-identical.

## Cache strategy (see memory `file-serving-and-cache`)

- **L0 app shell** — Vite fingerprints, immutable.
- **L1 listing/metadata** — the only layer that revalidates: stale-while-revalidate
  gated on a per-user `syncVersion`, pushed live over **SSE** (`LiveChannel`).
- **L2 page bytes** — `GET /note/{id}/page/{n}?v={hash}`, immutable, browser
  HTTP cache (transparent; `getPageBytes` just fetches).
- **L3 rendered output** — `RenderCache` keyed by `(pageHash, size, theme)`:
  in-memory byte-budget LRU + IndexedDB (own byte cap) for thumbnails.
  **Never a source of truth** — any miss re-renders; eviction is always safe.
  The `native` tier is export-only and deliberately never cached.

## Universal lazy rule

Never paint an off-screen page. All three canvas sites — gallery thumbnails,
reader filmstrip, reader viewer — render lazily via `IntersectionObserver`
(`render/lazy.ts`), show a static placeholder off-screen, cache by page hash, and
on theme toggle repaint **only** what's visible. The mockup proves the behaviour;
port it, don't redesign.

## Phases

- **P0 Contracts & fakes** — ✅ types + 4 seams + `fake.ts` (Api, renderer). Typechecks clean.
- **P1 Data & cache (pure, DOM-free, fully unit-tested)** — ✅ `cache/lru.ts`
  (byte-budget), `cache/idb.ts` (IndexedDB + own cap + `navigator.storage.estimate`;
  pure `planEviction`/`budgetForQuota`), `cache/renderCache.ts` (mem+idb tiers),
  `sync/freshness.ts` (SWR `classify`/`reconcile`), `sync/live.ts` (EventSource
  wrapper). Units: `lru`, `idb`, `freshness`, `live`.
- **P2 Lazy render engine** — ✅ `render/lazy.ts` (IntersectionObserver
  orchestration, cache-check → getPageBytes → render → put → paint; theme-bump
  repaints visible only; `renderPage` shared with the viewer; idle `prefetch`).
  Scheduler unit-tested with a mocked IntersectionObserver + stub renderer/api
  (asserts off-screen slots never render).
- **P3 UI pages** — ✅ `pages/library.ts` (rail + topbar + gallery + folder nav +
  search/sort/view + theme toggle + toast, kept alive behind the reader),
  `pages/reader.ts` (filmstrip + viewer + pager/zoom + neighbour prefetch),
  `router.ts` reader route `#/note/:id`, `main.ts` wires the one dependency graph
  from the fakes. Mockup CSS extracted into `styles.css` tokens (both themes,
  `prefers-color-scheme` + `data-theme`). Playwright pixel-probes prove lazy
  thumbnails, reader navigation, and theme-repaints-visible-only.
- **P4 Control-plane backend (Zig) + client swap** — ✅ `backend/services/controlplane.zig`
  + `routes.zig` serve `/api/controlplane/tree`, `/api/controlplane/note/{id}`, `/note/{id}/page/{n}`
  (immutable `?v=` byte-range), and `/api/controlplane/events` (SSE `event: sync`). The JSON
  is emitted **raw** (no `{success}` envelope); page bytes are the binary SNPG
  payload. Real client: `createHttpApi()` in `client.ts` (reuses `request` +
  `ApiError`/`RateLimitError`; binary page fetch via `arrayBuffer()`). `live.ts`
  now subscribes to the server's named `sync` frame. **NOTE:** `page.hash` (the
  `?v=` key) is the md5 of the page's layer-bitmap content, **not** of the SNPG
  bytes — treat it as an opaque cache/version token only.
- **P5 WASM `.note` decoder (Zig) + renderer swap** — ✅ `zig build
  wasm-note-decode` → `public/note-decode.wasm` (~4 KB), consuming the SNPG
  payload via the C-ABI in `docs/wasm-note-decoder.md`. Real renderer:
  `createWasmRenderer()` in `render/wasm.ts` — instantiate once, `alloc`+copy →
  `decode_page` → read `result_*` → RGBA; applies **theme inversion** (dark) and
  `RenderSize` downscale, then `createImageBitmap`. Cross-language decode verified
  in Node against the real wasm (`tests/unit/wasm.test.ts`).
- **P6 Full-text search** — ✅ `Api.searchText(query, limit?)` over
  `GET /api/controlplane/search` (FTS5 across the recognised OCR transcripts,
  bm25-ranked, server-scoped to the caller's own non-deleted notes). The library's
  search box now answers **both** halves of its promise at once: the gallery keeps
  filtering the current folder by NAME, and a `.hits` block beneath it lists the
  matching PAGES library-wide. `pages/noteSearch.ts` owns the debounce (220 ms) and
  the token-based staleness guard, DOM-free and unit-tested like `ocrPanel.ts`.
  Hits deep-link via the new `#/note/:id/page/:n` route (page 0 collapses to
  `#/note/:id`), so reader *position* is a function of the route the same way
  reader *visibility* already was. **`SearchHit.snippet` is PRE-ESCAPED HTML** —
  the backend escapes the device-authored transcript and splices `<mark>` in
  afterwards, so it is rendered with `innerHTML` and must never be escaped again;
  every sibling field (`noteName`) stays `textContent`. It is the only server
  string in the app that reaches `innerHTML`.
- **Integration swap (`main.ts`)** — ✅ the shipped app defaults to the real `Api`
  + WASM renderer + SSE `LiveChannel`; dev/e2e default to the fakes (no backend/
  wasm needed). `?real` forces the real stack in dev; `?fake` forces the fakes in a
  prod build. Vite proxies `/api/*` and `^/note/` to the Zig port (the regex spares
  the `/note-decode.wasm` public asset).

## Quality bar

Match the existing scaffold: file-level comments explaining *why*; `el`/`mount`
DOM helpers (no framework); typed envelope client; strict TS (`noUncheckedIndexedAccess`,
`verbatimModuleSyntax` → `import type`). Pure logic is DOM-free and unit-tested;
visual behaviour is Playwright pixel-probed (ink-percentage technique). `npm run
build` (typecheck + vite) and `npm test` stay green.
