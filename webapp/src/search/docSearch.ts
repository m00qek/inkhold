// IN-DOCUMENT SEARCH on the same engine as the library — `golden-search.md`
// §1.1. One document's real text (`docText.ts`) goes into a wasm FTS5 instance
// through the same `idx_query` fold; the three highlight adapters
// (`findInNote.ts`, `txtFind.ts`, `pdfFind.ts`) read the one record shape here.
//
// What this must not break:
//   * Nothing is fetched or built until the first FIND (§4.1), and never on open.
//   * Its OWN engine, not the library's (§8.1): sharing would charge every find
//     a 703 ms library rebuild afterwards, against 16.13 MB for a second
//     instance — bounded, since the worst real document (14,055 segments,
//     3.15 MB) lands at 33.25 MB standalone. One instance for every document,
//     reused: `idx_open()` returns pages to SQLite's heap inside linear memory,
//     so documents converge on the worst one rather than stacking.
//   * MEMBERSHIP is the engine's; only the MARKS are named from the text. A
//     segment the engine matched but this pass can name nothing in STAYS A
//     MATCH ({@link countMarks}), and one it did not match is never added.

import type { CoreLoader, TermsDocument } from "./indexEngine";
import { createSearchEngine, type SearchEngine } from "./searchEngine";
import { httpTextTransport, type DocumentText, type TextTransport } from "./docText";
import { openTextStore, type TextStore } from "../cache/textStore";
import type { Expansion } from "./localSearch";

export { DocumentTextUnavailable } from "./docText";

/** No segment cap — `indexSearch.ts`'s reasoning: the limit does not bound the
 *  scan, and a find that dropped segments off the end would step through a
 *  shorter set than its own counter claims. */
const ALL_SEGMENTS = 0xffffffff;

/** One matching segment, in the shape all three highlight adapters read. */
export interface DocSegmentMatch {
  /** The ordinal: a `.note` page, a PDF page, a `.txt` paragraph. */
  readonly segment: number;
  /** The `.txt` byte offset in the raw blob; `null` where the ordinal is the
   *  address. `txtFind.ts`'s `byteToCharMap` is what consumes it. */
  readonly offset: number | null;
  readonly length: number | null;
  /** Matching word instances in this segment. At least 1 — see {@link countMarks}. */
  readonly matches: number;
  /** The folded words to mark, as they appear in this segment's text. An
   *  adapter marks a word exactly when its own fold is in here. */
  readonly terms: readonly string[];
}

export interface DocSearchResult {
  /** Echoed, so a late answer is discardable without a second piece of state. */
  readonly query: string;
  readonly md5: string;
  /** Matching segments in ORDINAL order — not bm25 order. Every adapter steps
   *  prev/next through the document, so "first" has to mean first in the
   *  document. */
  readonly segments: readonly DocSegmentMatch[];
  /** The query as typed matched nothing and the ladder answered instead. The
   *  wasm gates this itself, so it is never a widening. */
  readonly usedFuzzy: boolean;
  /** What the ladder substituted. Empty unless {@link usedFuzzy}. */
  readonly expansions: readonly Expansion[];
}

export interface DocSearch {
  /**
   * Search one document. Fetches and indexes it on the first call for that
   * md5; later calls reuse the built index (the worst real document costs
   * 363 ms to build and 11.5 ms to query — §8.1).
   *
   * @throws DocumentTextUnavailable when the route 404s — not derived, or not
   * reachable, deliberately indistinguishable. NOT an empty result.
   */
  search(md5: string, query: string, signal?: AbortSignal): Promise<DocSearchResult>;
  /** Hand the instance back. Dropping an index means dropping the INSTANCE —
   *  wasm linear memory never shrinks (§4.2). */
  drop(): void;
}

export interface DocSearchOptions {
  /** How the text record is fetched. Injectable so tests need no network. */
  transport?: TextTransport;
  /**
   * The PREFETCHED text cache (§4.4). Read here and never written: what
   * belongs in it is `textPrefetch.ts`'s decision, and a store that filled
   * itself from browsing would be a byte budget over bytes the HTTP cache is
   * already keeping for free. A miss of any kind lands on the fetch.
   */
  store?: TextStore;
  /** How an engine instance is obtained. Injectable so tests need no wasm. */
  load?: CoreLoader;
  /**
   * One document's `index_version` — the half of `text/<md5>`'s cache key the
   * path cannot carry, sent as `?v=` (`docText.ts`). Also HALF THE IDENTITY OF
   * THE BUILT INDEX: a version bump re-derives the same md5 into different
   * text, so an index keyed on md5 alone would keep answering from the old one
   * for the rest of the session.
   */
  indexVersion?: (md5: string) => number | null;
}

