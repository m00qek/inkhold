# Frontend tests

Two layers. All tooling is devDependencies and never ships in the app bundle.

## Layer 1 — Vitest unit (`tests/unit/`)

Node environment, real Web Crypto, no jsdom. Covers the pure, security-critical
logic and the DOM-free data/cache/lazy machinery:

- `md5.test.ts` — MD5 against the RFC 1321 vectors + UTF-8 cross-check vs Node.
- `crypto.test.ts` — `sha256_hex(md5_hex(pw) + randomCode)`, pinned against an
  independent Node `crypto` computation.
- `client.test.ts` — the API client with a stubbed `fetch`: success envelope,
  `{success:false, errorCode}` mapping, HTTP 429 + `Retry-After` →
  `RateLimitError`, 401 → unauthorized, `me()` → null, network throw.
- `lru.test.ts` — the byte-budget LRU: total/count tracking, oldest-eviction on
  overflow, get-as-use recency, byte-weighting (one heavy entry evicts several
  light ones), `onEvict` on replace/evict/delete/clear, keep-the-just-added.
- `idb.test.ts` — the IndexedDB cap/eviction *decision* (pure): `planEviction`
  (oldest-access-first, purity) and `budgetForQuota` (80%-of-quota clamp,
  discounting our own usage, never negative, never over the desired budget).
- `freshness.test.ts` — SWR `classify` (miss/stale/fresh vs `syncVersion`),
  `sameEntry` (page-hash/updatedAt sensitivity), and `reconcile` (changed flag +
  entry-identity reuse on an unchanged refetch).
- `live.test.ts` — SSE `parseBump` (bare number / `{syncVersion}` / junk) and the
  `LiveChannel` reconnect policy with a fake `EventSource` + fake timers (bumps
  delivered, backoff only on terminal CLOSED, clean unsubscribe), plus the
  polling fallback (`parseVersionFromStream`, no-`EventSource` runtimes, giving
  up on SSE after repeated failed opens, and a poll loop that stops on
  unsubscribe).
- `lazy.test.ts` — the lazy scheduler with a mocked `IntersectionObserver` + stub
  api/renderer/cache: **off-screen slots never render**, painted slots don't
  re-render on re-intersect, cache-hits skip the api+renderer, `bumpTheme`
  repaints visible-only (rest → placeholder), and `prefetch` warms off-canvas —
  plus **failure reporting**: an `UNAUTHORIZED`/`STALE_PAGE` page fetch reaches the
  `ApiFailureSink` instead of a bare `catch {}`, while other failures stay silent
  and non-fatal.
- `httpApi.test.ts` — the real browse `Api` (`createHttpApi`) with a stubbed
  `fetch`: `/api/controlplane/tree` root vs `?parent=`, raw (un-enveloped) `Listing`/
  `NoteMeta`, the binary `/note/{id}/page/{n}?v=` fetch, and error mapping
  (router 401 → `UNAUTHORIZED`, note-404 envelope → `NOT_FOUND`, stale page 404 →
  `STALE_PAGE`, network throw → `NETWORK`). Also pins the **omitted-vs-null**
  normalization — the server omits null optionals, so a root listing arrives with
  no `folderId` at all and must map to `null` (the fake returns `null`, so this
  can only be caught against the real client) — and `dispatchApiFailure`, the seam
  that gives the error taxonomy its consumers.
- `wasm.test.ts` — **cross-language**: loads the real `public/note-decode.wasm`
  into Node's `WebAssembly` and decodes hand-built SNPG payloads (in the exact
  wire format `page_payload.serialize` emits): C-ABI presence, 1×1 black page,
  a multi-pixel black/transparent run (pixel probe), bottom-to-top layer
  compositing, and truncated-payload rejection — plus the pure `invertRgb`
  dark-theme inversion. Skips itself if the wasm artifact is absent (so CI without
  a Zig toolchain stays green); build it with `npm run build:wasm`.

Run: `npm run test:unit` (or `npm run test:unit:watch`).

## Layer 2 — Playwright E2E (`tests/e2e/`)

Real Chromium against the app (Vite dev server on a fixed port), backend fully
mocked with Playwright's native `page.route('**/api/**', ...)` — no MSW. The mock
helper is `tests/e2e/helpers/mockApi.ts`; each test scripts only the responses
for the state it drives. Session state is expressed by what `/api/user/me`
returns (the HttpOnly cookie is not round-tripped).

The library/reader run against the in-memory fake `Api` (no HTTP), so those specs
only mock the boot guard's `/api/user/me` (see `helpers/app.ts` → `signedIn`).
The lazy-render invariant is checked at the pixel level with `inkFraction` — a
theme-agnostic count of high-contrast (handwriting) pixels vs the paper corner,
so a blank placeholder reads ≈0 in either theme and a rendered page reads higher.

Specs:

- `login.spec.ts` — full-session login → library; first-login → change-password →
  library; wrong password (error shown, field cleared); rate limit; network failure.
- `session.spec.ts` — boot guard restores from `/me` (valid → library, pending →
  change-password, 401 → login); sign out → login; and a session that **expires
  while the library is open** → login (the one spec that runs the library with
  `?real`, since the fake `Api` cannot express a dead cookie).
- `library.spec.ts` — folders + notes + breadcrumbs; folder navigation and back;
  **off-screen thumbnail is a blank placeholder until scrolled into view** (the
  lazy pixel-probe against the fake's deep "Archive" folder); search filters.
- `reader.spec.ts` — open a note by `#/note/:id` and paint the current page;
  page navigation via pager, filmstrip, and keyboard; Back returns to the library.
- `theme.spec.ts` — toggle sets `data-theme` and repaints **only visible**
  thumbnails; off-screen ones stay blank placeholders (pixel-probed).
- `a11y.spec.ts` — focus on load, focus return on error, `aria-live` status,
  associated labels; plus library/reader landmarks + labelled controls and the
  reader's Back-button focus entry point.

First-time setup needs the browser binary: `npx playwright install chromium`.
Run: `npm run test:e2e`.

## Deferred — live E2E (`test:e2e:live`, NOT yet built)

A second Playwright project running the happy path against a **real**
`inkhold` server (instead of `page.route` mocks) is intentionally
deferred. It's blocked on two things:

1. A **deterministic-admin seam** — the first-run admin password is random today,
   so a test can't log in without capturing server stdout. Needs a test-only way
   to seed a known admin (e.g. an env-var/config bootstrap credential).
2. **Server spawn/teardown** in Playwright's `webServer` (build + run the Zig
   binary against a temp DB, then tear down).

Out of scope until the sync API settles. When picked up: add a `test:e2e:live`
project to `playwright.config.ts` guarded by an env flag, reuse the existing
specs' happy-path assertions, and drop the `page.route` mock for those.
