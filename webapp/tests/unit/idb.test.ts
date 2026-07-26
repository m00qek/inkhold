import { describe, it, expect } from "vitest";
import { planEviction, budgetForQuota, openDimsStore, type PersistedMeta } from "../../src/cache/idb";

const meta = (key: string, size: number, lastAccess: number): PersistedMeta => ({ key, size, lastAccess });

describe("planEviction", () => {
  it("evicts nothing when under budget", () => {
    const metas = [meta("a", 10, 1), meta("b", 10, 2)];
    expect(planEviction(metas, 100)).toEqual([]);
  });

  it("evicts oldest-access-first until back under budget", () => {
    const metas = [meta("new", 40, 300), meta("old", 40, 100), meta("mid", 40, 200)];
    // total 120, budget 100 → drop the single oldest ("old", 40) → 80.
    expect(planEviction(metas, 100)).toEqual(["old"]);
  });

  it("evicts multiple entries when one is not enough", () => {
    const metas = [meta("a", 30, 1), meta("b", 30, 2), meta("c", 30, 3), meta("d", 30, 4)];
    // total 120, budget 50 → drop a(→90), b(→60), c(→30) stop.
    expect(planEviction(metas, 50)).toEqual(["a", "b", "c"]);
  });

  it("is pure — does not reorder the input", () => {
    const metas = [meta("z", 10, 9), meta("a", 10, 1)];
    const snapshot = [...metas];
    planEviction(metas, 5);
    expect(metas).toEqual(snapshot);
  });
});

describe("budgetForQuota", () => {
  it("returns the desired budget when no estimate is available", () => {
    expect(budgetForQuota(undefined, 100)).toBe(100);
    expect(budgetForQuota({}, 100)).toBe(100);
  });

  it("clamps to 80% of quota minus other origins' usage", () => {
    // quota 1000, usage 500, ours 0 → others 500; headroom = 800-500 = 300.
    expect(budgetForQuota({ quota: 1000, usage: 500 }, 1000, 0)).toBe(300);
  });

  it("does not count our own usage against us", () => {
    // usage 500 but 400 is ours → others 100; headroom = 800-100 = 700.
    expect(budgetForQuota({ quota: 1000, usage: 500 }, 1000, 400)).toBe(700);
  });

  it("never returns more than the desired budget", () => {
    expect(budgetForQuota({ quota: 1_000_000, usage: 0 }, 100)).toBe(100);
  });

  it("never returns negative when the quota is already exhausted by others", () => {
    expect(budgetForQuota({ quota: 1000, usage: 950 }, 1000, 0)).toBe(0);
  });
});

describe("openDimsStore", () => {
  it("degrades to a null store where IndexedDB is missing — never throws", async () => {
    // Node has no indexedDB: the dims store must answer "unknown" and accept
    // writes silently, exactly like the thumb store's no-op fallback — a miss
    // only costs one first-view reflow.
    const store = openDimsStore();
    expect(store.available).toBe(false);
    await expect(store.get("h1")).resolves.toBeNull();
    await expect(store.put("h1", { w: 1, h: 2 })).resolves.toBeUndefined();
    await expect(store.clear()).resolves.toBeUndefined();
    await expect(store.get("h1")).resolves.toBeNull(); // still a no-op, not a Map
  });
});
