// Sign-out leaves nothing of the person's in this browser's storage (#17).

import { describe, it, expect, vi } from "vitest";
import { forgetPerson, PERSON_DATABASES, PERSON_KEYS, type ForgetSeams } from "../../src/cache/forget";
import { yieldOnVersionChange } from "../../src/cache/idbLife";

type Outcome = "success" | "error" | "blocked" | "throw";

/** An `indexedDB.deleteDatabase` that answers each name as told, on the next tick. */
function idbAnswering(outcome: (name: string) => Outcome) {
  const asked: string[] = [];
  const idb = {
    deleteDatabase(name: string) {
      asked.push(name);
      const how = outcome(name);
      if (how === "throw") throw new Error("refused");
      const req = {} as { onsuccess?: () => void; onerror?: () => void; onblocked?: () => void };
      setTimeout(() => (how === "success" ? req.onsuccess?.() : how === "error" ? req.onerror?.() : req.onblocked?.()), 0);
      return req as unknown as IDBOpenDBRequest;
    },
  };
  return { idb, asked };
}

function storage(keys: string[]) {
  const held = new Set(keys);
  return { held, removeItem: (k: string) => void held.delete(k) };
}

describe("forgetting the person at sign-out", () => {
  it("deletes every database built from their library, and their key, and keeps the device's preferences", async () => {
    const { idb, asked } = idbAnswering(() => "success");
    const s = storage(["sn.theme", "sn.sort", ...PERSON_KEYS]);
    await forgetPerson({ idb, storage: s, blockedMs: 50 });
    expect(asked.sort()).toEqual(["sn-dims", "sn-doctext", "sn-nocover", "sn-search-items", "sn-terms", "sn-thumbs"]);
    expect([...s.held].sort()).toEqual(["sn.sort", "sn.theme"]);
    expect(PERSON_KEYS).toEqual(["inkhold:text-refused"]);
  });

  it("does not hang on a delete an open connection holds back, and goes on past one that fails", async () => {
    vi.useFakeTimers();
    try {
      const { idb, asked } = idbAnswering((name) => (name === "sn-terms" ? "blocked" : name === "sn-dims" ? "error" : name === "sn-thumbs" ? "throw" : "success"));
      let done = false;
      const run = forgetPerson({ idb, storage: null, blockedMs: 2000 }).then(() => (done = true));
      await vi.advanceTimersByTimeAsync(1);
      expect(done).toBe(false); // waiting on the held-back one
      await vi.advanceTimersByTimeAsync(2000);
      await run;
      expect(done).toBe(true);
      expect(asked).toHaveLength(PERSON_DATABASES.length);
    } finally {
      vi.useRealTimers();
    }
  });

  it("with no storage at all, there is nothing to do and nothing goes wrong", async () => {
    await expect(forgetPerson({ idb: null, storage: null, blockedMs: 0 })).resolves.toBeUndefined();
    const throwing = { removeItem: () => { throw new Error("blocked"); } };
    await expect(forgetPerson({ idb: null, storage: throwing, blockedMs: 0 } as ForgetSeams)).resolves.toBeUndefined();
  });

  it("a store's open connection closes when a delete asks it to", () => {
    const db = { close: vi.fn(), onversionchange: null as null | (() => void) } as unknown as IDBDatabase;
    expect(yieldOnVersionChange(db)).toBe(db);
    (db.onversionchange as unknown as () => void)();
    expect(db.close).toHaveBeenCalledTimes(1);
  });
});
