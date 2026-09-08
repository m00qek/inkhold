// IN-DOCUMENT SEARCH, on the same engine as the library — `golden-search.md`
// §1.1, and the point of the whole design rather than a consequence of it.
//
//     text/<md5> ──build──▶ SearchIndex ──idx_query──▶ ordinals
//                                                 └──▶ expansions (the typo ladder)
//
// Global search queries the terms index; in-document search queries ONE
// document's real text loaded into the same wasm FTS5 instance, through the same
// `idx_query` fold. What used to be five server routes and three response shapes
// is one route and one shape, and format differences stop being code: a
// segment's ordinal and its address are FIELDS on a record, not a branch.
//
// What this does NOT unify is highlight geometry (§1.1, stated so it is not
// discovered later). Note word ovals come from the recognition block, PDF boxes
// from `ink_page_words`, `.txt` from byte offsets. One search path, three
// highlight adapters — `findInNote.ts`, `txtFind.ts`, `pdfFind.ts` — and this
// module answers all three with the same record.
//
// ## The text is fetched on FIRST FIND, never on open
//
// §4.1. Opening a document to READ it needs the renderer, not a text index, and
// nobody should pay for a table they never query. So nothing here is touched
// until somebody types into a find bar — the same rule `indexSearch.ts` holds for
// the library index, for the same 16.13 MB reason.
//
// ## …and it is a WORKER's instance, not this thread's
//
// §7 called the 315 ms first-find build "the one thing on this list a household
// would actually feel", and it was on the main thread. It is not any more:
// `searchEngine.ts` holds it behind a worker wherever a `Worker` exists, and
// falls back to this thread where one does not. Nothing about the shape below
// changed — `DocSearch.search` was already `Promise`-returning and every caller
// already awaited it, which is what made the move an internal one.
//
// ## Its own wasm instance, and that is a decision with a number behind it
//
// (And "its own instance" is now also its own WORKER, which is the same decision
// read once more: the library's build must not queue in front of a find.)
//
// §8.1's measured lifecycle shares ONE instance between the library index and the
// in-document one, restoring the library from its serialized image afterwards
// (2.31 ms, no growth). That lifecycle needs a stored image to restore FROM, and
// this build does not persist one — `indexSearch.ts` rebuilds from the rows in
// IndexedDB, which is 703 ms for the whole library. So sharing the instance would
// charge every find 703 ms on the next library search, against 16.13 MB of linear
// memory for a second one. The second instance wins, and it is bounded: the worst
// real document (Les Misérables, 14,055 segments, 3.15 MB) lands at 33.25 MB
// standalone.
//
// ## …and ONE instance for every document, reused
//
// §8.1 refuted the teardown rule: `idx_open()` returns the closed database's
// pages to SQLite's heap INSIDE linear memory, so four documents through one
// instance converge on the cost of the single worst one whichever order they
// arrive in (33.63–33.69 MB either way). Documents do not stack, so opening the
// next one is `reset()` and not a new instance.
//
// ## MEMBERSHIP is the engine's; the MARKS are named from the text
//
// `idx_query` says which segments matched, and nothing here second-guesses it —
// the AND across tokens, the prefix `*` on the last one and the typo ladder's
// OR-groups are all FTS5's, folded by the index's own tokenizer.
//
// What the engine does NOT return is which words to mark and how many there are:
// `idx_hit` hands back rowids. The server used to compute that beside its count;
// now the client holds the segment's real text, so it names them here — a fold
// and an equality test over the words of a segment the engine already matched.
// That is the same computation the three adapters have always run against a word
// LABEL (`matchWords` in `findInNote.ts` and `pdfFind.ts`, `markParagraph` in
// `txtFind.ts`); it has simply moved to where the text is.
//
// The one-way authority survives intact and pointing the same way: a segment the
// engine matched but this pass can name nothing in STAYS A MATCH (see
// {@link countMarks}), and a segment the engine did not match is never added
// because a word in it happens to fold to a query term.

import type { CoreLoader, TermsDocument } from "./indexEngine";
import { createSearchEngine, type SearchEngine } from "./searchEngine";
import { httpTextTransport, type DocumentText, type TextTransport } from "./docText";
import { openTextStore, type TextStore } from "../cache/textStore";
import type { Expansion } from "./localSearch";

export { DocumentTextUnavailable } from "./docText";

