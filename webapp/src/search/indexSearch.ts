// The browser's own FTS5 index answering the search box, behind
// `localSearch.ts`'s one result shape — and since `golden-search.md` §6 step 6
// deleted the fallback, the ONLY thing that answers a library-wide query.
//
//     TermsStore rows ──build──▶ SearchIndex ──query──▶ PageRef[]
//                                                  │
//                     manifest ──────join──────────┴──▶ LocalHit[]
//
// Three decisions live here and nowhere else: WHEN the engine wakes up, WHAT a
// rowid means once the manifest is joined onto it, and WHICH documents an answer
// is allowed to contain.
//
// ## Nothing touches wasm until somebody searches
//
// §4.2 is the rule the whole file is arranged around: `WebAssembly.instantiate`
// allocates a 16.13 MB static footprint (MEASURED, §8.1) and a household member
// who only ever browses must not pay it. So the loader is called from `search()`
// and from no other path — not from the constructor, not from `sync()`, not from
// `ready`. `indexSync.ts` and `termsStore.ts` each say the same thing from their
// own side; this is the side that could still get it wrong, because it is the
// one holding the loader.
//
// The build is on the FIRST SEARCH rather than at sync time for the same reason,
// and it is not free: 703 ms for the whole 1,222-document library, 39 ms at
// tier 1 (§8.1). It is paid by the person who typed, once, and then reused.
//
// ## The index is a SUPERSET and the manifest is what makes an answer correct
//
// §2.7: purging is not a protocol step. A trashed document stops matching
// because it is ABSENT from the next complete manifest, and local leftovers are
// harmless — until they are returned. So every hit is intersected with the
// manifest before it becomes a row, and a document the manifest does not name is
// dropped whether or not any clean-up has run. This is also the only way a
// deletion becomes visible immediately: the drop of its rows is clean-up, and
// clean-up is allowed to be late.
//
// The manifest is joined for a second reason as well — it is where `fileId` and
// `updatedAt` come from. The terms records deliberately carry neither (§2.2),
// because the app already holds the listing and shipping names in the index
// would be a second copy of it.
//
// **`totalPages` is summed from what SURVIVED the intersection, not taken from
// the engine's exact total.** The engine counts pages in the index; the UI shows
// pages in the rows. A deleted document's five pages in the first number and not
// the second is a count that contradicts what is on screen.
//
// ## The typo ladder is ASKED FOR here, and its answer is intersected too
//
// The query goes to the engine with the fallback enabled (§6.1 moved the ladder
// into the wasm), so a search the corpus misspells still answers — the text is
// the device's own handwriting recognition, so exact matching fails even when
// the person spells the word correctly. What comes back is `expansions`, and it
// is subject to the same rule as the count below: a substitution whose every
// page belonged to a document the manifest no longer names is dropped with those
// pages, because "matched **reunião**" over an empty result contradicts the
// screen exactly as a too-large total would.
//
// ## What "ready" promises, and the one thing it does not
//
// `ready` means there is an index to answer from. It goes true after a sync has
// produced a manifest and stays false where IndexedDB is not there at all
// (`TermsStore.available`), because the no-op store answers every build with
// zero documents — and a search that confidently returns nothing is worse than
// one that says it could not run. Since step 6 there is nothing behind this to
// fall back to, so `search` RAISES rather than answering empty, and the box
// paints "couldn't search".
//
// ## Offline, where there is no manifest to join
//
// The manifest is held in memory, so a session that has never managed a sync has
// none — which would leave a full store from yesterday unsearchable and make
// §4.4's "global search is fully offline" false in exactly the case it is for.
//
// The answer is NOT a persisted manifest. That would be a second opinion about a
// fact the server regenerates per request, and the first thing it would do on a
// stale read is resurrect documents §2.7 relies on absence to remove.
//
// It is §2.7's own rule: intersect against the file listing the app already
// caches. A listing entry carries `fileHash` — the same blob md5 the derived
// files are keyed by — plus the id and timestamp a hit needs, so it can stand in
// for the manifest wholesale. The shell INJECTS it (`opts.listing`), because the
// folder cache is a `pages/` concern and this module must not learn about it.
//
// It is a fallback and ranks below the manifest whenever one exists: the listing
// is the app's view of the tree, the manifest is the server's answer to "what is
// live and derived", and only the second knows about `indexVersion`.

import { newestPerDocument } from "../cache/termsStore";
import { SearchIndex, type CoreLoader, type QueryResult, type TermsDocument } from "./indexEngine";
import { createIndexSync, type IndexSync, type SyncOutcome } from "./indexSync";
import type { ManifestRow } from "./manifestCodec";
import { rankDocuments, type LocalHit, type LocalResults, type LocalSearch } from "./localSearch";

/**
 * The page cap handed to `idx_query`, which is to say none.
 *
 * The limit does NOT bound the scan: `idx_query` steps every matching row to
 * produce the exact total whatever the limit is, and the limit only decides how
 * many rowids it keeps. So capping buys one `u32` per skipped hit and costs the
 * thing the rows are ranked by — a document whose pages fell off the end reports
 * fewer matches than it has, and sorts below documents with fewer. The whole
 * library's index is 23,997 rows, so the worst case this can retain is ~96 KB,
 * and the pathological `con*` (5,642 pages) is 37.9 ms of stepping either way.
 */
const ALL_PAGES = 0xffffffff;

