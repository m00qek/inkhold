// The library-wide search result shape, and its order. Excerpts are cut in
// the browser (`excerpt.ts`), so the server never interprets a query.

import type { Tier } from "./manifestCodec";

/** One matching document, not one page. */
export interface LocalHit {
  readonly md5: string;
  /** `files.id`; terms records carry no names, the app holds the listing. */
  readonly fileId: number;
  /** Ascending; the reader deep-links to the first. */
  readonly pages: readonly number[];
  /** `files.updated_at`, the tie-break within a rank. */
  readonly updatedAt: number;
  /** The manifest's tier; null offline, where only the listing answers. */
  readonly tier: Tier | null;
  /** Pages (or `.txt` paragraphs) in the document; null when its terms are not held. */
  readonly pageCount: number | null;
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
  /**
   * Documents kept for a quoted phrase without being checked: their text is
   * not in the browser, so whether the words sit together is not known.
   */
  readonly unchecked?: number;
}

export interface LocalSearch {
  /**
   * False before the first sync or without IndexedDB. A search against a
   * not-ready engine throws, so the box shows an error, not "no matches".
   */
  readonly ready: boolean;
  search(query: string, signal?: AbortSignal): Promise<LocalResults>;
}

/**
 * What the person wrote counts in full: their notes. A document they wrote on
 * (`.mark`) counts a little less: the pen marks are not searchable, only the
 * printed words, but writing on it says they worked with it. Anything else (a
 * PDF or `.txt` as it came) counts less again. A weight, not an order: a
 * document about the words still beats a note that mentions them once.
 * Unknown (offline) is not penalised.
 */
export function tierWeight(tier: Tier | null): number {
  if (tier === "other") return 0.6;
  if (tier === "marked") return 0.8;
  return 1;
}

/**
 * How much of the document is about the query: matching pages over its size,
 * plus two, so a one-page match is likely but not certain to win. Without the
 * size, the matches alone stand in for it.
 */
export function density(hit: Pick<LocalHit, "pages" | "pageCount">): number {
  const size = Math.max(hit.pageCount ?? hit.pages.length, hit.pages.length);
  return hit.pages.length / (size + 2);
}

export function relevance(hit: LocalHit): number {
  return tierWeight(hit.tier) * density(hit);
}

/** Most relevant first (`relevance`), then most recent. */
export function rankDocuments(hits: readonly LocalHit[]): LocalHit[] {
  return hits.slice().sort((a, b) => relevance(b) - relevance(a) || b.updatedAt - a.updatedAt);
}
