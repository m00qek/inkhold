// A tiny hash router: every URL is `index.html#/path`, so the static server
// needs no SPA fallback. Unrecognized routes fall back to the library.
//
// Every place has a URL; navigation pushes, adjustments (page turns, find
// query) replace. `replaceState` keeps reload/share working while Back still
// leaves a note in one step.

import { DESTINATION_KEYS } from "./core/destinations";
import type { Id } from "./core/types";

const DESTINATION_KEY_SET = new Set<string>(DESTINATION_KEYS);

export type Route =
  | { name: "login" }
  | { name: "change-password" }
  /**
   * The last onboarding step, after the mandatory password change; guarded by
   * {@link ensureProfile} in main.ts.
   */
  | { name: "connect" }
  /** The library root — the top of the device's tree. */
  | { name: "library" }
  /**
   * Your own account. Not a {@link Destination} (the rail nameplate is its
   * door) and not admin-gated.
   */
  | { name: "account" }
  /** A folder listing, by the device's own id (never reissued, so links are durable). */
  | { name: "folder"; id: Id }
  /** A library-wide search; no folder in the URL, since the scope is the whole library. */
  | { name: "search"; q: string }
  /** A rail {@link Destination} (bin, admin), keyed by the rail's own key. */
  | { name: "destination"; key: string }
  | {
      name: "note";
      id: string;
      /**
       * 0-based page; the URL counts from one. The conversion happens only in
       * {@link parseRoute} and {@link notePageHref}.
       */
      page: number;
      /** The in-note search to prime find with; `""` = none. */
      q: string;
    }
  /**
   * Preview of a retained version, by 7-hex md5 prefix (`:short`), scoped to
   * the file's few versions. Resolved client-side against the history list in
   * main.ts: a live-md5 match canonicalizes to the note URL, an aged-out
   * prefix falls back to the live note.
   */
  | { name: "note-version"; id: string; short: string; page: number }
  /**
   * A trashed file open in a viewer, under `#/bin` (the listing). Needed
   * because the live note route 404s for trashed ids. No `?q=`.
   */
  | { name: "bin-note"; id: Id; page: number };

