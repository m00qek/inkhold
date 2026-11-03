// Resolves a `#/note/:id/version/:short` URL (a 7-hex md5 prefix, scoped by
// `:id`) to the full version md5, against the list `Api.noteHistory` returns.

import type { FileVersion } from "../core/types";

/** Hex chars of a version md5 carried in a `/version/:short` URL. */
export const SHORT_LEN = 7;

/** Lower-cased so a hand-typed upper-case prefix still matches. */
export function shortMd5(md5: string): string {
  return md5.slice(0, SHORT_LEN).toLowerCase();
}

export type VersionMatch =
  | { kind: "current"; version: FileVersion }
  | { kind: "past"; version: FileVersion }
  | { kind: "none" };

/**
* The first match wins over the newest-first, current-prepended list, so an
* ambiguous prefix picks the newest and a restored md5 resolves as "current".
*/
export function resolveVersionShort(versions: FileVersion[], short: string): VersionMatch {
  const s = short.toLowerCase();
  const match = versions.find((v) => v.md5.toLowerCase().startsWith(s));
  if (!match) return { kind: "none" };
  return match.current ? { kind: "current", version: match } : { kind: "past", version: match };
}
