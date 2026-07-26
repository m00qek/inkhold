// Resolving a `#/note/:id/version/:short` URL to a concrete version, client-side.
//
// A version link carries only a 7-hex-char md5 PREFIX (`:short`), not the full
// content hash — the `:id` already scopes it to that one file's handful of
// retained versions, so 7 hex chars (28 bits) disambiguate them with collision
// odds that round to zero (the git short-hash trick, on a far smaller set). The
// content endpoints still key on the FULL md5, so the prefix has to resolve to
// it: this module does that against the version list the history panel already
// fetches (`Api.noteHistory`), so no backend prefix-match route is needed.

import type { FileVersion } from "../core/types";

/**
 * How many leading hex chars of a version md5 a `/version/:short` URL carries.
 * Kept in one place so the URL writer (the reader's sync) and the reader that
 * shortens a full md5 agree.
 */
export const SHORT_LEN = 7;

/** The `:short` prefix a full version md5 is addressed by. Lower-cased so a
 *  hand-typed upper-case prefix still matches the hex the endpoints emit. */
export function shortMd5(md5: string): string {
  return md5.slice(0, SHORT_LEN).toLowerCase();
}

/**
 * The outcome of resolving a `:short` prefix against a file's version list:
 *  - `current` — the prefix names the LIVE blob (the list's `current` entry);
 *  - `past`    — it names a retained, immutable version;
 *  - `none`    — nothing matches (a bad prefix, or a version aged out of the hot
 *                cache), so the caller falls back to the live note + a notice.
 */
export type VersionMatch =
  | { kind: "current"; version: FileVersion }
  | { kind: "past"; version: FileVersion }
  | { kind: "none" };

/**
 * Resolve `short` against a file's `versions` (newest-first, the current blob
 * flagged — the shape `Api.noteHistory` returns).
 *
 * LIVE-FIRST BY CONSTRUCTION, and that ordering is load-bearing. The list
 * prepends the current version and is newest-first, so the FIRST `startsWith`
 * match wins: an ambiguous prefix resolves to the newest, and — crucially — a
 * RESTORE that made a past version's md5 the live one resolves as "current"
 * rather than 404ing, because that entry now sits at the front flagged current.
 */
export function resolveVersionShort(versions: FileVersion[], short: string): VersionMatch {
  const s = short.toLowerCase();
  const match = versions.find((v) => v.md5.toLowerCase().startsWith(s));
  if (!match) return { kind: "none" };
  return match.current ? { kind: "current", version: match } : { kind: "past", version: match };
}
