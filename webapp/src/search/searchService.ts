// What the search box calls — `golden-search.md` §6's whole surface, in one
// object: the local index, and the sync lifecycle that gets it into a state
// where it can answer.
//
//     event: index ─┐
//                   ├─▶ refresh() ─(one window)─▶ sync ─▶ rows in IndexedDB
//     event: sync ──┘
//
// ONE PRODUCER, AND THAT IS THE USER-VISIBLE BOUNDARY §6 STEP 6 DRAWS. There
// used to be a composite here choosing between this index and a `searchText`
// round trip; the server no longer interprets a query, so a search the local
// index cannot answer FAILS rather than quietly reaching the network. That is
// deliberate: a fallback that is by definition never taken is a second
// mechanism nobody exercises, and keeping one would have meant keeping the
// server half of search alive to feed it.
//
// ## The two triggers, coalesced — and they arrive on the same socket
//
// §3.3 names them: `event: index` (a deferred derive completed) and "the file
// listing changed" (a `.note` writes its terms at INGEST, outside the worker, so
// the version never moves for it). Both must be coalesced, because a device
// syncing 100 notes must become a handful of conditional manifest requests
// rather than a hundred × ~127-177 ms of manifest query on the Pi.
//
// It turns out both ride ONE connection: `sync/live.ts` carries `event: sync`
// and `event: index` on the same `EventSource` — so `attachLive` subscribes once
// and both triggers land in the same window. There is nothing else to coalesce
// them with.
//
// **A WINDOW FROM THE FIRST TRIGGER, NOT A TRAILING DEBOUNCE.** A debounce that
// re-arms on every frame is exactly wrong for the case that motivates the
// coalescing: a device pushing 100 notes emits frames continuously for as long
// as it takes, so the sync would be deferred until the burst ENDED — minutes,
// during which nothing new is searchable. A fixed window bounds the delay and
// bounds the request rate at the same time.
//
// A trigger that arrives while a sync is running gets ONE queued re-run rather
// than joining. Joining would be wrong for a real reason: `indexSync` already
// makes a concurrent call join the request in flight, and that request fetched
// its manifest before the new document existed — the join would return an answer
// that provably cannot contain it. One re-run, and only one, however many frames
// arrived meanwhile.
//
// ## Failed syncs are silent
//
// `IndexSyncError` exists to be retried by the next trigger (its own header says
// so), and the next trigger is a device upload or a derive completing — both
// routine. Surfacing a background sync failure would put an error in front of
// somebody who did not ask for anything, over a search box whose LAST good
// answer is still on screen and whose next keystroke retries for free.

import type { LiveChannel } from "../sync/types";
import type { CoreLoader } from "./indexEngine";
import type { IndexSync } from "./indexSync";
import { createIndexSearch, type LiveDocument } from "./indexSearch";
import type { LocalSearch } from "./localSearch";

/**
 * How long the first trigger waits for its neighbours. 1500 ms, and both
 * directions are argued: the manifest costs ~127-177 ms on the Pi and a device
 * sync delivers its frames in a burst, so a window shorter than the burst's
 * spacing buys nothing; a window longer than a second or two is visible as "my
 * note is not findable yet" to whoever just uploaded it.
 */
const COALESCE_MS = 1500;

export interface SearchServiceOptions {
  /** The sync driving the index. Defaults to a real one over HTTP. */
  sync?: IndexSync;
  /** How an engine instance is obtained. Injectable so tests need no wasm. */
  load?: CoreLoader;
  /** See {@link COALESCE_MS}. */
  coalesceMs?: number;
  /**
   * The app's cached file listing, the OFFLINE stand-in for the manifest — see
   * `indexSearch.ts`'s header. Without it a session that never manages a sync
   * cannot answer from a full store, which is the one case §4.4's "fully
   * offline" is actually about.
   */
  listing?: () => readonly LiveDocument[];
}

export interface SearchService extends LocalSearch {
  /**
   * A trigger fired. Coalesced — call it from BOTH of §3.3's triggers and from
   * anywhere else that learns the library moved; the cost of an extra call is
   * nothing, because the window is what decides when a request happens.
   */
  refresh(): void;
  /** Sync now and await it. For boot, and for tests. Never rejects. */
  syncNow(): Promise<void>;
  /** Subscribe both triggers to the live channel. Returns the unsubscribe. */
  attachLive(live: LiveChannel): () => void;
  /** Cancel the pending window and hand back the engine's 16 MB (§4.2). */
  dispose(): void;
}

export function createSearchService(opts: SearchServiceOptions): SearchService {
  const local = createIndexSearch({ sync: opts.sync, load: opts.load, listing: opts.listing });
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
      .then(() => undefined, () => undefined) // see the header: silent by design.
      .finally(() => {
        running = null;
        if (!queued) return;
        queued = false;
        void syncNow();
      });
    running = p;
    return p;
  }

  // Armed by the FIRST trigger and not re-armed by the rest — a window, not a
  // debounce. See the header.
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

    attachLive(live) {
      // One subscription for both triggers, because one socket carries both
      // frames. `onBump` is "the file listing changed"; `onIndex` is
      // `event: index`. Neither payload is read: what a trigger says is "ask the
      // manifest", and the manifest is the answer to every version of that
      // question.
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
