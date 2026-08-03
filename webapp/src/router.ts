// A tiny hash-based router. Hash routing means the app is a single static file
// the Zig server can serve as-is: every URL is `index.html#/path`, so there is
// no server-side SPA fallback to implement (a guardrail — the backend is fixed).
//
// Routes are parsed into a small tagged union; everything unrecognized falls
// back to the library.
//
// ============================================================================
// THE RULE: EVERY PLACE HAS A URL.
//           EVERY NAVIGATION PUSHES; EVERY ADJUSTMENT REPLACES.
// ============================================================================
//
// A PLACE is somewhere you went — a folder, the recycle bin, the admin console,
// a library-wide search, a document. An ADJUSTMENT is a knob you turned while
// you were already there: which page of the note you are on, what you have typed
// into a search you are already looking at. BOTH belong in the URL; only the
// first belongs in HISTORY. The rule, its route table and its two exceptions are
// written down outside this file, because a rule that lives only in a code
// comment gets broken by the next person adding a destination in a hurry:
// `docs/explanation/routing.md`.
//
// Reader visibility is a function of the route, and so is which folder the
// gallery is listing: the URL never lies about what is on screen, because the
// URL is what put it there. A place the URL cannot describe reloads to the wrong
// screen, cannot be shared, and makes Back's meaning depend on how you got there
// — which is precisely the incoherent shape folder navigation had for as long as
// it was internal shell state.
//
// ADDRESSABILITY IS NOT `pushState`. This file used to argue that paging must
// not be routed at all, on the grounds that "pushing a history entry per page
// turn would make Back mean 'previous page' for a note you paged through and
// 'the library' for one you didn't". That objection is correct, and it is an
// argument against pushing HISTORY ENTRIES — not against the URL describing the
// page. The two were conflated.
//
// `history.replaceState` separates them: it rewrites the address bar without
// adding an entry. Reload, copy and share all work, while Back still means "the
// library" for every note, however far through it you read. So page turns and
// find-query changes REPLACE (see {@link replaceNotePosition}) and nothing in
// the reader ever pushes. Query changes are debounced by the caller, so Back
// never has to step through `w`, `wi`, `wit` — but with replace it could not
// anyway; the debounce is there to keep the address bar from thrashing.
//
// A consequence worth stating, because a regression test turns on it: a second
// dispatch of the same `#/note/:id/page/:n?q=…` is now IDEMPOTENT. It re-opens
// the reader where the reader already is, instead of throwing a paged reader
// back to the entry page.

// The destination keys are IMPORTED, not restated. `#/bin` and `#/admin` are
// spelled by the same strings the rail routes on, so a destination cannot end up
// with a route name that drifts from its key — adding one stays a single line in
// `DESTINATIONS`, which is the promise rail.ts makes about that list.
import { DESTINATION_KEYS } from "./core/destinations";
import type { Id } from "./core/types";

const DESTINATION_KEY_SET = new Set<string>(DESTINATION_KEYS);