/**
 * The segment cap handed to `idx_query`, which is to say none — the same
 * reasoning as `indexSearch.ts`'s: the limit does not bound the scan (the exact
 * total is produced whatever it is), it only decides how many rowids are kept,
 * and a find that dropped segments off the end would step through a shorter set
 * than its own counter claims.
 */
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
  /**
   * The query as typed matched nothing and the ladder answered instead. The wasm
   * gates this itself (`idx_fuzzy` corrects only a query that matched NOTHING),
   * so it is never a widening, and the viewers hold the result behind their
   * opt-in exactly as they held the server's.
   */
  readonly usedFuzzy: boolean;
  /** What the ladder substituted. Empty unless {@link usedFuzzy}. */
  readonly expansions: readonly Expansion[];
}

export interface DocSearch {
  /**
   * Search one document. Fetches and indexes it on the first call for that md5;
   * later calls reuse the built index, which is what makes searching-as-you-type
   * affordable (the worst real document costs 363 ms to build and 11.5 ms to
   * query — §8.1).
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
   * The PREFETCHED text cache (§4.4) — `.note`, and anything with a `.mark` that
   * fits the budget. Read here and never written: what belongs in it is
   * `textPrefetch.ts`'s decision, and a store that filled itself from browsing
   * would be a byte budget over the bytes the HTTP cache is already keeping for
   * free.
   *
   * A miss, an unavailable IndexedDB, a version that moved — all three land on
   * the same line below, which is the fetch this module has always done. The
   * store saves that fetch on the documents most likely to be searched; it is
   * never a source of truth and it promises nothing.
   */
  store?: TextStore;
  /** How an engine instance is obtained. Injectable so tests need no wasm. */
  load?: CoreLoader;
  /**
   * One document's `index_version` — the half of `text/<md5>`'s cache key the
   * path cannot carry, sent as `?v=` (see `docText.ts`'s header). Supplied by the
   * shell from the manifest the library sync already holds; this module knows
   * only that something can answer the question.
   *
   * It is also HALF THE IDENTITY OF THE BUILT INDEX below: a version bump
   * re-derives the same md5 into different text, so an index keyed on md5 alone
   * would keep answering from the old one for the rest of the session.
   */
  indexVersion?: (md5: string) => number | null;
}

/**
 * Case- and accent-insensitive form.
 *
 * The SAME fold `unicode61 remove_diacritics 2` applies to the index, and
 * byte-for-byte the one `findInNote.ts`, `txtFind.ts` and `pdfFind.ts` apply to a
 * word before comparing it with a term. The household writes Portuguese, so
 * `avaliação` typed as `avaliacao` has to mark the word it means.
 *
 * IT NEVER DECIDES A MATCH. Membership is FTS5's, through the wasm's own
 * tokenizer; this only names, among the words of a segment the engine ALREADY
 * matched, which ones to point at. So a divergence here costs a mark, never a
 * result — which is exactly the failure the three adapters already tolerate.
 */
