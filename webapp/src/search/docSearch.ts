// In-document search on the library's engine: one document's text goes into
// its own wasm FTS5 instance, built lazily on the first find. The engine
// decides membership; this file only names the words to mark.

import type { CoreLoader, TermsDocument } from "./indexEngine";
import { createSearchEngine, type SearchEngine } from "./searchEngine";
import { httpTextTransport, type DocumentText, type TextTransport } from "./docText";
import { words } from "./fold";
import { holdsAll, phrasesOf, withExpansions } from "./phrase";
import { openTextStore, type TextStore } from "../cache/textStore";
import type { Expansion } from "./localSearch";

export { DocumentTextUnavailable } from "./docText";

/** No cap: a find that dropped segments would step through fewer than its counter claims. */
const ALL_SEGMENTS = 0xffffffff;

/** One matching segment, in the shape all three highlight adapters read. */
export interface DocSegmentMatch {
  readonly segment: number;
  /** `.txt` byte offset in the raw blob; `null` where the ordinal is the address. */
  readonly offset: number | null;
  readonly length: number | null;
  /** At least 1; see {@link countMarks}. */
  readonly matches: number;
  /** Folded words to mark; an adapter marks a word when its own fold is here. */
  readonly terms: readonly string[];
}

export interface DocSearchResult {
  /** Echoed so a late answer can be discarded. */
  readonly query: string;
  readonly md5: string;
  /** Ordinal order, not bm25: prev/next steps through the document. */
  readonly segments: readonly DocSegmentMatch[];
  /** The exact query matched nothing and the typo ladder answered. */
  readonly usedFuzzy: boolean;
  readonly expansions: readonly Expansion[];
}

export interface DocSearch {
  /**
   * Fetches and indexes the document on the first call for that md5.
   * @throws DocumentTextUnavailable when the route 404s (not derived and
   * unreachable look the same). Not an empty result.
   */
  search(md5: string, query: string, signal?: AbortSignal): Promise<DocSearchResult>;
  /** Drops the wasm instance; linear memory never shrinks otherwise. */
  drop(): void;
}

export interface DocSearchOptions {
  transport?: TextTransport;
  /** The prefetched text cache. Read only: `textPrefetch.ts` decides what goes in. */
  store?: TextStore;
  load?: CoreLoader;
  /**
   * A document's `index_version`. Part of the built index's identity: a bump
   * re-derives the same md5 into different text.
   */
  indexVersion?: (md5: string) => number | null;
}

/** What to mark, derived from the same string handed to `idx_query`. */
export interface MarkPlan {
  readonly exact: ReadonlySet<string>;
  readonly prefix: string | null;
}

/**
 * Mirrors `sqlite_core.zig`'s `buildMatch`: only the last term gets a `*`, and
 * only without trailing whitespace; a token folding to nothing contributes
 * nothing; an expanded token keeps its own form beside its alternatives.
 * Ladder terms are matched exactly, never as prefixes.
 */
export function planMarks(query: string, expansions: readonly Expansion[] = []): MarkPlan {
  const alts = new Map<string, string[]>();
  for (const e of expansions) {
    const held = alts.get(e.typed);
    if (held) held.push(e.matched);
    else alts.set(e.typed, [e.matched]);
  }

  const exact = new Set<string>();
  const perToken: string[][] = [];
  for (const raw of query.split(/\s+/)) {
    if (raw === "") continue;
    const terms = words(raw);
    perToken.push(terms);
    for (const alt of alts.get(raw) ?? []) exact.add(alt);
  }

  const openEnded = query.length > 0 && !/\s/.test(query[query.length - 1]!);
  // The `*` lands on the last term of the last token that produced any.
  let prefix: string | null = null;
  for (let i = perToken.length - 1; openEnded && i >= 0 && prefix === null; i--) {
    const terms = perToken[i]!;
    if (terms.length > 0) prefix = terms[terms.length - 1]!;
  }

  for (const terms of perToken) for (const t of terms) if (t !== prefix) exact.add(t);
  return { exact, prefix };
}

/**
 * The words of one segment to mark, and how many. `matches` floors at 1: FTS5
 * matched the segment even when this pass names nothing in it (tokenizer
 * differences, ligatures, line-broken words), and 0 would drop it from the count.
 */
export function countMarks(text: string, plan: MarkPlan): { terms: string[]; matches: number } {
  const terms = new Set<string>();
  let matches = 0;
  for (const w of words(text)) {
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
  /** `md5@version` built into `index`. */
  let loaded: string | null = null;
  /** In flight, so a burst of keystrokes on a cold document is one fetch and build. */
  let loading: { key: string; done: Promise<SearchEngine> } | null = null;
  let byOrdinal = new Map<number, DocumentText["segments"][number]>();

  /**
   * Stored copy first, keyed on `(md5, indexVersion)` so a moved version misses.
   * With no version the store is skipped rather than guessed.
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
  // One instance reused for every document; `reset()` returns its heap.
    const engine = index ?? createSearchEngine({ load });
    index = engine;
  // A throwing rebuild must not leave the old `byOrdinal` beside an empty table.
    loaded = null;
    byOrdinal = new Map();
    const doc: TermsDocument = { md5, pages: text.segments.map((s) => ({ p: s.p, t: s.t })) };
    try {
      await engine.build([doc]);
    } catch (err) {
      // Drop a failed or dead engine so the next find starts fresh.
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
    // Join the load in flight for the same document; a different one supersedes it.
    // The joined load carries the first caller's signal. Safe only while one
    // find bar at a time calls this and cancels before re-querying.
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
    // The build is not abortable; a superseded search must just not paint.
      if (signal?.aborted) throw abortError();
      // With the ladder: the corpus is handwriting recognition, so exact
      // matching fails even on correct spellings.
      const answer = await engine.query(query, ALL_SEGMENTS, true, signal);
      const plan = planMarks(query, answer.expansions);
      // A quoted phrase: only segments where its words sit together.
      const phrases = withExpansions(phrasesOf(query), answer.expansions);
      const segments: DocSegmentMatch[] = [];
      for (const hit of answer.hits) {
        const seg = hit.md5 === md5 ? byOrdinal.get(hit.page) : undefined;
        if (!seg || !holdsAll(seg.t, phrases)) continue;
        const { terms, matches } = countMarks(seg.t, plan);
        segments.push({ segment: seg.p, offset: seg.o, length: seg.l, matches, terms });
      }
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
