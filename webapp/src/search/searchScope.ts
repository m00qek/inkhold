// What this browser's search reads the text of. Notebooks always: only
// Inkhold can search their handwriting, and the person wrote them. Each other
// kind is a switch, given by the app (`ui/searchScope.ts` keeps it); the
// search layer only filters manifest rows by it, and reads no storage.
//
// One kind for now: documents, every row that isn't a notebook (PDFs, XPS
// documents, text files, annotated ones included), told apart by the row's
// tier alone. Another kind joins `SCOPE_KINDS` as one more entry.

import type { ManifestRow } from "./manifestCodec";

/** The kinds a person can leave out of search, in the order the setting lists them. */
export const SCOPE_KINDS = ["documents"] as const;
export type ScopeKind = (typeof SCOPE_KINDS)[number];

/** Whether each kind's text is searched. */
export type SearchScope = Readonly<Record<ScopeKind, boolean>>;

/** Everything searched: the default, and what a missing setting means. */
export const FULL_SCOPE: SearchScope = { documents: true };

/** The kind a row belongs to, or null for a notebook, which is always searched. */
export function scopeKindOf(row: Pick<ManifestRow, "tier">): ScopeKind | null {
  return row.tier === "note" ? null : "documents";
}

/** Pure. Whether the row's text is searched under `scope`. */
export function inScope(scope: SearchScope, row: Pick<ManifestRow, "tier">): boolean {
  const kind = scopeKindOf(row);
  return kind === null || scope[kind];
}

/** Pure. Whether two scopes search the same kinds. */
export function sameScope(a: SearchScope, b: SearchScope): boolean {
  return SCOPE_KINDS.every((kind) => a[kind] === b[kind]);
}
