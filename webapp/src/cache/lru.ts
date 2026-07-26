// A byte-budgeted LRU map — the in-memory tier (L3a) of the render cache. Unlike
// a count-bounded LRU, entries have wildly different weights (a "thumb" bitmap is
// ~0.2 MB, a "full" reader page ~4 MB), so the budget is measured in *bytes* via
// a caller-supplied `sizeOf`. When a `put` pushes the total over budget the
// oldest entries are evicted (and handed to `onEvict`, which closes the bitmap to
// actually free the memory) until it fits again.
//
// Pure and DOM-free: it knows nothing about ImageBitmap or canvases — the render
// cache injects `sizeOf`/`onEvict` — so the eviction logic is unit-testable with
// plain values. Recency is tracked by Map insertion order: a `get` (or re-`put`)
// re-inserts the key so it moves to the "newest" end, and eviction always takes
// from the "oldest" (front) end.

export interface ByteLruOptions<K, V> {
  /** Hard cap in bytes. When exceeded, oldest entries are evicted to fit. */
  budgetBytes: number;
  /** Weight of a value in bytes (e.g. width*height*4 for RGBA pixels). */
  sizeOf: (value: V) => number;
  /** Called for every evicted/deleted entry — e.g. `bitmap.close()`. */
  onEvict?: (key: K, value: V) => void;
}

interface Slot<V> {
  value: V;
  size: number;
}

export class ByteLru<K, V> {
  private readonly slots = new Map<K, Slot<V>>();
  private readonly budgetBytes: number;
  private readonly sizeOf: (value: V) => number;
  private readonly onEvict: ((key: K, value: V) => void) | undefined;
  private total = 0;

  constructor(opts: ByteLruOptions<K, V>) {
    this.budgetBytes = Math.max(0, opts.budgetBytes);
    this.sizeOf = opts.sizeOf;
    this.onEvict = opts.onEvict;
  }

  /** Current total weight of all live entries, in bytes. */
  get byteSize(): number {
    return this.total;
  }

  /** Number of live entries. */
  get size(): number {
    return this.slots.size;
  }

  has(key: K): boolean {
    return this.slots.has(key);
  }

  /** Fetch a value and mark it most-recently-used, or `undefined` on a miss. */
  get(key: K): V | undefined {
    const slot = this.slots.get(key);
    if (!slot) return undefined;
    // Re-insert to move to the newest end (Map keeps insertion order).
    this.slots.delete(key);
    this.slots.set(key, slot);
    return slot.value;
  }

  /** Store a value, replacing any prior one, then evict until back in budget. */
  put(key: K, value: V): void {
    const existing = this.slots.get(key);
    if (existing) {
      this.total -= existing.size;
      this.slots.delete(key);
      // Replacing the same key: the prior bitmap is superseded, so free it.
      if (existing.value !== value) this.onEvict?.(key, existing.value);
    }
    const size = Math.max(0, this.sizeOf(value));
    this.slots.set(key, { value, size });
    this.total += size;
    this.evictToBudget();
  }

  /** Remove one entry (freeing it via `onEvict`). Returns whether it existed. */
  delete(key: K): boolean {
    const slot = this.slots.get(key);
    if (!slot) return false;
    this.slots.delete(key);
    this.total -= slot.size;
    this.onEvict?.(key, slot.value);
    return true;
  }

  /** Snapshot of keys, oldest-first. Safe to mutate the cache while iterating. */
  keys(): K[] {
    return [...this.slots.keys()];
  }

  clear(): void {
    for (const [key, slot] of this.slots) this.onEvict?.(key, slot.value);
    this.slots.clear();
    this.total = 0;
  }

  private evictToBudget(): void {
    // Keep at least the just-added entry even if it alone exceeds the budget —
    // holding one is strictly better than nothing (and a miss is always safe).
    while (this.total > this.budgetBytes && this.slots.size > 1) {
      const oldest = this.slots.keys().next().value as K;
      this.delete(oldest);
    }
  }
}
