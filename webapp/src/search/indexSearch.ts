// The browser's own FTS5 index answering the search box, behind
// `localSearch.ts`'s result shape — since `golden-search.md` §6 step 6 deleted
// the server fallback, the ONLY thing that answers a library-wide query.
//
//     TermsStore rows ──build──▶ SearchIndex ──query──▶ PageRef[]
//                                                  │
//                     manifest ──────join──────────┴──▶ LocalHit[]
//
// What this must not break:
//   * Nothing reaches the wasm loader — or constructs the worker — except
//     `search()`. Not the constructor, not `sync()`, not `ready`. §4.2:
//     16.13 MB of linear memory that a member who only browses must never pay.
//   * The index is a SUPERSET; the manifest (or the cached listing, offline) is
//     what makes an answer correct (§2.7). A document absent from it must not be
//     returned, and `totalPages`/`expansions` are taken from what SURVIVED the
//     intersection, never from the engine's own total.
//   * The offline stand-in is the app's cached file LISTING, injected — never a
//     persisted manifest, which would resurrect on a stale read exactly the
//     documents absence is meant to remove. It ranks below the manifest.

import { newestPerDocument } from "../cache/termsStore";
import type { CoreLoader, QueryResult, TermsDocument } from "./indexEngine";
import { createSearchEngine, type SearchEngine } from "./searchEngine";
import { createIndexSync, type IndexSync, type SyncOutcome } from "./indexSync";
import type { ManifestRow } from "./manifestCodec";
import { rankDocuments, type LocalHit, type LocalResults, type LocalSearch } from "./localSearch";

/**
 * No page cap. The limit does not bound the scan — `idx_query` steps every
 * matching row for the exact total regardless — it only decides how many
 * rowids are kept, and a document whose pages fell off the end would report
 * fewer matches than it has and sort below documents with fewer. Worst case
 * retained is ~96 KB (23,997 rows); `con*` (5,642 pages) is 37.9 ms either way.
 */
const ALL_PAGES = 0xffffffff;

export interface IndexSearchOptions {
  /** The sync that fills the store. Defaults to a real one over HTTP. */
  sync?: IndexSync;
  /** How an engine instance is obtained. Injectable so tests need no wasm. */
  load?: CoreLoader;
  /**
   * The app's cached file listing, the OFFLINE stand-in for the manifest.
   * Injected because the folder cache is a `pages/` concern. An entry with no
   * `md5` is skipped: a document that cannot be named cannot be intersected.
   */
  listing?: () => readonly LiveDocument[];
}

/** What either source of truth — the manifest, or the app's cached listing —
 * has to be able to say about a live document. */
export interface LiveDocument {
  readonly md5: string;
  readonly fileId: number;
  readonly updatedAt: number;
}

export interface IndexSearch extends LocalSearch {
  /** Run one sync. The lifecycle — when, and how triggers coalesce — is
   *  `searchService.ts`'s; this is the single step it drives. */
  sync(signal?: AbortSignal): Promise<SyncOutcome>;
  /**
   * One document's `index_version` from the manifest last synced — the half of
   * the `(md5, indexVersion)` cache key `docText.ts` sends as `?v=`. `null`
   * when there is no manifest, or it does not name this document, or it has
   * no index row for it. The offline listing never answers here.
   */
  indexVersion(md5: string): number | null;
  /** Hand the 16 MB back (§4.2): close the instance and forget it; the next
   *  search rebuilds from rows that never left IndexedDB. */
  drop(): void;
}

/** Spelled the way `fetch` spells an abort so one `catch` reads both. */
function abortError(): Error {
  if (typeof DOMException === "function") return new DOMException("search aborted", "AbortError");
  const err = new Error("search aborted");
  err.name = "AbortError";
  return err;
}

