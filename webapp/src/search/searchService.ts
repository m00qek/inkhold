// What the search box calls — `golden-search.md` §6's whole surface: the local
// index, and the sync lifecycle that gets it into a state where it can answer.
//
//     event: index ─┐
//                   ├─▶ refresh() ─(one window)─▶ sync ─▶ rows in IndexedDB
//     event: sync ──┘
//
// What this must not break:
//   * ONE producer. A search the local index cannot answer FAILS; nothing
//     reaches the network (§6 step 6).
//   * A WINDOW FROM THE FIRST TRIGGER, NOT A TRAILING DEBOUNCE. A device
//     pushing 100 notes emits frames for as long as it takes; a debounce that
//     re-arms on every frame would defer the sync until the burst ENDED —
//     minutes during which nothing new is searchable.
//   * A trigger during a running sync gets ONE queued re-run, not a join: the
//     request in flight fetched its manifest before the new document existed.
//   * Failed syncs are silent: the next trigger (a device upload, a derive
//     completing) retries, and the last good answer is still on screen.
//   * The text prefetch is started from the sync's completion and NOT awaited
//     (§4.4): opportunistic, never a gate on search being usable.

import type { LiveChannel } from "../sync/types";
import type { CoreLoader } from "./indexEngine";
import type { IndexSync } from "./indexSync";
import { createIndexSearch, type LiveDocument } from "./indexSearch";
import { createTextPrefetch, type TextPrefetch } from "./textPrefetch";
import type { LocalSearch } from "./localSearch";

/** How long the first trigger waits for its neighbours. The manifest costs
 *  ~127-177 ms on the Pi and a device sync bursts, so shorter buys nothing;
 *  much longer is visible as "my note is not findable yet". */
const COALESCE_MS = 1500;

export interface SearchServiceOptions {
  /** The sync driving the index. Defaults to a real one over HTTP. */
  sync?: IndexSync;
  /** How an engine instance is obtained. Injectable so tests need no wasm. */
  load?: CoreLoader;
  /** See {@link COALESCE_MS}. */
  coalesceMs?: number;
  /** The app's cached file listing, the OFFLINE stand-in for the manifest
   *  (`indexSearch.ts`). */
  listing?: () => readonly LiveDocument[];
  /** §4.4's text prefetch. Defaults to the real one; a no-op without IndexedDB. */
  textPrefetch?: TextPrefetch;
}

export interface SearchService extends LocalSearch {
  /** A trigger fired. Coalesced — call it from anywhere that learns the
   *  library moved; an extra call costs nothing. */
  refresh(): void;
  /** Sync now and await it. For boot, and for tests. Never rejects. */
  syncNow(): Promise<void>;
  /** One document's `index_version` from the last manifest — forwarded because
   *  in-document search needs it for `text/<md5>`'s `?v=`. */
  indexVersion(md5: string): number | null;
  /** §4.4's text prefetch, driven from here off each sync's manifest. Exposed
   *  for `available`; nothing sets policy through it. */
  readonly textPrefetch: TextPrefetch;
  /** Subscribe both triggers to the live channel. Returns the unsubscribe. */
  attachLive(live: LiveChannel): () => void;
  /** Cancel the pending window and hand back the engine's 16 MB (§4.2). */
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
        // Started, not awaited, and as silent as a failed sync (see the header).
        void textPrefetch.prefetch(outcome.manifest.rows).catch(() => undefined);
      }, () => undefined) // silent by design — see the header.
      .finally(() => {
        running = null;
        if (!queued) return;
        queued = false;
        void syncNow();
      });
    running = p;
    return p;
  }

  // Armed by the FIRST trigger and not re-armed by the rest.
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
      // One socket carries both frames (`sync/live.ts`). Neither payload is
      // read: a trigger says "ask the manifest", whatever it says.
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
