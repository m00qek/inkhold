import { describe, it, expect, vi } from "vitest";
import { ByteLru } from "../../src/cache/lru";

// A byte-weighted value: `n` bytes, so a budget maps to a count when uniform.
const bytes = (n: number) => ({ n });
const sizeOf = (v: { n: number }) => v.n;

describe("ByteLru", () => {
  it("tracks total byte size and count", () => {
    const lru = new ByteLru<string, { n: number }>({ budgetBytes: 100, sizeOf });
    lru.put("a", bytes(10));
    lru.put("b", bytes(20));
    expect(lru.byteSize).toBe(30);
    expect(lru.size).toBe(2);
  });

  it("evicts the oldest entries when a put exceeds the byte budget", () => {
    const lru = new ByteLru<string, { n: number }>({ budgetBytes: 30, sizeOf });
    lru.put("a", bytes(10));
    lru.put("b", bytes(10));
    lru.put("c", bytes(10)); // full
    lru.put("d", bytes(10)); // over → evict oldest "a"
    expect(lru.has("a")).toBe(false);
    expect(lru.has("d")).toBe(true);
    expect(lru.byteSize).toBe(30);
  });

  it("counts a get as a use, protecting that entry from eviction", () => {
    const lru = new ByteLru<string, { n: number }>({ budgetBytes: 30, sizeOf });
    lru.put("a", bytes(10));
    lru.put("b", bytes(10));
    lru.put("c", bytes(10));
    lru.get("a"); // a becomes newest
    lru.put("d", bytes(10)); // evict oldest, now "b"
    expect(lru.has("a")).toBe(true);
    expect(lru.has("b")).toBe(false);
  });

  it("weights by bytes, not count — one heavy entry evicts several light ones", () => {
    const lru = new ByteLru<string, { n: number }>({ budgetBytes: 100, sizeOf });
    lru.put("a", bytes(20));
    lru.put("b", bytes(20));
    lru.put("c", bytes(20)); // 60
    lru.put("big", bytes(70)); // 130 → evict a (110), b (90) then stop
    expect(lru.has("a")).toBe(false);
    expect(lru.has("b")).toBe(false);
    expect(lru.has("c")).toBe(true);
    expect(lru.has("big")).toBe(true);
    expect(lru.byteSize).toBe(90);
  });

  it("calls onEvict for evicted, replaced, deleted, and cleared entries", () => {
    const onEvict = vi.fn();
    const lru = new ByteLru<string, { n: number }>({ budgetBytes: 20, sizeOf, onEvict });
    const a = bytes(10);
    lru.put("a", a);
    lru.put("a", bytes(10)); // replace → frees old a
    expect(onEvict).toHaveBeenCalledWith("a", a);

    onEvict.mockClear();
    lru.put("b", bytes(10));
    lru.put("c", bytes(10)); // over budget → evict oldest
    expect(onEvict).toHaveBeenCalledTimes(1);

    onEvict.mockClear();
    lru.delete("b");
    expect(onEvict).toHaveBeenCalledTimes(1);

    onEvict.mockClear();
    lru.clear();
    expect(onEvict).toHaveBeenCalledTimes(1); // only "c" remained
  });

  it("keeps the just-added entry even when it alone exceeds the budget", () => {
    const lru = new ByteLru<string, { n: number }>({ budgetBytes: 10, sizeOf });
    lru.put("huge", bytes(999));
    expect(lru.has("huge")).toBe(true);
    expect(lru.size).toBe(1);
  });

  it("returns a stable oldest-first key snapshot safe to mutate during", () => {
    const lru = new ByteLru<string, { n: number }>({ budgetBytes: 100, sizeOf });
    lru.put("a", bytes(1));
    lru.put("b", bytes(1));
    lru.put("c", bytes(1));
    const keys = lru.keys();
    expect(keys).toEqual(["a", "b", "c"]);
    for (const k of keys) lru.delete(k); // mutating while iterating the snapshot
    expect(lru.size).toBe(0);
  });
});
