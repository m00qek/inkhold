// What the search box calls: the local index plus the sync lifecycle. Sync
// triggers coalesce into one window armed by the first trigger (a trailing
// debounce would starve during a long device burst); a trigger during a sync
// queues one re-run. Failed syncs are silent and the next trigger retries.

import type { LiveChannel } from "../sync/types";
import type { CoreLoader } from "./indexEngine";
import type { IndexSync } from "./indexSync";
import { createIndexSearch, type LiveDocument } from "./indexSearch";
import { createTextPrefetch, type TextPrefetch } from "./textPrefetch";
import type { LocalSearch } from "./localSearch";

/** The manifest costs ~150 ms on a Pi and device syncs burst; much longer feels like "not findable yet". */
const COALESCE_MS = 1500;

export interface SearchServiceOptions {
  sync?: IndexSync;
  load?: CoreLoader;
  coalesceMs?: number;
  /** The cached file listing, the offline stand-in for the manifest. */
  listing?: () => readonly LiveDocument[];
  textPrefetch?: TextPrefetch;
}

export interface SearchService extends LocalSearch {
  /** A trigger fired. Coalesced; extra calls are free. */
  refresh(): void;
  /** Never rejects. */
  syncNow(): Promise<void>;
  /** Forwarded for in-document search's `text/<md5>?v=`. */
  indexVersion(md5: string): number | null;
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
    search: (query, signal) => local.search(query, signal),

    refresh,

    syncNow,

    indexVersion: (md5) => local.indexVersion(md5),

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
