// Stale-while-revalidate decisions for folder listings. A cached `Listing`
// carries the `syncVersion` it was fetched at; comparing it with the live
// channel's version gives miss/stale/fresh, and `reconcile` reports whether a
// revalidation changed anything worth repainting.

import type { Entry, Listing } from "../core/types";

export type Freshness = "miss" | "stale" | "fresh";

/** A cached version ahead of `knownSyncVersion` still counts as fresh. */
export function classify(cached: Listing | undefined, knownSyncVersion: number): Freshness {
  if (!cached) return "miss";
  return cached.syncVersion < knownSyncVersion ? "stale" : "fresh";
}

export function sameEntry(a: Entry, b: Entry): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "folder" && b.kind === "folder") {
    // `itemCount` is rendered, so it must be compared.
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
    if (!sameEntry(a[i]!, b[i]!)) return false;
  }
  return true;
}

export interface ReconcileResult {
  /** `next`, reusing unchanged `prev` entry objects so identity tracks content. */
  listing: Listing;
  changed: boolean;
}

/** `next` is authoritative; unchanged entries keep their previous objects. */
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

  // Unchanged: return the same listing object, so the caller's identity check
  // skips a repaint that would drop focus and detach nodes mid-click.
  if (!changed) return { listing: prev, changed: false };
  return { listing: { ...next, entries }, changed };
}
