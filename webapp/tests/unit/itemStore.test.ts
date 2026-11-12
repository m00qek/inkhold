// The store search keeps to-dos and digests in (`cache/itemStore.ts`). Its
// IndexedDB half is checked in a browser (`todo.spec.ts`); here, the fallback.

import { describe, it, expect } from "vitest";
import { openItemStore } from "../../src/cache/itemStore";

describe("the item store without IndexedDB", () => {
  it("is a silent no-op: nothing kept, nothing thrown", async () => {
    expect(typeof indexedDB).toBe("undefined");
    const store = openItemStore();
    await expect(store.put("todo", { enabled: true })).resolves.toBeUndefined();
    await expect(store.get("todo")).resolves.toBeNull();
  });
});
