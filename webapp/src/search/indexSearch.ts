// The library-wide search: the browser's FTS5 index, intersected with the live
// set. The index is a superset; only documents in the manifest (or, offline,
// the cached listing) may be returned, and totals count what survived.
// Nothing reaches the wasm loader except `search()`.

import { newestPerDocument } from "../cache/termsStore";
import type { CoreLoader, QueryResult, TermsDocument } from "./indexEngine";
import { createSearchEngine, type SearchEngine } from "./searchEngine";
import { createIndexSync, type IndexSync, type SyncOutcome } from "./indexSync";
import type { ManifestRow } from "./manifestCodec";
import { rankDocuments, type LocalHit, type LocalResults, type LocalSearch } from "./localSearch";

/** No cap: the scan is full anyway, and a capped document would undercount its matches. */
const ALL_PAGES = 0xffffffff;

export interface IndexSearchOptions {
  sync?: IndexSync;
  load?: CoreLoader;
  /**
   * The cached file listing, the offline stand-in for the manifest. Never a
   * persisted manifest: a stale one would resurrect deleted documents.
   */
  listing?: () => readonly LiveDocument[];
}

/** What the manifest or the cached listing must say about a live document. */
export interface LiveDocument {
  readonly md5: string;
  readonly fileId: number;
  readonly updatedAt: number;
}

export interface IndexSearch extends LocalSearch {
  /** One sync step; `searchService.ts` owns the lifecycle. */
  sync(signal?: AbortSignal): Promise<SyncOutcome>;
  /**
   * `index_version` from the last synced manifest, or `null`. The offline
   * listing never answers here.
   */
  indexVersion(md5: string): number | null;
  /** Free the instance; the next search rebuilds from IndexedDB rows. */
  drop(): void;
}

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

  // Replaced wholesale per sync; merging would resurrect deletions.
  let live: Map<string, LiveDocument> | null = null;
  /** Beside `live` because `live` may be the listing, which has no versions. */
  let versions = new Map<string, number | null>();

  let index: SearchEngine | null = null;
  let building: Promise<SearchEngine> | null = null;
  // Bumped when the store changed; a deletion needs no rebuild, the intersection hides it.
  let rows = 0;
  let built = -1;
  /** Each built document's page count, for density; replaced with every build. */
  let pageCounts = new Map<string, number>();

  async function build(): Promise<SearchEngine> {
    const target = rows;
    // Dedupe again: `SearchIndex.build` throws on a repeated md5.
    const stored = newestPerDocument(await sync.documents());
    const docs: TermsDocument[] = stored;
    const engine = index ?? createSearchEngine({ load });
    try {
      await engine.build(docs);
    } catch (err) {
      // Drop a failed or dead engine so the next search starts fresh.
      index = null;
      built = -1;
      engine.close();
      throw err;
    }
    index = engine;
    built = target;
    pageCounts = new Map(stored.map((d) => [d.md5, d.pageCount]));
    return engine;
  }

  function offlineLive(): ReadonlyMap<string, LiveDocument> {
    const out = new Map<string, LiveDocument>();
    for (const doc of listing?.() ?? []) if (doc.md5) out.set(doc.md5, doc);
    return out;
  }

  function engine(): Promise<SearchEngine> {
    if (index && built === rows) return Promise.resolve(index);
    // A sync landing mid-build is picked up by the next search.
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
      // The same two sources `ready` accepts, so an offline cold start works.
      if (!live && (listing?.().length ?? 0) === 0) throw new Error("local search has nothing to answer from");
      const idx = await engine();
      // The build is not abortable; a superseded search must just not paint.
      if (signal?.aborted) throw abortError();
      // With the typo ladder: handwriting recognition defeats exact matching.
      const answer = await idx.query(query, ALL_PAGES, true, signal);
      return { query, ...group(answer, live ?? offlineLive(), pageCounts) };
    },
  };
}

/**
 * Group by document, intersect with the live set, rank. Pages go out
 * ascending: a row deep-links to the first matching page in the document.
 */
function group(
  result: QueryResult,
  live: ReadonlyMap<string, LiveDocument | ManifestRow>,
  pageCounts: ReadonlyMap<string, number>,
): Omit<LocalResults, "query"> {
  const pages = new Map<string, number[]>();
  for (const hit of result.hits) {
    if (!live.has(hit.md5)) continue;
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
    documents.push({
      md5,
      fileId: row.fileId,
      pages: ordinals,
      updatedAt: row.updatedAt,
      tier: "tier" in row ? row.tier : null,
      pageCount: pageCounts.get(md5) ?? null,
    });
  }
  // Only with a surviving row, or "matched X" would sit over an empty list.
  const expansions = documents.length > 0 ? result.expansions : [];
  return { totalPages, documents: rankDocuments(documents), expansions };
}