export function fold(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

/** Word runs, as `unicode61` splits them: everything that is not a letter or a
 *  digit is a boundary, so `page-range` is two words. */
const WORD_RE = /[\p{L}\p{N}]+/gu;

/**
 * What the marks look for, derived from the SAME string handed to `idx_query`.
 *
 * `exact` holds every term the expression searched for as a whole word; `prefix`
 * holds the one term the expression prefix-matched, or null.
 */
export interface MarkPlan {
  readonly exact: ReadonlySet<string>;
  readonly prefix: string | null;
}

/**
 * Build the plan from the query and whatever the ladder substituted.
 *
 * It mirrors `sqlite_core.zig`'s `buildMatch`, and the three rules it mirrors are
 * the three that would otherwise silently stop marking:
 *
 *   1. **Only the LAST term gets a `*`, and only when the query does not end in
 *      whitespace.** A trailing space is the user saying they finished the word.
 *      Every caller here trims first, so in practice the last term is always
 *      prefixed — the rule is spelt out anyway so the two cannot drift.
 *   2. **A token that folds to nothing contributes nothing** and is not an error.
 *   3. **An expanded token keeps its own form as well as its alternatives.** The
 *      fuzzy expression is `("caligrafa"* OR "caligrafia")`, not a replacement,
 *      so both are marked.
 *
 * Vocabulary terms from the ladder are matched EXACTLY: they are already folded
 * index terms, and prefix-matching a correction would widen a fallback that the
 * wasm is careful to keep from widening.
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
  // The `*` lands on the last term of the last token that produced any — that is
  // where `buildMatch` appends it, after the whole expression is assembled.
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
 * `matches` FLOORS AT 1 for a segment the engine matched, and that floor is the
 * honesty rule as arithmetic. FTS5 decided this segment matches; if this pass
 * names nothing in it — a term the two tokenizers split differently, a ligature,
 * a word broken across a line — then reporting 0 would subtract the segment from
 * the counter while the adapters still step to it, and a document that plainly
 * contains the word would read "No matches". A segment with nothing to mark is a
 * match with nothing drawn, which is what `pdfFind.ts`'s header already promises.
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

/** An aborted search, spelled the way `fetch` spells it so one `catch` reads
 *  both — the shape `indexSearch.ts` uses, for the same reason. */
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
  /**
   * What is currently BUILT into `index`, not merely fetched — `md5@version`,
   * because a version bump is the same md5 with different text, and an index
   * keyed on the md5 alone would answer from the old one for the rest of the
   * session.
   */
  let loaded: string | null = null;
  /** The in-flight load, so a burst of keystrokes on a cold document is one
   *  fetch and one build rather than one per keystroke. */
  let loading: { key: string; done: Promise<SearchEngine> } | null = null;
  /** The loaded document's segments by ordinal — where `o`/`l` and the text to
   *  mark come from once the engine has answered with a bare ordinal. */
  let byOrdinal = new Map<number, DocumentText["segments"][number]>();

  /**
   * The stored copy first, the network second — and the version is what makes
   * the first one safe. `store.get` is keyed on `(md5, indexVersion)`, so a
   * document whose version moved MISSES rather than answering out of text an
   * older extractor produced; a session with no version at all (never synced)
   * skips the store entirely, because a record filed under a guessed version is
   * the same lie in the other direction.
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
    // Reused rather than re-opened: §8.1 measured that successive documents
    // through one instance converge on the cost of the worst one. That is what
    // `SearchEngine.build` is — `reset()` then `build()` on the instance the
    // worker already holds — and it is why there is no worker per document.
    const engine = index ?? createSearchEngine({ load });
    index = engine;
    // A rebuild that throws must not leave the previous document's `byOrdinal`
    // beside a half-built table — `SearchIndex.build` resets on failure, so the
    // index is empty, and the map has to say so too.
    loaded = null;
    byOrdinal = new Map();
    const doc: TermsDocument = { md5, pages: text.segments.map((s) => ({ p: s.p, t: s.t })) };
    // ~6 ms of main-thread block to clone the worst document's 14,055 segments
    // across the boundary (MEASURED in Chromium — `engineWorker.ts` has the
    // table), against the whole build it takes off this thread.
    try {
      await engine.build([doc]);
    } catch (err) {
      // A failed build leaves an EMPTY index (`SearchIndex.build` resets), and a
      // worker that DIED leaves one that can never answer again. Neither is
      // worth keeping: dropping it costs one re-instantiation on a path that is
      // already an error, and it is what makes a dead worker a failed find
      // rather than a find bar that is broken for the rest of the session.
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
    // A second caller joins the load in flight for the SAME document; a different
    // document supersedes it, because a build is not abortable and the one
    // already running is about to be thrown away by `reset()` anyway.
    //
    // THE JOINED LOAD CARRIES THE FIRST CALLER'S SIGNAL, which is safe because of
    // how the callers are shaped and not by luck: exactly one viewer is on screen
    // at a time, and each find bar debounces and calls `cancelPending` — which
    // aborts and bumps its token — BEFORE issuing the next query. So a joiner
    // never arrives while an abandoned load is still pending. If a second
    // concurrent consumer of this module ever appears, the fetch has to stop
    // being tied to one caller's signal, because an abort by A would fail B.
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
      // The build is not abortable and should not be — it is the same work the
      // next keystroke needs. What a superseded search must not do is PAINT.
      if (signal?.aborted) throw abortError();
      // Asked WITH the ladder, which the wasm runs only when the query as typed
      // matched nothing. THIS IS THE REGRESSION STEP 6 OPENED CLOSING: the
      // server's in-document routes never ran their fuzzy fallback, and the
      // corpus is the device's own handwriting recognition, so exact matching
      // fails even when the person spells the word correctly.
      //
      // The SIGNAL travels with it now that the query is a message rather than a
      // call: a superseded keystroke rejects here rather than waiting out the
      // 71.3 ms whole-vocabulary scan a no-match query costs (§8.6), and the
      // query behind it is posted at once.
      const answer = await engine.query(query, ALL_SEGMENTS, true, signal);
      const plan = planMarks(query, answer.expansions);
      const segments: DocSegmentMatch[] = [];
      for (const hit of answer.hits) {
        // The index holds exactly one document, so a hit for another md5 would
        // mean the engine and this map have come apart.
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