function path(): string {
  return window.location.hash.replace(/^#/, "") || "/";
}

/**
 * The `q` of a hash query string, decoded. Not `URLSearchParams`, which turns
 * `+` into a space; {@link noteHref} never emits a bare `+`. A malformed escape
 * decodes to itself rather than throwing.
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

/** Parse a hash path (no leading `#`) into a route. */
export function parseRoute(raw: string): Route {
  // Split the query first, or `#/note/x?q=term` fails the note pattern.
  const cut = raw.indexOf("?");
  const p = cut < 0 ? raw : raw.slice(0, cut);
  const search = cut < 0 ? "" : raw.slice(cut + 1);

  if (p === "/login") return { name: "login" };
  if (p === "/change-password") return { name: "change-password" };
  if (p === "/connect") return { name: "connect" };
  // A fixed path, so a later `account` destination key cannot shadow it.
  if (p === "/account") return { name: "account" };
  if (p === "/search") return { name: "search", q: readQ(search) };
  // Ids are percent-encoded, so `[^/]+` can't swallow a separator.
  const folder = p.match(/^\/folder\/([^/]+)$/);
  if (folder) return { name: "folder", id: decodeURIComponent(folder[1]!) };
  const version = p.match(/^\/note\/([^/]+)\/version\/([^/]+)(?:\/page\/([^/]*))?$/);
  if (version) {
    return {
      name: "note-version",
      id: decodeURIComponent(version[1]!),
      short: decodeURIComponent(version[2]!),
      page: urlPage(version[3]),
    };
  }
  // Before the note pattern and the destination fallback, so `/bin/note/:id`
  // isn't read as the `bin` destination.
  const binNote = p.match(/^\/bin\/note\/([^/]+)(?:\/page\/([^/]*))?$/);
  if (binNote) {
    return { name: "bin-note", id: decodeURIComponent(binNote[1]!), page: urlPage(binNote[2]) };
  }
  // The page segment is `[^/]*`, not `\d+`, so a mistyped `/page/abc` still
  // opens this note (clamped in `urlPage`).
  const note = p.match(/^\/note\/([^/]+)(?:\/page\/([^/]*))?$/);
  if (!note) {
    // Last, so a destination key can never shadow a fixed route.
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
 * A `/page/:n` segment (one-based) as a 0-based index. Anything invalid,
 * including `/page/0` and unsafe integers, clamps to the first page; past the
 * end is clamped by the reader.
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

/** Hash href for a folder; `null` (root) keeps the bare `#/`. */
export function folderHref(id: Id | null): string {
  return id === null ? "#/" : `#/folder/${encodeURIComponent(id)}`;
}

/** Hash href for a library-wide search. A blank query collapses to the root. */
export function searchHref(q: string): string {
  return q.trim() === "" ? "#/" : `#/search?q=${encodeURIComponent(q)}`;
}

/** Hash href for a {@link Destination} — `#/bin`, `#/admin`. */
export function destinationHref(key: string): string {
  return `#/${key}`;
}

/** Hash href for your own account page. */
export function accountHref(): string {
  return "#/account";
}

/**
 * Hash href for a note's reader. `q` primes find-in-note and is
 * percent-encoded (a raw `#` would truncate the route).
 */
export function noteHref(id: string, q = ""): string {
  return notePageHref(id, 0, q);
}

/**
 * Hash href for a note at a 0-based `page` (written one-based) with optional
 * search. The first page and empty `q` collapse to the bare path, the one
 * canonical spelling; `/page/1` is accepted on input but never emitted.
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
 * Hash href for a retained version preview, `#/note/:id/version/:short`, with
 * the note route's page suffix. `short` is hex and needs no encoding.
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
 * {@link replaceNotePosition} for a version preview; guarded on `short` too so
 * a late page turn never overwrites another version's URL.
 */
export function replaceNoteVersionPosition(id: string, short: string, page: number): void {
  const now = current();
  if (now.name !== "note-version" || now.id !== id || now.short !== short) return;
  const target = noteVersionHref(id, short, page);
  if (path() === target.slice(1)) return;
  window.history.replaceState(window.history.state, "", target);
}

/** Hash href for a trashed file open in a viewer, as {@link notePageHref} without `q`. */
export function binNotePageHref(id: Id, page = 0): string {
  const index = Math.floor(page);
  return index > 0
    ? `#/bin/note/${encodeURIComponent(id)}/page/${index + 1}`
    : `#/bin/note/${encodeURIComponent(id)}`;
}

/** {@link replaceNotePosition} for a trashed file. */
export function replaceBinNotePosition(id: Id, page: number): void {
  const now = current();
  if (now.name !== "bin-note" || now.id !== id) return;
  const target = binNotePageHref(id, page);
  if (path() === target.slice(1)) return;
  window.history.replaceState(window.history.state, "", target);
}

/**
 * Rewrite the address bar to the reader's position and search without a
 * history entry. Only refines a route already for this note: the reader is an
 * overlay whose teardown races the route, and a late `showPage` must not write
 * a note URL over the library. No-op when unchanged.
 */
export function replaceNotePosition(id: string, page: number, q: string): void {
  const now = current();
  if (now.name !== "note" || now.id !== id) return;
  const target = notePageHref(id, page, q);
  if (path() === target.slice(1)) return;
  window.history.replaceState(window.history.state, "", target);
}

/**
 * Rewrite the address bar without a history entry or re-dispatch, for an
 * adjustment the caller already painted (the search box).
 */
export function replaceRoute(to: string): void {
  const target = to.replace(/^#/, "");
  if (path() === target) return;
  window.history.replaceState(window.history.state, "", `#${target}`);
}

/**
 * Correct the URL in place and render it. Replaces rather than pushes, so a
 * dead deep link or an empty `#/search` leaves no history rung to bounce off.
 */
export function redirect(to: string): void {
  replaceRoute(to);
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}

/** Navigate (a push). Re-fires even if unchanged so a re-entry still renders. */
export function go(to: string): void {
  const target = to.replace(/^#/, "");
  if (path() === target) {
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  } else {
    window.location.hash = target;
  }
}

/**
 * Registers a render callback fired once on load and on every hash change.
 * The initial dispatch is latched: `readyState` turns `"interactive"` just
 * before `DOMContentLoaded`. Async rejections are handled here, at the seam,
 * so no arm can leave a blank page; `onFailure` is required for that reason.
 */
export function onRoute(
  render: (route: Route) => void | Promise<void>,
  onFailure: (error: unknown, route: Route) => void,
): void {
  const run = () => {
    const route = current();
    try {
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