/**
 * Case- and accent-insensitive form — the SAME fold `unicode61
 * remove_diacritics 2` applies to the index, and byte-for-byte the one the
 * three adapters apply to a word before comparing it with a term (`avaliacao`
 * has to mark `avaliação`).
 *
 * IT NEVER DECIDES A MATCH. Membership is FTS5's; this only names, among the
 * words of a segment the engine ALREADY matched, which ones to point at. So a
 * divergence here costs a mark, never a result.
 */
export function fold(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

/** Word runs as `unicode61` splits them: anything not a letter or digit is a
 *  boundary, so `page-range` is two words. */
const WORD_RE = /[\p{L}\p{N}]+/gu;

/**
 * What the marks look for, derived from the SAME string handed to `idx_query`.
 * `exact` holds every term searched as a whole word; `prefix` the one term
 * prefix-matched, or null.
 */
export interface MarkPlan {
  readonly exact: ReadonlySet<string>;
  readonly prefix: string | null;
}

/**
 * Build the plan from the query and whatever the ladder substituted. Mirrors
 * `sqlite_core.zig`'s `buildMatch`; the three rules that would otherwise
 * silently stop marking:
 *
 *   1. Only the LAST term gets a `*`, and only when the query does not end in
 *      whitespace (a trailing space is the user saying they finished the word).
 *   2. A token that folds to nothing contributes nothing and is not an error.
 *   3. An expanded token keeps its own form as well as its alternatives: the
 *      fuzzy expression is `("caligrafa"* OR "caligrafia")`, not a replacement.
 *
 * Ladder terms are matched EXACTLY: they are already folded index terms, and
 * prefix-matching a correction would widen a fallback the wasm keeps narrow.
 */
export function planMarks(query: string, expansions: readonly Expansion[] = []): MarkPlan {
  const alts = new Map<string, string[]>();
  for (const e of expansions) {
    const held = alts.get(e.typed);
    if (held) held.push(e.matched);
    else alts.set(e.typed, [e.matched]);
  }

  const exact = new Set<string>();
  // The terms of each whitespace token, in order, so the last one can be found.
  const perToken: string[][] = [];
  for (const raw of query.split(/\s+/)) {
    if (raw === "") continue;
    const terms = fold(raw).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    perToken.push(terms);
    for (const alt of alts.get(raw) ?? []) exact.add(alt);
  }

  const openEnded = query.length > 0 && !/\s/.test(query[query.length - 1]!);
  // The `*` lands on the last term of the last token that produced any — where
  // `buildMatch` appends it, after the whole expression is assembled.
  let prefix: string | null = null;
  for (let i = perToken.length - 1; openEnded && i >= 0 && prefix === null; i--) {
    const terms = perToken[i]!;
    if (terms.length > 0) prefix = terms[terms.length - 1]!;
  }

  for (const terms of perToken) for (const t of terms) if (t !== prefix) exact.add(t);
  return { exact, prefix };
}

/**
 * The words of one segment to mark, and how many instances there are.
 *
 * `matches` FLOORS AT 1: FTS5 decided this segment matches, and if this pass
 * names nothing in it (a term the two tokenizers split differently, a
 * ligature, a word broken across a line) then 0 would subtract the segment
 * from the counter while the adapters still step to it, and a document that
 * plainly contains the word would read "No matches".
 */
export function countMarks(text: string, plan: MarkPlan): { terms: string[]; matches: number } {
  const terms = new Set<string>();
  let matches = 0;
  WORD_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = WORD_RE.exec(text)) !== null) {
    const w = fold(m[0]);
    if (!plan.exact.has(w) && !(plan.prefix !== null && w.startsWith(plan.prefix))) continue;
    terms.add(w);
    matches++;
  }
  return { terms: [...terms], matches: Math.max(matches, 1) };
}

/** Spelled the way `fetch` spells an abort so one `catch` reads both. */
function abortError(): Error {
  if (typeof DOMException === "function") return new DOMException("search aborted", "AbortError");
  const err = new Error("search aborted");
  err.name = "AbortError";
  return err;
}

