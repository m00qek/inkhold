// The one shape a library-wide search result has.
//
// It was born as a SEAM: §6 step 5 ran the local index beside a `searchText`
// fallback, and this shape is what let the UI stay ignorant of which of the two
// answered. Step 6 deleted the fallback, so there is one producer left and the
// shape is simply the index's answer — but it is still worth being the narrow
// thing it is. Every field here is something the browser holds; nothing in it
// asks a server to have interpreted the query (§4.3: excerpts are dropped, not
// deferred), which is what leaves the server with no query-interpreting code.

/** One DOCUMENT that matched — not one page. §4.3: a row says "matches on N
 * pages" and there are no excerpts, which is what leaves the server with no
 * query-interpreting code at all. */
export interface LocalHit {
  /** The content hash. The index's own identity for a document. */
  readonly md5: string;
  /** `files.id` — how a hit becomes a name and an openable thing. The manifest
   * carries it because the terms records deliberately do not: the app already
   * holds the listing, so shipping names in the index would be a second copy. */
  readonly fileId: number;
  /** Every matching page ordinal, ascending. The reader deep-links to the first;
   * the rest are what the count is counted from. */
  readonly pages: readonly number[];
  /** `files.updated_at`. The within-rank ordering a person expects when two
   * documents match equally well. */
  readonly updatedAt: number;
}

/**
 * What the typo ladder substituted when the query as typed matched nothing.
 *
 * The corpus is the device's own handwriting recognition, so it is MISSPELT --
 * "Danie Witches. Arch Interview" is a real row. Exact matching therefore fails
 * even when the person types the word correctly, which is a stronger case than
 * ordinary typo tolerance and the reason the ladder exists at all.
 *
 * §4.3 wants the row to be able to say "matched **reunião**", so what was typed
 * and what was searched both travel. Empty whenever the exact query answered --
 * expansion is a FALLBACK, never a widening.
 */
export interface Expansion {
  /** The token as the person typed it. */
  readonly typed: string;
  /** The vocabulary term searched in its place. */
  readonly matched: string;
}

export interface LocalResults {
  /** Echoed back, because a result that arrives after the box moved on must be
   * discardable by the caller without a second piece of state. */
  readonly query: string;
  /**
   * Total matching PAGES across every document — EXACT, and free.
   *
   * §9.5 of the old design retired the server's "N+" floors precisely because
   * they existed only to avoid paying for matches early termination had skipped.
   * A client holding the whole index has already paid, so there is no cursor, no
   * keyset walk and no "more results" to spend.
   */
  readonly totalPages: number;
  /** Ranked: most matching pages first, then most recently updated. */
  readonly documents: readonly LocalHit[];
  /** Non-empty only when the exact query found nothing and the ladder was used.
   * The typed token travels with the term substituted for it, so a view can say
   * "matched **reunião**" without re-deriving an expansion it did not run. */
  readonly expansions: readonly Expansion[];
}

/** What the search box calls. */
export interface LocalSearch {
  /**
   * Has an index to answer from. False before the first sync, or where
   * IndexedDB is unavailable.
   *
   * NOBODY BRANCHES ON IT ANY MORE, and that is the point of step 6: it used to
   * pick between this engine and a network fallback, and there is no second
   * engine to pick. It stays as the index's own honest self-report — a search
   * against a not-ready engine RAISES, and the box paints its error state
   * rather than a confident "no matches" or a quiet round trip.
   */
  readonly ready: boolean;
  search(query: string, signal?: AbortSignal): Promise<LocalResults>;
}

/** Rank: matching pages descending, then recency. Exported because it is the
 * ONE ordering — §4.1 folds ranking and the match count into the same number so
 * there is nothing to reflow into when anything else loads. */
export function rankDocuments(hits: readonly LocalHit[]): LocalHit[] {
  return hits.slice().sort((a, b) => b.pages.length - a.pages.length || b.updatedAt - a.updatedAt);
}
