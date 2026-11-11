// What the search box calls: the local index plus the sync lifecycle. Sync
// triggers coalesce into one window armed by the first trigger (a trailing
// debounce would starve during a long device burst); a trigger during a sync
// queues one re-run. Failed syncs are silent and the next trigger retries.

import type { LiveChannel } from "../sync/types";
import type { CoreLoader } from "./indexEngine";
import type { ItemKind, ItemRow } from "./itemRows";
import type { IndexSync } from "./indexSync";
import { createIndexSearch, type LiveDocument } from "./indexSearch";
import type { Derivation } from "./manifestCodec";
import { createTextPrefetch, type TextPrefetch } from "./textPrefetch";
import { rankDocuments, type LocalHit, type LocalResults, type LocalSearch } from "./localSearch";
import { holdsAll, phrasesOf, withExpansions } from "./phrase";
import { openTextStore, type TextStore } from "../cache/textStore";

/** The manifest costs ~150 ms on a Pi and device syncs burst; much longer feels like "not findable yet". */
const COALESCE_MS = 1500;

export interface SearchServiceOptions {
  sync?: IndexSync;
  load?: CoreLoader;
  coalesceMs?: number;
  /** The cached file listing, the offline stand-in for the manifest. */
  listing?: () => readonly LiveDocument[];
  textPrefetch?: TextPrefetch;
  /** The browser's document text, to check quoted phrases against. */
  store?: Pick<TextStore, "get">;
}

export interface SearchService extends LocalSearch {
  /** One kind's item rows, replaced (`indexSearch.ts`). */
  setItems(kind: ItemKind, rows: readonly ItemRow[]): void;
  /** A trigger fired. Coalesced; extra calls are free. */
  refresh(): void;
  /** Never rejects. */
  syncNow(): Promise<void>;
  /** Forwarded for in-document search's `text/<md5>?v=`. */
  indexVersion(md5: string): number | null;
  /** Forwarded so in-document search tells "not derived yet" from a failure. */
  derivation(md5: string): Derivation | null;
  /** Exposed for `available` only. */
  readonly textPrefetch: TextPrefetch;
  attachLive(live: LiveChannel): () => void;
  /** Cancel the pending window and free the engine. */
  dispose(): void;
}

export function createSearchService(opts: SearchServiceOptions): SearchService {
  const local = createIndexSearch({ sync: opts.sync, load: opts.load, listing: opts.listing });
  const textPrefetch = opts.textPrefetch ?? createTextPrefetch();
  const coalesceMs = opts.coalesceMs ?? COALESCE_MS;
  let store = opts.store ?? null;

  const phraseCheck = (res: LocalResults) => {
    store ??= openTextStore();
    return checkPhrases(res, (md5) => local.indexVersion(md5), store);
  };

  let timer: ReturnType<typeof setTimeout> | null = null;
  let running: Promise<void> | null = null;
  let queued = false;

  function syncNow(): Promise<void> {
    if (running) {
      queued = true;
      return running;
    }
    const p = local
      .sync()
      .then((outcome) => {
        // Prefetch is opportunistic: not awaited, failures ignored.
        void textPrefetch.prefetch(outcome.manifest.rows).catch(() => undefined);
      }, () => undefined)
      .finally(() => {
        running = null;
        if (!queued) return;
        queued = false;
        void syncNow();
      });
    running = p;
    return p;
  }

  // Armed by the first trigger, not re-armed by the rest.
  function refresh(): void {
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      void syncNow();
    }, coalesceMs);
  }

  return {
    get ready() {
      return local.ready;
    },
    search: (query, signal) => local.search(query, signal).then(phraseCheck),

    refresh,

    syncNow,

    setItems: (kind, rows) => local.setItems(kind, rows),

    indexVersion: (md5) => local.indexVersion(md5),
    derivation: (md5) => local.derivation(md5),

    textPrefetch,

    attachLive(live) {
      // Both frames just mean "ask the manifest"; payloads are not read.
      return live.subscribe(
        () => refresh(),
        () => refresh(),
      );
    },

    dispose() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      queued = false;
      local.drop();
    },
  };
}

/**
 * A quoted phrase: the index found pages holding its words; keep the pages
 * whose text holds them next to each other. A document whose text isn't in
 * the browser is kept, and counted in `unchecked`, rather than guessed about.
 */
export async function checkPhrases(
  res: LocalResults,
  indexVersion: (md5: string) => number | null,
  store: Pick<TextStore, "get">,
): Promise<LocalResults> {
  const phrases = withExpansions(phrasesOf(res.query), res.expansions);
  if (phrases.length === 0) return res;
  const kept: LocalHit[] = [];
  let unchecked = 0;
  for (const doc of res.documents) {
    const v = indexVersion(doc.md5);
    const text = v === null ? null : await store.get(doc.md5, v).catch(() => null);
    if (!text) {
      unchecked++;
      kept.push(doc);
      continue;
    }
    const bySegment = new Map(text.segments.map((seg) => [seg.p, seg.t]));
    const pages = doc.pages.filter((p) => holdsAll(bySegment.get(p) ?? "", phrases));
    if (pages.length > 0) kept.push({ ...doc, pages });
  }
  const totalPages = kept.reduce((n, d) => n + d.pages.length, 0);
  return { ...res, documents: rankDocuments(kept), totalPages, unchecked };
}