export function createDocSearch(opts: DocSearchOptions = {}): DocSearch {
  const transport = opts.transport ?? httpTextTransport();
  const store = opts.store ?? openTextStore();
  const load = opts.load;
  const versionOf = opts.indexVersion ?? ((): number | null => null);

  let index: SearchEngine | null = null;
  /** What is BUILT into `index` — `md5@version`, see `indexVersion` above. */
  let loaded: string | null = null;
  /** The in-flight load, so a burst of keystrokes on a cold document is one
   *  fetch and one build rather than one per keystroke. */
  let loading: { key: string; done: Promise<SearchEngine> } | null = null;
  /** The loaded document's segments by ordinal — where `o`/`l` and the text to
   *  mark come from once the engine has answered with a bare ordinal. */
  let byOrdinal = new Map<number, DocumentText["segments"][number]>();

  /**
   * The stored copy first, the network second. `store.get` is keyed on
   * `(md5, indexVersion)`, so a document whose version moved MISSES rather
   * than answering from an older extractor's text; a session with no version
   * skips the store, because a record filed under a guessed version is the
   * same lie in the other direction.
   */
  async function fetchText(md5: string, version: number | null, signal?: AbortSignal): Promise<DocumentText> {
    if (version !== null) {
      const held = await store.get(md5, version);
      if (held) return held;
    }
    return transport(md5, version, signal);
  }

  async function load1(md5: string, key: string, version: number | null, signal?: AbortSignal): Promise<SearchEngine> {
    const text = await fetchText(md5, version, signal);
    // Reused, not re-opened (see the header) — hence no worker per document.
    const engine = index ?? createSearchEngine({ load });
    index = engine;
    // A rebuild that throws must not leave the previous document's `byOrdinal`
    // beside an empty table.
    loaded = null;
    byOrdinal = new Map();
    const doc: TermsDocument = { md5, pages: text.segments.map((s) => ({ p: s.p, t: s.t })) };
    // ~6 ms of main-thread block to clone the worst document's 14,055 segments
    // across the boundary (measured in Chromium), against the whole build.
    try {
      await engine.build([doc]);
    } catch (err) {
      // A failed build leaves an EMPTY index and a dead worker leaves one that
      // can never answer; dropping either makes this a failed find rather than
      // a find bar broken for the rest of the session.
      index = null;
      engine.close();
      throw err;
    }
    for (const s of text.segments) byOrdinal.set(s.p, s);
    loaded = key;
    return engine;
  }

  function ready(md5: string, key: string, version: number | null, signal?: AbortSignal): Promise<SearchEngine> {
    if (index && loaded === key) return Promise.resolve(index);
    // A second caller joins the load in flight for the SAME document; a
    // different document supersedes it (a build is not abortable, and the one
    // running is about to be thrown away by `reset()` anyway).
    //
    // THE JOINED LOAD CARRIES THE FIRST CALLER'S SIGNAL. Safe today because
    // exactly one viewer is on screen and each find bar calls `cancelPending`
    // (abort + token bump) BEFORE its next query, so a joiner never arrives
    // while an abandoned load is pending. A second concurrent consumer of this
    // module would break that: an abort by A would fail B.
    if (loading && loading.key === key) return loading.done;
    const p = load1(md5, key, version, signal).finally(() => {
      if (loading?.done === p) loading = null;
    });
    loading = { key, done: p };
    return p;
  }

  return {
    async search(md5, query, signal): Promise<DocSearchResult> {
      const version = versionOf(md5);
      const engine = await ready(md5, `${md5}@${version ?? "?"}`, version, signal);
      // The build is not abortable; what a superseded search must not do is PAINT.
      if (signal?.aborted) throw abortError();
      // Asked WITH the ladder (the wasm runs it only on a no-match). The
      // server's in-document routes never ran their fuzzy fallback, and the
      // corpus is handwriting recognition, so exact matching fails even on a
      // correctly spelled word. The signal travels with it so a superseded
      // keystroke rejects instead of waiting out the 71.3 ms scan (§8.6).
      const answer = await engine.query(query, ALL_SEGMENTS, true, signal);
      const plan = planMarks(query, answer.expansions);
      const segments: DocSegmentMatch[] = [];
      for (const hit of answer.hits) {
        // One document in the index: a hit for another md5 means the engine
        // and this map have come apart.
        const seg = hit.md5 === md5 ? byOrdinal.get(hit.page) : undefined;
        if (!seg) continue;
        const { terms, matches } = countMarks(seg.t, plan);
        segments.push({ segment: seg.p, offset: seg.o, length: seg.l, matches, terms });
      }
      // bm25 order in, ordinal order out: prev/next steps through the document.
      segments.sort((a, b) => a.segment - b.segment);
      return {
        query,
        md5,
        segments,
        usedFuzzy: answer.expansions.length > 0,
        expansions: answer.expansions,
      };
    },

    drop() {
      index?.close();
      index = null;
      loaded = null;
      loading = null;
      byOrdinal = new Map();
    },
  };
}
