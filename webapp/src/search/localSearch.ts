// The library-wide search result shape. No excerpts, so the server never
// interprets a query.

/** One matching document, not one page. */
export interface LocalHit {
  readonly md5: string;
  /** `files.id`; terms records carry no names, the app holds the listing. */
  readonly fileId: number;
  /** Ascending; the reader deep-links to the first. */
  readonly pages: readonly number[];
  /** `files.updated_at`, the tie-break within a rank. */
  readonly updatedAt: number;
}

/**
 * What the typo ladder substituted. The corpus is device handwriting
 * recognition and often misspelt, so exact matching fails on correct input.
 * Empty whenever the exact query answered: a fallback, never a widening.
 */
export interface Expansion {
  readonly typed: string;
  readonly matched: string;
}

export interface LocalResults {
  /** Echoed so a late answer can be discarded. */
  readonly query: string;
  /** Exact total of matching pages across documents. */
  readonly totalPages: number;
  /** Most matching pages first, then most recent. */
  readonly documents: readonly LocalHit[];
  /** Non-empty only when the ladder answered, for "matched X". */
  readonly expansions: readonly Expansion[];
}

export interface LocalSearch {
  /**
   * False before the first sync or without IndexedDB. A search against a
   * not-ready engine throws, so the box shows an error, not "no matches".
   */
  readonly ready: boolean;
  search(query: string, signal?: AbortSignal): Promise<LocalResults>;
}

/** Pages descending, then recency: ranking and match count are one number. */
export function rankDocuments(hits: readonly LocalHit[]): LocalHit[] {
  return hits.slice().sort((a, b) => b.pages.length - a.pages.length || b.updatedAt - a.updatedAt);
}
