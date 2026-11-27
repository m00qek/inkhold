// The library-wide search: the browser's FTS5 index, intersected with the live
// set. The index is a superset; only documents in the manifest (or, offline,
// the cached listing) may be returned, and totals count what survived.
// Nothing reaches the wasm loader except `search()`.

import { newestPerDocument } from "../cache/termsStore";
import type { CoreLoader, QueryResult, TermsDocument } from "./indexEngine";
import { ITEM_KINDS, type ItemKind, type ItemRow } from "./itemRows";
import { createSearchEngine, type SearchEngine } from "./searchEngine";
import { createIndexSync, type IndexSync, type SyncOutcome } from "./indexSync";
import type { Derivation, ManifestRow } from "./manifestCodec";
import { rankDocuments, type LocalHit, type LocalResults, type LocalSearch } from "./localSearch";
import { FULL_SCOPE, inScope, sameScope, type SearchScope } from "./searchScope";

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
  /**
   * What is searched (`searchScope.ts`), read per sync and per query; all of
   * it by default. Given to the sync this makes, when it makes one.
   */
  scope?: () => SearchScope;
}

/** What the manifest or the cached listing must say about a live document. */
export interface LiveDocument {
  readonly md5: string;
  readonly fileId: number;
  readonly updatedAt: number;
  /**
   * The listing's word for the manifest's tier, for the scope offline: a
   * `.note` or not. Not a tier, which would change the ranking's weights.
   */
  readonly notebook: boolean;
}

/** Whether a live row's text is searched under `scope`, from the manifest's tier or the listing's file type. */
function searched(scope: SearchScope, row: LiveDocument | ManifestRow): boolean {
  if ("tier" in row) return inScope(scope, row);
  return row.notebook || scope.documents;
}

export interface IndexSearch extends LocalSearch {
  /** One sync step; `searchService.ts` owns the lifecycle. */
  sync(signal?: AbortSignal): Promise<SyncOutcome>;
  /**
   * `index_version` from the last synced manifest, or `null`. The offline
   * listing never answers here.
   */
  indexVersion(md5: string): number | null;
  /** The last synced manifest's `derivation`, or `null` for a document it doesn't list. */
  derivation(md5: string): Derivation | null;
  /**
   * Replaces one kind's item rows: names, to-dos, digests, which the browser
   * holds itself. Written at once to a built engine, else at its build.
   */
  setItems(kind: ItemKind, rows: readonly ItemRow[]): void;
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
  const scopeOf = opts.scope ?? (() => FULL_SCOPE);
  const sync = opts.sync ?? createIndexSync({ scope: scopeOf });
  const load = opts.load;
  const listing = opts.listing;

  /**
   * The manifest's rows once synced, else null (`offlineLive` stands in).
   * Replaced wholesale per sync; merging would resurrect deletions.
   */
  let live: Map<string, ManifestRow> | null = null;
  /** Beside `live` because `live` may be the listing, which has no versions. */
  let versions = new Map<string, number | null>();
  let derivations = new Map<string, Derivation>();
  /** The file ids the last sync found no room for (`termsBudget.ts`). */
  let leftOut: readonly number[] = [];
  /** The last manifest's rows by file id: a left-out id's kind, for the scope. */
  let rowsById = new Map<number, ManifestRow>();

  let index: SearchEngine | null = null;
  /** The engine of a first build still running: item rows go to it too, queued after the build. */
  let making: SearchEngine | null = null;
  let building: Promise<SearchEngine> | null = null;
  /** Bumped by `drop`: a build begun before it publishes nothing. */
  let generation = 0;
  // Bumped when the store changed; a deletion needs no rebuild, the intersection hides it.
  let rows = 0;
  let built = -1;
  /** Each built document's page count, for density; replaced with every build. */
  let pageCounts = new Map<string, number>();
  /**
   * The scope the engine was built under. A different one rebuilds it from
   * the store, whether or not the sync that let terms go finished: one torn
   * after its drop reports nothing let go, and the engine would go on
   * holding, and matching once back on, terms the store no longer has.
   */
  let builtScope: SearchScope = FULL_SCOPE;
  /** The last rows of each kind, for an engine made later. */
  const itemRows = new Map<ItemKind, readonly ItemRow[]>();
  const hasItems = () => [...itemRows.values()].some((rows) => rows.length > 0);

  async function build(): Promise<SearchEngine> {
    const target = rows;
    const scope = scopeOf();
    const mine = generation;
    // Dedupe again: `SearchIndex.build` throws on a repeated md5.
    const stored = newestPerDocument(await sync.documents());
    const docs: TermsDocument[] = stored;
    const fresh = index === null;
    const engine = index ?? createSearchEngine({ load });
    // From here, `setItems` reaches this engine; the rows held so far go first.
    if (fresh) making = engine;
    try {
      if (fresh) for (const [kind, rows] of itemRows) await engine.setItems(kind, rows);
      await engine.build(docs);
    } catch (err) {
      // Drop a failed or dead engine so the next search starts fresh.
      if (making === engine) making = null;
      engine.close();
      // Dropped meanwhile, the engine closed under it: that, not how it failed.
      if (mine !== generation) throw abortError();
      index = null;
      built = -1;
      throw err;
    }
    if (making === engine) making = null;
    if (mine !== generation) {
      // Dropped meanwhile (a sign-out): this engine holds a person's rows no one wants.
      engine.close();
      throw abortError();
    }
    index = engine;
    built = target;
    builtScope = scope;
    pageCounts = new Map(stored.map((d) => [d.md5, d.pageCount]));
    return engine;
  }