export function createIndexSearch(opts: IndexSearchOptions = {}): IndexSearch {
  const sync = opts.sync ?? createIndexSync();
  const load = opts.load;
  const listing = opts.listing;

  // Replaced wholesale on every successful sync — the manifest is complete or
  // it is broken (`manifestCodec.ts`); merging would resurrect deletions.
  let live: Map<string, LiveDocument> | null = null;
  /** `md5 -> index_version`, from the same manifest. Kept BESIDE `live` because
   *  `live` may be the listing, which has no versions to give. */
  let versions = new Map<string, number | null>();

  let index: SearchEngine | null = null;
  let building: Promise<SearchEngine> | null = null;
  // Bumped when the STORE changed, not when the manifest did: a deletion needs
  // no rebuild, because the intersection already hides it.
  let rows = 0;
  let built = -1;

  async function build(): Promise<SearchEngine> {
    const target = rows;
    // `all()` already keeps the newest generation per md5; run it again anyway,
    // because the guard it protects is FATAL (`SearchIndex.build` refuses a
    // repeated md5) and a caller-supplied store has made no such promise.
    const docs: TermsDocument[] = newestPerDocument(await sync.documents());
    // Reused, not re-opened: `SearchEngine.build` is `rebuild` on the instance
    // the worker already holds (`indexEngine.ts`'s `reset` says why).
    const engine = index ?? createSearchEngine({ load });
    try {
      await engine.build(docs);
    } catch (err) {
      // A failed build leaves an EMPTY index and a dead worker leaves one that
      // can never answer; dropping either makes this a failed search rather
      // than a search box broken for the rest of the session.
      index = null;
      built = -1;
      engine.close();
      throw err;
    }
    index = engine;
    built = target;
    return engine;
  }

  /** The cached listing as a live set, for a session that has never synced. */
  function offlineLive(): ReadonlyMap<string, LiveDocument> {
    const out = new Map<string, LiveDocument>();
    for (const doc of listing?.() ?? []) if (doc.md5) out.set(doc.md5, doc);
    return out;
  }

  function engine(): Promise<SearchEngine> {
    if (index && built === rows) return Promise.resolve(index);
    // A sync landing mid-build is picked up by the NEXT search rather than
    // restarting one that may already be 700 ms in.
    if (building) return building;
    const p = build().finally(() => {
      building = null;
    });
    building = p;
    return p;
  }

  return {
    get ready() {
      return (live !== null || (listing?.().length ?? 0) > 0) && sync.store.available;
    },

    async sync(signal) {
      const outcome = await sync.sync({ signal });
      const next = new Map<string, ManifestRow>();
      const nextVersions = new Map<string, number | null>();
      for (const row of outcome.manifest.rows) {
        next.set(row.md5, row);
        nextVersions.set(row.md5, row.indexVersion);
      }
      live = next;
      versions = nextVersions;
      if (outcome.received > 0) rows += 1;
      return outcome;
    },

    indexVersion: (md5) => versions.get(md5) ?? null,

    drop() {
      index?.close();
      index = null;
      built = -1;
    },

    async search(query, signal): Promise<LocalResults> {
      // Refused BEFORE the loader is reachable, and against THE SAME TWO
      // SOURCES `ready` accepts: a guard that demanded a manifest once made the
      // offline cold start unreachable — `ready` said yes off the listing and
      // the query raised anyway.
      if (!live && (listing?.().length ?? 0) === 0) throw new Error("local search has nothing to answer from");
      // The first thing that can reach the loader, and construct the worker.
      const idx = await engine();
      // The build is not abortable; what a superseded search must not do is PAINT.
      if (signal?.aborted) throw abortError();
      // Asked WITH the typo ladder (the wasm runs it only on a no-match — the
      // corpus is handwriting recognition, so exact matching fails even on a
      // correctly spelled word). The signal travels with it so a superseded
      // keystroke rejects instead of waiting out the 71.3 ms scan (§8.6).
      const answer = await idx.query(query, ALL_PAGES, true, signal);
      return { query, ...group(answer, live ?? offlineLive()) };
    },
  };
}

/**
 * Group hits by document, intersect with the live set, rank. Pages come back
 * in bm25 order and go out ascending: the row deep-links to the FIRST matching
 * page (§4.3), and "first" has to mean first in the document.
 */
function group(
  result: QueryResult,
  live: ReadonlyMap<string, LiveDocument>,
): Omit<LocalResults, "query"> {
  const pages = new Map<string, number[]>();
  for (const hit of result.hits) {
    if (!live.has(hit.md5)) continue; // §2.7: superset in, live set out.
    const seen = pages.get(hit.md5);
    if (seen) seen.push(hit.page);
    else pages.set(hit.md5, [hit.page]);
  }
  const documents: LocalHit[] = [];
  let totalPages = 0;
  for (const [md5, ordinals] of pages) {
    const row = live.get(md5)!;
    ordinals.sort((a, b) => a - b);
    totalPages += ordinals.length;
    documents.push({ md5, fileId: row.fileId, pages: ordinals, updatedAt: row.updatedAt });
  }
  // Reported only when a ROW survived to carry it: "matched **reunião**" over
  // an empty result would contradict the screen.
  const expansions = documents.length > 0 ? result.expansions : [];
  return { totalPages, documents: rankDocuments(documents), expansions };
}
