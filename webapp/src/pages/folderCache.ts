/**
* The shell's client-side mirror of the folder tree, and the walk that fills
* it. Rail rows, crumbs, name-search and the root gallery read only this.
*/

import type { Api } from "../api/types";
import type { Folder, Id, Listing } from "../core/types";
import type { FolderTree } from "./rail";

const key = (id: Id | null) => id ?? "\0root";

export interface FolderCache {
  get(id: Id | null): Listing | undefined;
  /** Every listing reached, unordered, for whole-tree scans. */
  values(): Iterable<Listing>;
  /** A live binding, not a snapshot. */
  tree: FolderTree;
  /** Replace one listing, keeping the derived roots in step. */
  put(id: Id | null, listing: Listing): void;
  /**
  * Joins a concurrent request for the same folder (the walk and the route both
  * ask for the root at boot). Not a cache: the promise is dropped on settle.
  */
  listFolder(id: Id | null): Promise<Listing>;
  /**
  * BFS over the whole (household-sized) tree; `force` re-lists cached folders.
  * Sequential on purpose: the server serialises on one `db_lock`, so a fan-out
  * would only spend browser connections the gallery needs.
  */
  prefetch(force?: boolean): Promise<void>;
}

export interface FolderCacheDeps {
  api: Pick<Api, "listFolder">;
  /** True means the session expired and the shell took over; the walk stops. */
  handled(e: unknown): boolean;
  /** `changed` is false for an identical tree, so no gallery repaint is owed. */
  onWalked(changed: boolean): void;
}

export function createFolderCache({ api, handled, onWalked }: FolderCacheDeps): FolderCache {
  const listings = new Map<string, Listing>();
  let rootFolders: Folder[] = [];

  /** The running walk. One at a time: sync bumps arrive in bursts. */
  let walk: Promise<void> | null = null;
  /** A forced walk asked for mid-walk: exactly one more runs afterwards. */
  let again = false;
  /**
  * Bumped per walk; a stale walk writes nothing, so two can never blend the
  * tree. Unreachable today (the follow-up starts from `finally`), kept as a guard.
  */
  let generation = 0;
  /**
  * Null, not `""`: an empty household still signs as `"\0root"`; empty means
  * the walk cached nothing, and that first walk must still repaint so the
  * rail's loaded flag flips.
  */
  let lastSignature: string | null = null;

  /** Everything a repaint depends on, as one string. */
  function signature(): string {
    const parts: string[] = [];
    for (const k of [...listings.keys()].sort()) {
      parts.push(k);
      for (const e of listings.get(k)!.entries) {
        parts.push(`${e.kind}${e.id}${e.name}${e.kind === "folder" ? e.itemCount : e.updatedAt}`);
      }
    }
    return parts.join("\u0000");
  }

  function put(id: Id | null, listing: Listing): void {
    listings.set(key(id), listing);
    if (id === null) rootFolders = listing.entries.filter((e): e is Folder => e.kind === "folder");
  }

  const inFlight = new Map<string, Promise<Listing>>();

  function listFolder(id: Id | null): Promise<Listing> {
    const k = key(id);
    const running = inFlight.get(k);
    if (running) return running;
    // Callers get the API's own promise; cleanup rides a side branch so no extra
    // microtask lands before them. Both arms delete, so a failure isn't cached.
    const started = api.listFolder(id);
    inFlight.set(k, started);
    void started.then(
      () => inFlight.delete(k),
      () => inFlight.delete(k),
    );
    return started;
  }

  async function run(force: boolean): Promise<void> {
    const mine = ++generation;
    const queue: (Id | null)[] = [null];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const id = queue.shift()!;
      if (seen.has(key(id))) continue;
      seen.add(key(id));
      let l = listings.get(key(id));
      if (!l || force) {
        try {
          l = await listFolder(id);
        } catch (e) {
          if (handled(e)) return;
          continue;
        }
        if (mine !== generation) return; // superseded — this walk's tree is nobody's
        put(id, l);
      }
      for (const e of l.entries) if (e.kind === "folder") queue.push(e.id);
    }
    if (mine !== generation) return;
    const sig = signature();
    const changed = lastSignature === null || sig !== lastSignature;
    lastSignature = sig;
    onWalked(changed);
  }

  function prefetch(force = false): Promise<void> {
    if (walk) {
      // A forced caller can't trust the running walk (it may have passed the changed
      // folder), so it books the one follow-up.
      if (force) again = true;
      return walk;
    }
    const started = run(force).finally(() => {
      walk = null;
      if (!again) return;
      again = false;
      void prefetch(true);
    });
    walk = started;
    return started;
  }

  return {
    get: (id) => listings.get(key(id)),
    values: () => listings.values(),
    tree: {
      roots: () => rootFolders,
      children: (id) => {
        const cached = listings.get(key(id));
        return cached ? cached.entries.filter((e): e is Folder => e.kind === "folder") : [];
      },
      walked: (id) => listings.has(key(id)),
    },
    put,
    listFolder,
    prefetch,
  };
}
