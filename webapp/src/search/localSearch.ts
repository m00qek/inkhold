// The one shape a library-wide search result has. Every field is something
// the browser holds; nothing asks a server to have interpreted the query
// (§4.3: no excerpts), which is what leaves the server with no
// query-interpreting code.

/** One DOCUMENT that matched — not one page (§4.3: "matches on N pages"). */
export interface LocalHit {
  /** The content hash. The index's own identity for a document. */
  readonly md5: string;
  /** `files.id` — how a hit becomes a name and an openable thing. The terms
   *  records carry no names; the app already holds the listing. */
  readonly fileId: number;
  /** Every matching page ordinal, ascending. The reader deep-links to the first. */
  readonly pages: readonly number[];
  /** `files.updated_at`. The within-rank ordering when two documents tie. */
  readonly updatedAt: number;
}

/**
 * What the typo ladder substituted when the query as typed matched nothing.
 * The corpus is the device's own handwriting recognition, so it is MISSPELT
 * ("Danie Witches. Arch Interview" is a real row) and exact matching fails
 * even when the person types the word correctly. Empty whenever the exact
 * query answered — a FALLBACK, never a widening.
 */
export interface Expansion {
  /** The token as the person typed it. */
  readonly typed: string;
  /** The vocabulary term searched in its place. */
  readonly matched: string;
}

export interface LocalResults {
  /** Echoed back, so a late answer is discardable without a second piece of state. */
  readonly query: string;
  /** Total matching PAGES across every document — EXACT (§9.5 retired the
   *  server's "N+" floors; a client holding the index has already paid). */
  readonly totalPages: number;
  /** Ranked: most matching pages first, then most recently updated. */
  readonly documents: readonly LocalHit[];
  /** Non-empty only when the exact query found nothing and the ladder was
   *  used, so a view can say "matched **reunião**". */
  readonly expansions: readonly Expansion[];
}

/** What the search box calls. */
export interface LocalSearch {
  /**
   * Has an index to answer from. False before the first sync, or where
   * IndexedDB is unavailable. Nobody branches on it since step 6 removed the
   * fallback: a search against a not-ready engine RAISES, and the box paints
   * its error state rather than a confident "no matches".
   */
  readonly ready: boolean;
  search(query: string, signal?: AbortSignal): Promise<LocalResults>;
}

/** Rank: matching pages descending, then recency. The ONE ordering — §4.1
 *  folds ranking and the match count into the same number. */
export function rankDocuments(hits: readonly LocalHit[]): LocalHit[] {
  return hits.slice().sort((a, b) => b.pages.length - a.pages.length || b.updatedAt - a.updatedAt);
}
