// Stale-while-revalidate reconciliation for folder listings (layer L1). Pure and
// DOM-free — this is the *decision* logic the library page drives its cache with;
// the actual fetch + live subscription live elsewhere.
//
// The contract: a cached `Listing` carries the `syncVersion` it was fetched at.
// A `LiveChannel` pushes the user's current version whenever a device upload
// changes their files. Comparing the two tells us whether a cached listing is
// still fresh (show it, done), stale (show it *now* but revalidate), or absent
// (must fetch). When a revalidation returns, `reconcile` merges it against what
// we were showing and reports whether anything actually changed — so the UI only
// repaints (and re-runs the lazy thumbnails) when the bytes truly differ.

import type { Entry, Listing } from "../core/types";

export type Freshness = "miss" | "stale" | "fresh";

/**
 * Classify a cached listing against the latest known sync-version. `miss` when
 * there's nothing cached; `stale` when the user's files have advanced past what
 * we cached; `fresh` otherwise. A cached version *ahead* of `knownSyncVersion`
 * (e.g. we just fetched, before the live channel caught up) still counts fresh.
 */
export function classify(cached: Listing | undefined, knownSyncVersion: number): Freshness {
  if (!cached) return "miss";
  return cached.syncVersion < knownSyncVersion ? "stale" : "fresh";
}

/** Structural equality for a single listing row (folder or note summary). */
export function sameEntry(a: Entry, b: Entry): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "folder" && b.kind === "folder") {
    // `itemCount` is compared because it is RENDERED (the row's "5 items" and the
    // rail's count). Leaving it out would make a folder whose contents changed
    // compare equal, and — now that an unchanged listing is not repainted at all
    // — the stale number would stay on screen until something else forced a
    // paint.
    return a.id === b.id && a.name === b.name && a.itemCount === b.itemCount;
  }
  if (a.kind === "note" && b.kind === "note") {
    return (
      a.id === b.id &&
      a.name === b.name &&
      a.pageCount === b.pageCount &&
      a.updatedAt === b.updatedAt &&
      a.firstPage.hash === b.firstPage.hash
    );
  }
  return false;
}

function sameEntries(a: readonly Entry[], b: readonly Entry[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    // Non-null because the length guard above bounds the index.
    if (!sameEntry(a[i]!, b[i]!)) return false;
  }
  return true;
}

export interface ReconcileResult {
  /** The listing to show — `next`, but reusing unchanged `prev` entry objects so
   * identity is stable where content is (helps callers skip DOM churn). */
  listing: Listing;
  /** Whether `next` differs from `prev` in any observable way. */
  changed: boolean;
}

/**
 * Merge a freshly fetched listing over what we were showing. The result is
 * always `next`'s data (it's authoritative), but entries byte-identical to the
 * previous listing keep their previous object reference, and `changed` reports
 * whether a repaint is warranted at all.
 */
export function reconcile(prev: Listing | undefined, next: Listing): ReconcileResult {
  if (!prev) return { listing: next, changed: true };

  const entries = next.entries.map((entry, i) => {
    const before = prev.entries[i];
    return before && sameEntry(before, entry) ? before : entry;
  });

  const changed =
    prev.folderId !== next.folderId ||
    prev.syncVersion !== next.syncVersion ||
    !sameEntries(prev.entries, next.entries);

  // NOTHING CHANGED → HAND BACK THE EXACT SAME LISTING OBJECT.
  //
  // This function already kept unchanged ENTRY objects stable "so callers can
  // skip DOM churn", but it allocated a fresh listing wrapper every time — so the
  // library's `listing !== result.listing` guard was true on every single
  // revalidation and the gallery repainted regardless of `changed`.
  //
  // That repaint replaces every card in the grid, and it lands while the user is
  // using them: it drops keyboard focus (a focused Export button is destroyed
  // mid-tab, and `:focus-within` silently switches the row's actions back off),
  // and it detaches the node under an in-flight scroll or click. Reconciliation
  // exists precisely to avoid that, and `changed` is already the right answer —
  // it was just being ignored one layer up.
  //
  // Safe because `changed === false` implies same folderId, same syncVersion and
  // structurally equal entries, so `prev` and `next` are the same listing.
  if (!changed) return { listing: prev, changed: false };
  return { listing: { ...next, entries }, changed };
}