export type Route =
  | { name: "login" }
  | { name: "change-password" }
  /**
   * The last step of first-run onboarding: connect the Supernote. Reached only
   * after the mandatory password change; its guard ({@link ensureProfile} in
   * main.ts) bounces anyone not fully signed-in back to login/change-password, so
   * it is not a way around the auth wall. A place, so a reload during onboarding
   * stays on the connect step rather than jumping into an empty library.
   */
  | { name: "connect" }
  /** The library root — the top of the device's tree. */
  | { name: "library" }
  /**
   * YOUR OWN ACCOUNT (docs/scratch/user-options.md §7) — password, sessions,
   * devices, storage, appearance.
   *
   * A PLACE, not a menu, and so a route: it is easy to link to, a reload lands
   * back on it, and Back out of it means "the library" the way Back out of the
   * bin does. Its crumb reads `Library / You`, which is what the path spells.
   *
   * NOT a {@link Destination} — it has no rail row, because the rail footer's
   * nameplate IS its door and a second entrance in the nav would be one control
   * for one place in two places. It is deliberately not admin-gated either: a
   * household member who is not an admin has no other surface at all, and this
   * one is entirely about their own account (§8.2).
   */
  | { name: "account" }
  /**
   * A folder listing. The id is the device's own, which is what makes this a
   * durable link: folder ids are assigned by the device and never reissued
   * (relocating a row would invalidate the id the device knows, so nothing
   * does — see docs/scratch/recycle-bin.md). Opaque, but stable, which is the
   * only property a key in a URL has to have.
   */
  | { name: "folder"; id: Id }
  /**
   * A LIBRARY-WIDE search. Deliberately not `#/folder/:id?q=`: results span the
   * whole library, so a folder in the URL would claim a scope the search does
   * not have — the same lie the breadcrumb refuses to tell by reading just
   * "Search".
   */
  | { name: "search"; q: string }
  /**
   * The recycle bin, the admin console — a {@link Destination} in rail.ts. One
   * route arm for all of them, keyed by the rail's own key.
   */
  | { name: "destination"; key: string }
  | {
      name: "note";
      id: string;
      /**
       * The page to open at, **0-based** — an INTERNAL index, matching the
       * reader, the filmstrip and the lazy engine, all of which count from zero.
       *
       * The URL counts from ONE (`/page/5` is the fifth page). That conversion
       * happens HERE and only here, in {@link parseRoute} and
       * {@link notePageHref}: the router is exactly the seam where an internal
       * representation becomes a public one, and doing it anywhere else would
       * spread `+1`/`-1` through the app until some producer or consumer was
       * missed. A conversion applied in some places and not others is worse than
       * a consistent-but-wrong scheme.
       */
      page: number;
      /**
       * The in-note search to prime find with. `""` means "no search" — the bar
       * stays shut, which is the state that costs nothing.
       */
      q: string;
    }
  /**
   * A URL-ADDRESSABLE PREVIEW OF A RETAINED VERSION (hot-cache versioning). The
   * CURRENT version keeps the bare `#/note/:id/page/:n` above — "current" is a
   * moving pointer whose stable identity is the file id, and that address
   * deliberately tracks edits. This form pins a specific immutable blob: a PAST
   * version, addressed by a 7-hex-char md5 PREFIX (`:short`). The `:id` already
   * scopes the prefix to that one file's handful of retained versions, so 7 hex
   * chars disambiguate them with collision odds that round to zero.
   *
   * The prefix is resolved to the full md5 CLIENT-SIDE, against the version list
   * the history panel already fetches (`main.ts`): a live-md5 match canonicalises
   * back to the bare note URL, a past match opens the preview, and a prefix that
   * has aged out of the hot cache falls back to the live note. `page` mirrors the
   * note route (optional `/page/:n`, 0-based here, one-based in the URL).
   */
  | { name: "note-version"; id: string; short: string; page: number }
  /**
   * A URL-ADDRESSABLE OPEN OF A TRASHED FILE — the recycle bin's analogue of the
   * `note` route. `#/bin` is the bin LISTING (a {@link Destination}); THIS is a
   * deeper path UNDER it, naming one trashed file open in a viewer at a page.
   *
   * A trashed file's blob is NOT served at the live `#/note/:id` route (which
   * 404s and falls back to the library), so a bin-origin open needs its OWN
   * address: without one a reload / copy-link reopens a dead id. The `id` is the
   * device's own (durable, never reissued — the same property that makes the
   * folder id a good key); `page` mirrors the note route (optional `/page/:n`,
   * 0-based here, one-based in the URL). NO `?q=`: a bin URL pins the file + page,
   * not an in-file search — the reader drops its find query in bin mode.
   */
  | { name: "bin-note"; id: Id; page: number };