export interface IndexSearchOptions {
  /** The sync that fills the store. Defaults to a real one over HTTP. */
  sync?: IndexSync;
  /** How an engine instance is obtained. Injectable so tests need no wasm. */
  load?: CoreLoader;
  /**
   * The app's cached file listing, as the OFFLINE stand-in for the manifest —
   * see the header. Injected because the folder cache is a `pages/` concern;
   * this module knows only that something can name live documents.
   *
   * An entry with no `md5` is skipped rather than guessed at: the listing's
   * `fileHash` is optional on the wire, and a document that cannot be named
   * cannot be intersected.
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
   * Hand the 16 MB back (§4.2). Dropping an index means dropping the INSTANCE —
   * wasm linear memory never shrinks — so this closes it and forgets it, and the
   * next search rebuilds from rows that never left IndexedDB.
   */
  drop(): void;
}

/** An aborted search, spelled the way `fetch` spells it so one `catch` reads
 *  both — a superseded keystroke is distinguishable from a real failure by the
 *  name alone, wherever it is caught. */
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

  // The live document set, as a lookup. Replaced wholesale on every successful
  // sync — the manifest is complete or it is broken (`manifestCodec.ts`), so
  // merging into the previous one would resurrect exactly the documents §2.7
  // relies on absence to remove.
  let live: Map<string, LiveDocument> | null = null;

  let index: SearchIndex | null = null;
  let building: Promise<SearchIndex> | null = null;
  // Bumped when the STORE changed, not when the manifest did: a deletion needs
  // no rebuild at all, because the intersection above already hides it. Only
  // rows that arrived can make the built index wrong.
  let rows = 0;
  let built = -1;

  async function build(): Promise<SearchIndex> {
    const target = rows;
    // `all()` already keeps the newest generation per md5; run it again anyway,
    // because the guard it exists for is FATAL — `SearchIndex.build` refuses a
    // repeated md5 rather than doubling the counts §4.3 ranks by — and a store
    // supplied by a caller (or a test) has made no such promise.
    const docs: TermsDocument[] = newestPerDocument(await sync.documents());
    const engine = index ?? (await SearchIndex.open(load));
    // Reused rather than re-opened: §4.1 measured that `idx_open()` returns the
    // old database's pages to SQLite's heap INSIDE linear memory, so successive
    // builds converge on the cost of the worst one instead of growing past it.
    if (index) engine.reset();
    engine.build(docs);
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

  function engine(): Promise<SearchIndex> {
    if (index && built === rows) return Promise.resolve(index);
    // A sync that lands mid-build is picked up by the NEXT search rather than
    // restarting one that may already be 700 ms in. The alternative spends the
    // whole build again to add rows the person who typed did not ask about.
    if (building) return building;
    const p = build().finally(() => {
      building = null;
    });
    building = p;
    return p;
  }

  return {
    get ready() {
      // Either source will do. The listing is the offline one — see the header.
      return (live !== null || (listing?.().length ?? 0) > 0) && sync.store.available;
    },

    async sync(signal) {
      const outcome = await sync.sync({ signal });
      const next = new Map<string, ManifestRow>();
      for (const row of outcome.manifest.rows) next.set(row.md5, row);
      live = next;
      if (outcome.received > 0) rows += 1;
      return outcome;
    },

    drop() {
      index?.close();
      index = null;
      built = -1;
    },

    async search(query, signal): Promise<LocalResults> {
      // Refused BEFORE the loader is reachable: a caller searching while not
      // ready would otherwise pay 16 MB and a 703 ms build to get an exception.
      //
      // THE SAME TWO SOURCES `ready` ACCEPTS, and they have to be the same two.
      // The guard used to demand a manifest, which made the offline cold start
      // (§4.4) unreachable — `ready` said yes off the cached listing and the
      // query then raised anyway. The server fallback swallowed that; step 6
      // deleted the fallback, so the divergence is now a "couldn't search" on
      // screen rather than a slow answer.
      if (!live && (listing?.().length ?? 0) === 0) throw new Error("local search has nothing to answer from");
      // THE FIRST THING THAT CAN REACH THE LOADER, and it is behind a query.
      const idx = await engine();
      // The build is not abortable and should not be — it is the same work the
      // next keystroke needs. What a superseded search must not do is PAINT, and
      // that is what this raises for.
      if (signal?.aborted) throw abortError();
      // `live` is replaced by every sync and never cleared, so what the answer is
      // intersected with is the manifest current when it is FORMED, not the one
      // that was current when it began.
      // The manifest when there is one, the cached listing when there is not —
      // the header says why that order and not the reverse.
      //
      // Asked WITH the typo ladder, which the wasm runs only when the query as
      // typed matched nothing. That is the whole of §4.3's "matched **reunião**"
      // and it is what the corpus needs rather than a nicety: the text is the
      // device's own handwriting recognition, so exact matching fails even when
      // the person spells the word correctly.
      return {
        query,
        ...group(idx.query(query, ALL_PAGES, true), live ?? offlineLive()),
      };
    },
  };
}

/**
 * An engine answer to result rows: group hits by document, intersect with the
 * manifest, rank — and carry the ladder's substitution across, or drop it.
 *
 * Pages come back in bm25 order and go out ascending, because the row deep-links
 * to the FIRST matching page (§4.3) and "first" has to mean first in the
 * document, not first in the ranking.
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
  // The substitution is reported only when a ROW survived to carry it. Same
  // rule as `totalPages` above and for the same reason: the engine counts what
  // is in the index and the UI shows what is on screen, so "matched **reunião**"
  // over an empty result — every corrected page belonging to a document the
  // manifest no longer names — would be the header's contradiction in words
  // instead of in numbers.
  const expansions = documents.length > 0 ? result.expansions : [];
  return { totalPages, documents: rankDocuments(documents), expansions };
}
