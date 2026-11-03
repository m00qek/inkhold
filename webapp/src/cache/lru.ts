// A byte-budgeted LRU: entries vary from ~0.2 MB thumbs to ~4 MB pages.
// DOM-free; recency is Map insertion order.

export interface ByteLruOptions<K, V> {
  budgetBytes: number;
  sizeOf: (value: V) => number;
  /** Called for every evicted or deleted entry. */
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

  get byteSize(): number {
    return this.total;
  }

  get size(): number {
    return this.slots.size;
  }

  has(key: K): boolean {
    return this.slots.has(key);
  }

  get(key: K): V | undefined {
    const slot = this.slots.get(key);
    if (!slot) return undefined;
    this.slots.delete(key);
    this.slots.set(key, slot);
    return slot.value;
  }

  put(key: K, value: V): void {
    const existing = this.slots.get(key);
    if (existing) {
      this.total -= existing.size;
      this.slots.delete(key);
      if (existing.value !== value) this.onEvict?.(key, existing.value);
    }
    const size = Math.max(0, this.sizeOf(value));
    this.slots.set(key, { value, size });
    this.total += size;
    this.evictToBudget();
  }

  delete(key: K): boolean {
    const slot = this.slots.get(key);
    if (!slot) return false;
    this.slots.delete(key);
    this.total -= slot.size;
    this.onEvict?.(key, slot.value);
    return true;
  }

  /** Oldest first; a snapshot, safe to mutate while iterating. */
  keys(): K[] {
    return [...this.slots.keys()];
  }

  clear(): void {
    for (const [key, slot] of this.slots) this.onEvict?.(key, slot.value);
    this.slots.clear();
    this.total = 0;
  }

  private evictToBudget(): void {
    // Keep the newest entry even if it alone exceeds the budget.
    while (this.total > this.budgetBytes && this.slots.size > 1) {
      const oldest = this.slots.keys().next().value as K;
      this.delete(oldest);
    }
  }
}
