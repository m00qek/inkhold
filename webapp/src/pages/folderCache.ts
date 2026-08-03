/**
 * The shell's client-side mirror of the folder tree, and the walk that fills it.
 *
 * The rail's rows and counts, the crumb labels, name-search and the root
 * gallery's flattening are all PURE FUNCTIONS of this cache — none of them
 * fetches. That is what makes the cache worth a module of its own rather than
 * five variables in `library.ts`: everything that reads it reads it the same
 * way, and everything that writes it has to keep two things in step (the
 * listing, and the roots derived from it) in a way that had already been
 * written out twice.
 */

import type { Api } from "../api/types";
import type { Folder, Id, Listing } from "../core/types";
import type { FolderTree } from "./rail";

const key = (id: Id | null) => id ?? "\0root";

export interface FolderCache {
  /** The cached listing for a folder, or undefined if the walk has not reached it. */
  get(id: Id | null): Listing | undefined;
  /**
   * Every listing the walk has reached, in no particular order. For the two
   * searches that are answered by scanning the whole tree — name-search, and the
   * reader's "which folder is this note in" — neither of which knows a folder id
   * to ask about.
   */
  values(): Iterable<Listing>;
  /**
   * The rail's read-only view. A live binding, not a snapshot — the rail holds
   * this object across walks and sees each one's result.
   */
  tree: FolderTree;
  /**
   * Replace one folder's listing, keeping the derived roots in step. The refetch
   * path's entry point; the walk uses it too, so the pairing has one home.
   */
  put(id: Id | null, listing: Listing): void;
  /**
   * Populate the cache for the whole (small, household-sized) tree. BFS,
   * sequential; `force` re-lists already-cached folders (used when a sync bump
   * lands).
   *
   * THE SEQUENTIAL BFS STAYS SEQUENTIAL. It is N round-trips before the rail's
   * resolution, the crumb labels and name-search are correct, and parallelising
   * it is not a change to make here: the server serialises every connection on
   * one coarse `db_lock`, so a fan-out would queue on a mutex while spending the
   * browser's ~6 connections that the gallery's own reads need.
   */
  prefetch(force?: boolean): Promise<void>;
}

export interface FolderCacheDeps {
  api: Pick<Api, "listFolder">;
  /**
   * The shell's session-expiry check. True means it has taken over — an expired
   * session fails every remaining hop identically, so the walk stops rather than
   * grinding through the tree while the shell re-authenticates.
   */
  handled(e: unknown): boolean;
  /**
   * A walk finished. `changed` is false when it found a tree identical to the
   * last one, which is what keeps a walk that found nothing new from costing a
   * full gallery repaint — see `rail.treeWalked`.
   */
  onWalked(changed: boolean): void;
}

export function createFolderCache({ api, handled, onWalked }: FolderCacheDeps): FolderCache {
  const listings = new Map<string, Listing>();
  let rootFolders: Folder[] = [];

  /**
   * The walk currently running, or null. ONE AT A TIME, and that is the whole of
   * the fix for the stacking: the shell fires a forced walk per sync-version
   * bump, and a tablet uploading a folder of notes bumps repeatedly, so a full
   * N-round-trip BFS used to be started on top of each still-running one — every
   * one of them contending for the browser's ~6 connections with the listing and
   * the thumbnails the user is actually looking at, and every one of them ending
   * in a repaint.
   */
  let walk: Promise<void> | null = null;
  /**
   * A forced walk was asked for WHILE one was running, so exactly one more runs
   * when this one finishes. This is the coalescing half: a burst of ten bumps
   * costs two walks, not ten, and the last one still sees the settled tree —
   * which is what the bump was asking about. A boolean rather than a counter,
   * because "walk it again" does not get truer by being asked twice.
   */
  let again = false;
  /**
   * Bumped per walk. The in-flight guard above is what keeps two walks from
   * existing, and this is what keeps that from being merely incidental: a walk
   * that is no longer the current one WRITES NOTHING. Without it, a slower
   * earlier walk finishing last would overwrite a newer walk's tree entry by
   * entry — `put` is unconditional — and the tree the rail, the crumbs and
   * name-search read would be a blend of two.
   *
   * NOTHING REACHES IT TODAY, and no test pins it: the follow-up walk is started
   * from `prefetch`'s own `finally`, so the previous `run` has already returned
   * by then and two cannot overlap. It is kept because it is the cheap half of
   * that pair — the day a second door into `run` is added, the invariant holds
   * rather than needing to be rediscovered.
   */
  let generation = 0;
  /**
   * A signature of the tree the LAST completed walk left behind, or null before
   * the first one. What `onWalked(changed)` is answered from — see `signature`.
   *
   * Null is deliberately not `""`, and the case is narrower than it looks: an
   * empty HOUSEHOLD still signs as `"\0root"`, because `signature` pushes each
   * folder's key before its entries. The signature is empty only when the walk
   * cached nothing at all — a first walk whose root listing failed non-fatally.
   * That walk must still repaint, because the rail's loaded flag flips with it,
   * and that is what turns a category's "Loading…" into "Export is empty".
   */
  let lastSignature: string | null = null;

  /**
   * Everything a repaint would be FOR, as one string: which folders exist, where,
   * what they hold and what they are called. The rail's rows and counts, the root
   * gallery's flattening, the crumb labels and name-search all read exactly this
   * and nothing else, so two walks with the same signature owe the gallery
   * nothing. Cheap because the tree is household-sized by construction — the same
   * assumption the sequential BFS rests on.
   *
   * The same reading `freshness.ts` takes of a single listing, one level up.
   */
  function signature(): string {
    const parts: string[] = [];
    for (const k of [...listings.keys()].sort()) {
      parts.push(k);
      for (const e of listings.get(k)!.entries) {
        // `itemCount` for a folder and `updatedAt` for a note are the two things
        // besides existence and name that anything downstream renders.
        parts.push(`${e.kind}${e.id}${e.name}${e.kind === "folder" ? e.itemCount : e.updatedAt}`);
      }
    }
    return parts.join("\u0000");
  }

  function put(id: Id | null, listing: Listing): void {
    listings.set(key(id), listing);
    // The roots are a projection of one particular listing, so they are re-derived
    // HERE rather than at each call site: the two used to be assigned separately,
    // and a writer that updated one without the other left the rail showing roots
    // the cache disagreed with.
    if (id === null) rootFolders = listing.entries.filter((e): e is Folder => e.kind === "folder");
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
          l = await api.listFolder(id);
        } catch (e) {
          // An expired session fails every remaining hop identically — stop the
          // walk and let the shell re-authenticate instead of grinding through
          // the tree. Any other failure just skips this folder, as before.
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
      // Join the walk already running rather than starting a second. A FORCED
      // caller cannot be satisfied by it — the running walk may already have
      // passed the folder whose change prompted the bump — so it books the one
      // follow-up `again` allows.
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
    prefetch,
  };
}
