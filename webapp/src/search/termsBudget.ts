// Which documents' terms this browser keeps when they don't all fit: every
// notebook first (only Inkhold can search the handwriting), then everything
// else, most recently changed first. Each fits or is left out on its own, so
// a big book doesn't push out the smaller documents after it.
//
// Sizes are known for what the browser holds, and remembered for what it
// fetched once and let go (`rememberedSizes`); a document never weighed is
// asked for, weighed when it arrives, and planned again. So what is left out
// is decided once per document version, not fetched and evicted every sync.

import type { ManifestRow } from "./manifestCodec";
import { termsKeyOf } from "../cache/termsStore";

export interface KeepPlan {
  /** Manifest positions whose terms the browser keeps, or asks for. */
  readonly keep: ReadonlySet<number>;
  /**
   * Positions that don't fit, in keep order: found by name and by Find in the
   * document only. Search lists them in this order, most wanted first.
   */
  readonly leftOut: readonly number[];
  /** The `<md5>.<index_version>` of every kept position: what may be held. */
  readonly keptKeys: ReadonlySet<string>;
}

/** Each row's `<md5>.<index_version>`, or null when it has no version. */
export function rowKeys(rows: readonly ManifestRow[]): (string | null)[] {
  return rows.map((row) => (row.indexVersion === null ? null : termsKeyOf(row.md5, row.indexVersion)));
}

/** Manifest positions in the order they are kept. Ties keep the manifest's order. */
export function keepOrder(rows: readonly ManifestRow[]): number[] {
  const positions = rows.map((_, i) => i);
  return positions.sort((a, b) => {
    const ra = rows[a]!;
    const rb = rows[b]!;
    const na = ra.tier === "note" ? 0 : 1;
    const nb = rb.tier === "note" ? 0 : 1;
    if (na !== nb) return na - nb;
    if (ra.updatedAt !== rb.updatedAt) return rb.updatedAt - ra.updatedAt;
    return a - b;
  });
}

/**
 * Pure. `sizeOf` answers in bytes, or undefined for a document never weighed,
 * which is kept (asked for) at no cost until its size is known. Rows with no
 * `indexVersion` can't be cached and are neither kept nor left out. Copies of
 * one file share a record: the first in keep order decides for all of them.
 * `order` and `keys` are `keepOrder(rows)` and `rowKeys(rows)`, passed in when
 * planning the same rows often (once per arriving document).
 */
export function planKeep(
  rows: readonly ManifestRow[],
  sizeOf: (key: string) => number | undefined,
  budget: number,
  order: readonly number[] = keepOrder(rows),
  keys: readonly (string | null)[] = rowKeys(rows),
): KeepPlan {
  const keep = new Set<number>();
  const leftOut: number[] = [];
  const decided = new Map<string, boolean>();
  let used = 0;
  for (const position of order) {
    const key = keys[position];
    if (key === null || key === undefined) continue;
    let kept = decided.get(key);
    if (kept === undefined) {
      const size = sizeOf(key);
      kept = size === undefined || used + size <= budget;
      if (kept && size !== undefined) used += size;
      decided.set(key, kept);
    }
    if (kept) keep.add(position);
    else leftOut.push(position);
  }
  const keptKeys = new Set<string>();
  for (const [key, kept] of decided) if (kept) keptKeys.add(key);
  return { keep, leftOut, keptKeys };
}

/** Sizes of terms weighed and let go, by `<md5>.<index_version>`. */
export interface RememberedSizes {
  get(key: string): number | undefined;
  set(entries: Iterable<readonly [string, number]>): void;
}

/** About the person's files, so cleared at sign-out (`forget.ts`). */
export const TERMS_SIZES_KEY = "inkhold:terms-sizes";
/** Enough for any household library; the oldest are forgotten first. */
export const TERMS_SIZES_MAX = 2000;

/** The stored entries, oldest first; malformed ones are skipped. */
function readSizes(): [string, number][] {
  try {
    const v = JSON.parse(localStorage.getItem(TERMS_SIZES_KEY) ?? "[]") as unknown;
    if (!Array.isArray(v)) return [];
    return v.filter(
      (e): e is [string, number] => Array.isArray(e) && typeof e[0] === "string" && typeof e[1] === "number" && e[1] >= 0,
    );
  } catch {
    return [];
  }
}

/**
 * In `localStorage`, so a document left out isn't downloaded again on every
 * visit only to be let go. A per-visit map where storage is refused. The key
 * carries the index version, so a re-derived document is weighed anew. Each
 * write adds to what is stored at that moment, so tabs add to one list.
 */
export function rememberedSizes(): RememberedSizes {
  let sizes = new Map<string, number>(readSizes());
  return {
    get: (key) => sizes.get(key),
    set(entries) {
      const add = (into: Map<string, number>) => {
        for (const [key, size] of entries) {
          into.delete(key);
          into.set(key, size);
        }
        return new Map([...into].slice(-TERMS_SIZES_MAX));
      };
      // What is stored now, plus these: never this tab's older snapshot, which
      // would put back what sign-out (`forget.ts`) or another tab removed.
      const merged = add(new Map(readSizes()));
      try {
        localStorage.setItem(TERMS_SIZES_KEY, JSON.stringify([...merged]));
        sizes = merged;
      } catch {
        // Kept for this visit only.
        sizes = add(sizes);
      }
    },
  };
}