function path(): string {
  return window.location.hash.replace(/^#/, "") || "/";
}

/**
 * The `q` of a hash query string, decoded.
 *
 * Hand-rolled rather than `URLSearchParams` for one reason: `URLSearchParams`
 * decodes `+` as a space, and a find query is device-facing text where a literal
 * `+` is a plausible thing to look for. {@link noteHref} writes with
 * `encodeURIComponent`, which never emits a bare `+`, so this is the exact
 * inverse of what we produce and nothing else.
 *
 * A malformed percent-escape (a hand-edited URL) decodes to itself rather than
 * throwing: a bad query is a bad search, not a broken route.
 */
function readQ(search: string): string {
  const m = search.match(/(?:^|&)q=([^&]*)/);
  if (!m) return "";
  try {
    return decodeURIComponent(m[1]!);
  } catch {
    return m[1]!;
  }
}

/**
 * Parse a hash path (no leading `#`) into a route. Exported so the parsing —
 * including the encoding round trip — is exercisable without a DOM.
 */
export function parseRoute(raw: string): Route {
  // The query is split off FIRST. Without this, `#/note/x?q=term` fails the note
  // pattern outright and falls back to the library — the note would open as the
  // wrong screen entirely rather than merely without its search.
  const cut = raw.indexOf("?");
  const p = cut < 0 ? raw : raw.slice(0, cut);
  const search = cut < 0 ? "" : raw.slice(cut + 1);

  if (p === "/login") return { name: "login" };
  if (p === "/change-password") return { name: "change-password" };
  if (p === "/connect") return { name: "connect" };
  // A FIXED PATH, checked here with the others, so it can never be shadowed by
  // a `DESTINATIONS` entry somebody adds later with the key `account`: the
  // destination fallback runs last precisely so a route that already means
  // something wins.
  if (p === "/account") return { name: "account" };
  if (p === "/search") return { name: "search", q: readQ(search) };
  // Same `[^/]+` reasoning as the note id below: a device-assigned folder id is
  // percent-encoded in, so nothing inside one can be read as a path separator.
  const folder = p.match(/^\/folder\/([^/]+)$/);
  if (folder) return { name: "folder", id: decodeURIComponent(folder[1]!) };
  // The version-preview form, tried BEFORE the bare note pattern below (which is
  // anchored and would not match a `/version/` segment anyway, but ordering keeps
  // the intent legible). Same `[^/]+` reasoning as the note id: the id is
  // percent-encoded, so nothing inside it reads as the `/version/` separator. The
  // `:short` is an md5 prefix — hex only — and the optional `/page/:n` suffix
  // mirrors the note route so a version's page deep-links too.
  const version = p.match(/^\/note\/([^/]+)\/version\/([^/]+)(?:\/page\/([^/]*))?$/);
  if (version) {
    return {
      name: "note-version",
      id: decodeURIComponent(version[1]!),
      short: decodeURIComponent(version[2]!),
      page: urlPage(version[3]),
    };
  }
  // The recycle-bin open form: the twin of the note route, one path deeper under
  // `#/bin` (which stays the bin LISTING — a destination handled below). Tried
  // BEFORE the bare note pattern and the destination fallback so `/bin/note/:id`
  // reads as a trashed-file open rather than as the `bin` destination key
  // (`bin/note/x` is not one) or the library. Same `[^/]+`/`[^/]*` leniency as
  // the note route: the id is percent-encoded, the page clamps in `urlPage`.
  const binNote = p.match(/^\/bin\/note\/([^/]+)(?:\/page\/([^/]*))?$/);
  if (binNote) {
    return { name: "bin-note", id: decodeURIComponent(binNote[1]!), page: urlPage(binNote[2]) };
  }
  // `[^/]+` for the id rather than `.+`: ids are percent-encoded into the hash,
  // so a `/` inside one arrives as `%2F` and can never be confused for the
  // `/page/` separator. The suffix is optional, so every existing `#/note/:id`
  // link — and every spec asserting one — keeps working and means page 1.
  // The page segment is matched as `[^/]*`, not `\d+`, so a hand-edited
  // `/page/abc` still reads as THIS NOTE (at its first page) instead of falling
  // through to the library — a mistyped page number is a mistyped page number,
  // not a different screen. Everything unparseable is clamped in `urlPage`.
  const note = p.match(/^\/note\/([^/]+)(?:\/page\/([^/]*))?$/);
  if (!note) {
    // LAST, after every fixed path, so a destination key can never shadow one.
    // `DESTINATIONS` is data somebody else edits; a future key of `search` or
    // `login` must lose to the route that already means something rather than
    // silently take it over.
    const key = p.slice(1);
    if (p.startsWith("/") && DESTINATION_KEY_SET.has(key)) return { name: "destination", key };
    return { name: "library" };
  }
  return {
    name: "note",
    id: decodeURIComponent(note[1]!),
    page: urlPage(note[2]),
    q: readQ(search),
  };
}

/**
 * A `/page/:n` segment, as the reader's 0-based index.
 *
 * THE URL COUNTS FROM ONE. A URL is user-facing text and humans number pages
 * from one, so `/page/5` is the fifth page — the same class of decision as not
 * putting an array index in an address bar. Internally everything counts from
 * zero, so this subtracts, once, at the boundary.
 *
 * EVERYTHING ELSE CLAMPS TO THE FIRST PAGE rather than erroring: `/page/0`
 * (which now means nothing), a negative, a word, an empty segment, and the
 * overflow case (`/page/999999999999999999999`, where `parseInt` yields a number
 * that is not a safe integer). A hand-edited URL should land somewhere sensible.
 * Past the END of the note is not clamped here — the router does not know how
 * long the note is — and the reader clamps it into range on `open`.
 */
function urlPage(segment: string | undefined): number {
  if (segment === undefined) return 0; // the bare `#/note/:id` is the first page
  const n = Number.parseInt(segment, 10);
  if (!Number.isSafeInteger(n) || n < 1) return 0;
  return n - 1;
}

export function current(): Route {
  return parseRoute(path());
}

/**
 * Hash href for a folder listing. `null` is the library root, which keeps its
 * bare `#/` — the root is not a folder with an id, and giving it one would mean
 * two spellings of the same place.
 */
export function folderHref(id: Id | null): string {
  return id === null ? "#/" : `#/folder/${encodeURIComponent(id)}`;
}

/**
 * Hash href for a library-wide search.
 *
 * A BLANK QUERY IS NOT A PLACE — "search for nothing" is just the library — so
 * it collapses to the root rather than producing a second URL that renders the
 * same screen. Callers that want to keep the folder they were standing in ask
 * for {@link folderHref} instead; see the search box in library.ts.
 */
export function searchHref(q: string): string {
  return q.trim() === "" ? "#/" : `#/search?q=${encodeURIComponent(q)}`;
}

/** Hash href for a {@link Destination} — `#/bin`, `#/admin`. */
export function destinationHref(key: string): string {
  return `#/${key}`;
}

/** Hash href for your own account page — what the rail's nameplate opens. */
export function accountHref(): string {
  return "#/account";
}

/**
 * Hash href for a note's reader — use in `<a>` and `go()`.
 *
 * `q` primes find-in-note: the bar opens, the query is set, and the reader lands
 * on the first match. It is percent-encoded, so a query containing `/`, `#`, `&`,
 * a space or an accented character survives the round trip intact — a `#` in
 * particular would otherwise truncate the hash and lose the whole route.
 */
export function noteHref(id: string, q = ""): string {
  return notePageHref(id, 0, q);
}

/**
 * Hash href for a note's reader opened at a specific page with an optional
 * in-note search — what a search hit links to.
 *
 * `page` IS THE INTERNAL 0-BASED INDEX; the URL it produces counts from one, so
 * internal page 4 is written `/page/5`. See {@link urlPage} for the inverse and
 * for why the conversion lives at this boundary and nowhere else.
 *
 * THE FIRST PAGE COLLAPSES to the bare path so there is ONE canonical URL for
 * "open this note at the start" rather than two spellings of it appearing in the
 * history depending on where the user clicked. `/page/1` is accepted on the way
 * in — people type and share it — it is simply never what we emit. An empty `q`
 * drops the query string for the same reason.
 */
export function notePageHref(id: string, page: number, q = ""): string {
  const index = Math.floor(page);
  const base =
    index > 0
      ? `#/note/${encodeURIComponent(id)}/page/${index + 1}`
      : `#/note/${encodeURIComponent(id)}`;
  return q === "" ? base : `${base}?q=${encodeURIComponent(q)}`;
}

/**
 * Hash href for a URL-addressable preview of a retained VERSION — the
 * `#/note/:id/version/:short` form, with the same one-based `/page/:n` suffix
 * the note route uses (the first page collapses to the bare version path, as it
 * does there).
 *
 * `short` is the 7-hex-char md5 prefix; it needs no encoding (hex only). Only a
 * PAST version is addressed this way — the current version keeps
 * {@link notePageHref}, because "current" is a moving pointer, not a blob hash.
 */
export function noteVersionHref(id: string, short: string, page = 0): string {
  const index = Math.floor(page);
  const base =
    index > 0
      ? `#/note/${encodeURIComponent(id)}/version/${short}/page/${index + 1}`
      : `#/note/${encodeURIComponent(id)}/version/${short}`;
  return base;
}

/**
 * The version-preview twin of {@link replaceNotePosition}: rewrite the address
 * bar to the previewed version's current page WITHOUT a history entry.
 *
 * IT ONLY REFINES A ROUTE THAT IS ALREADY THIS VERSION'S — the same overlay /
 * teardown-race guard, extended to the `short` prefix so a late page turn from
 * one preview can never write over another version's (or a live note's) URL.
 */
export function replaceNoteVersionPosition(id: string, short: string, page: number): void {
  const now = current();
  if (now.name !== "note-version" || now.id !== id || now.short !== short) return;
  const target = noteVersionHref(id, short, page);
  if (path() === target.slice(1)) return;
  window.history.replaceState(window.history.state, "", target);
}

/**
 * Hash href for a TRASHED file open in a viewer — the `#/bin/note/:id/page/:n`
 * form, the recycle-bin twin of {@link notePageHref}. Same one-based `/page/:n`
 * suffix, the first page collapsing to the bare `#/bin/note/:id` so there is ONE
 * spelling of "open this trashed file at the start". NO `?q=`: a bin URL pins the
 * file + page, not an in-file search. `#/bin` itself stays the bin LISTING — this
 * is a deeper path under it, addressing what the listing opens.
 */
export function binNotePageHref(id: Id, page = 0): string {
  const index = Math.floor(page);
  return index > 0
    ? `#/bin/note/${encodeURIComponent(id)}/page/${index + 1}`
    : `#/bin/note/${encodeURIComponent(id)}`;
}

/**
 * The recycle-bin twin of {@link replaceNotePosition}: rewrite the address bar to
 * the trashed file's current page WITHOUT a history entry, so a reload / copy
 * -link reopens the same trashed file at the same page.
 *
 * IT ONLY REFINES A ROUTE THAT IS ALREADY THIS BIN FILE'S — the same overlay /
 * teardown-race guard the other viewer-URL writers carry, so a late page turn
 * after the viewer closed (or after another file opened) can never write a bin
 * URL over the listing or over a different file. No `q` parameter: the bin URL
 * does not carry an in-file search.
 */
export function replaceBinNotePosition(id: Id, page: number): void {
  const now = current();
  if (now.name !== "bin-note" || now.id !== id) return;
  const target = binNotePageHref(id, page);
  if (path() === target.slice(1)) return;
  window.history.replaceState(window.history.state, "", target);
}

/**
 * Rewrite the address bar to the reader's CURRENT position and search, WITHOUT
 * a history entry.
 *
 * This is what makes the page and the find query addressable while keeping Back
 * a single, predictable step out of the note (see the file header). Two rules
 * hold it together:
 *
 *  - `replaceState`, never `push`. Reading is not navigating.
 *  - IT ONLY REFINES A NOTE ROUTE THAT IS ALREADY THIS NOTE'S. The reader is an
 *    overlay whose teardown races the route: a late `showPage` after the reader
 *    closed, or after another note opened, would otherwise write a note URL over
 *    the library — the URL lying about what is on screen, which is the exact
 *    failure the route-as-source-of-truth rule exists to prevent.
 *
 * A no-op when the URL already says this, so an idempotent repaint does not
 * touch history at all.
 */
export function replaceNotePosition(id: string, page: number, q: string): void {
  const now = current();
  if (now.name !== "note" || now.id !== id) return;
  const target = notePageHref(id, page, q);
  if (path() === target.slice(1)) return;
  window.history.replaceState(window.history.state, "", target);
}

/**
 * Rewrite the address bar WITHOUT a history entry and WITHOUT re-dispatching —
 * the general form of {@link replaceNotePosition}, for an ADJUSTMENT the caller
 * has already painted itself.
 *
 * The search box is the one caller: every keystroke after the first refines a
 * search you are already looking at, and the shell repaints synchronously from
 * the same handler, so re-dispatching here would paint the identical list twice
 * per letter.
 */
export function replaceRoute(to: string): void {
  const target = to.replace(/^#/, "");
  if (path() === target) return;
  window.history.replaceState(window.history.state, "", `#${target}`);
}

/**
 * A REDIRECT: correct the URL in place and render what it now says.
 *
 * Distinct from {@link go} in the one way that matters — it consumes the current
 * entry instead of adding one — because the thing being corrected was never a
 * place. A deep link to a folder that has been deleted, or a hand-typed
 * `#/search` with nothing in it, must not leave a rung on the history ladder
 * that Back can climb onto and be redirected off again, forever.
 */
export function redirect(to: string): void {
  replaceRoute(to);
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}

/** Navigate to a hash path (leading '#' optional) — a PUSH, because navigating
 * is what history is for. Re-fires even if unchanged so a re-entry (e.g. back to
 * the same library) still triggers a render. */
export function go(to: string): void {
  const target = to.replace(/^#/, "");
  if (path() === target) {
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  } else {
    window.location.hash = target;
  }
}

/**
 * Registers a render callback fired ONCE on load and on every hash change.
 *
 * THE INITIAL DISPATCH IS LATCHED. `readyState` flips to `"interactive"` just
 * BEFORE `DOMContentLoaded`, so a module evaluating inside that window could
 * dispatch the route twice. It is no longer destructive — the URL carries the
 * reader's position now — but the latch stays, because without it idempotence
 * here would rest on every consumer of a route being idempotent too.
 *
 * A ROUTE ARM IS ASYNC, AND ITS REJECTION IS HANDLED HERE — at the seam, not in
 * the arm. `render` was once typed `(route) => void` while its only caller
 * passed an `async` function, so every arm's promise was discarded; on the boot
 * arm, which rejects whenever the server is unreachable, that was a permanently
 * blank page. Catching in the arm fixes only the arms someone remembers to wrap.
 * `onFailure` is REQUIRED for the same reason: a caller that has not said what a
 * failed route looks like has not finished writing one.
 */
export function onRoute(
  render: (route: Route) => void | Promise<void>,
  onFailure: (error: unknown, route: Route) => void,
): void {
  const run = () => {
    const route = current();
    try {
      // `void` on the catch, not on `render(...)`: the rejection is now handled,
      // so nothing is left floating. A synchronous throw lands in the catch below.
      const done = render(route);
      if (done) void done.catch((error: unknown) => onFailure(error, route));
    } catch (error) {
      onFailure(error, route);
    }
  };
  window.addEventListener("hashchange", run);
  let started = false;
  const start = () => {
    if (started) return;
    started = true;
    run();
  };
  if (document.readyState === "loading") window.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
}