  function offlineLive(): ReadonlyMap<string, LiveDocument> {
    const out = new Map<string, LiveDocument>();
    for (const doc of listing?.() ?? []) if (doc.md5) out.set(doc.md5, doc);
    return out;
  }

  function engine(): Promise<SearchEngine> {
    if (index && built === rows && sameScope(builtScope, scopeOf())) return Promise.resolve(index);
    // A sync landing mid-build is picked up by the next search.
    if (building) return building;
    const p = build().finally(() => {
      building = null;
    });
    building = p;
    return p;
  }

  return {
    async sync(signal) {
      const outcome = await sync.sync({ signal });
      const next = new Map<string, ManifestRow>();
      const nextVersions = new Map<string, number | null>();
      const nextDerivations = new Map<string, Derivation>();
      for (const row of outcome.manifest.rows) {
        next.set(row.md5, row);
        nextVersions.set(row.md5, row.indexVersion);
        nextDerivations.set(row.md5, row.derivation);
      }
      derivations = nextDerivations;
      live = next;
      versions = nextVersions;
      leftOut = outcome.leftOut;
      rowsById = new Map(outcome.manifest.rows.map((row) => [row.fileId, row]));
      // A document let go leaves the index too, so its matches don't outlive the count.
      if (outcome.stored > 0 || outcome.letGo > 0) rows += 1;
      return outcome;
    },

    indexVersion: (md5) => versions.get(md5) ?? null,
    derivation: (md5) => derivations.get(md5) ?? null,

    setItems(kind, rows) {
      itemRows.set(kind, rows);
      const engine = index ?? making;
      // A failed write empties the engine's index: start over at the next search.
      engine?.setItems(kind, rows).catch(() => {
        if (index !== engine) return;
        engine.close();
        index = null;
        built = -1;
      });
    },

    drop() {
      generation++;
      index?.close();
      making?.close();
      index = null;
      making = null;
      built = -1;
    },

    async search(query, signal): Promise<LocalResults> {
      // The manifest, or offline the cached listing, or the browser's own rows: an offline cold start works.
      if (!live && (listing?.().length ?? 0) === 0 && !hasItems()) throw new Error("local search has nothing to answer from");
      const idx = await engine();
      // The build is not abortable; a superseded search must just not paint.
      if (signal?.aborted) throw abortError();
      // With the typo ladder: handwriting recognition defeats exact matching.
      let answer: QueryResult;
      try {
        answer = await idx.query(query, ALL_PAGES, true, signal);
      } catch (err) {
        // A dead worker answers every later query the same: start over at the next search, rows and all.
        if ((err as { name?: unknown })?.name !== "AbortError" && index === idx) {
          idx.close();
          index = null;
          built = -1;
        }
        throw err;
      }
      const scope = scopeOf();
      // Until the sync a switch started has run, the last one's list may name
      // a kind the scope now leaves out: never left out, so never said.
      // Both come from one sync's outcome: every left-out id has its row.
      const unfit = leftOut.filter((id) => inScope(scope, rowsById.get(id)!));
      return { query, ...group(answer, live ?? offlineLive(), pageCounts, scope), ...(unfit.length > 0 ? { leftOut: unfit } : {}) };
    },
  };
}

/**
 * Group by document, intersect with the live set, rank. Pages go out
 * ascending: a row deep-links to the first matching page in the document.
 * A row the scope leaves out matches nothing at once, before the sync that
 * lets its terms go has run, and offline, where the listing says which rows
 * are notebooks.
 */
function group(
  result: QueryResult,
  live: ReadonlyMap<string, LiveDocument | ManifestRow>,
  pageCounts: ReadonlyMap<string, number>,
  scope: SearchScope,
): Omit<LocalResults, "query"> {
  const pages = new Map<string, number[]>();
  for (const hit of result.hits) {
    const row = live.get(hit.md5);
    if (!row || !searched(scope, row)) continue;
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
  const items: Record<ItemKind, string[]> = { name: [], todo: [], digest: [] };
  for (const i of result.items) items[i.kind].push(i.key);
  // Only with a surviving row, or "matched X" would sit over an empty list.
  const any = documents.length > 0 || ITEM_KINDS.some((k) => items[k].length > 0);
  const expansions = any ? result.expansions : [];
  return { totalPages, documents: rankDocuments(documents), expansions, items };
}
