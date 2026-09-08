import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { newestPerDocument, type StoredTermsDocument } from "../../src/cache/termsStore";
import { SearchIndex, type CoreLoader, type SearchCoreExports } from "../../src/search/indexEngine";

// The real module, loaded the way `indexEngine.test.ts` loads it — the third
// test below is only worth anything against an engine that really refuses.
let bytes: Uint8Array;
const loadCore: CoreLoader = async () => {
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const core = instance.exports as unknown as SearchCoreExports;
  core._initialize?.();
  return core;
};
beforeAll(() => {
  bytes = readFileSync(fileURLToPath(new URL("../../public/sqlite-core.wasm", import.meta.url)));
});

/**
 * The seam between the two halves of step 3, which were built independently and
 * so had nobody testing the join. The store is keyed `(md5, indexVersion)`; the
 * index build refuses a repeated md5. Those two facts are individually right and
 * collide the moment an extractor-version bump lands before its clean-up does.
 */
const doc = (md5: string, indexVersion: number, terms: string): StoredTermsDocument => ({
  md5,
  indexVersion,
  pageCount: 1,
  pages: [{ p: 0, t: terms }],
  storedAt: 0,
});

describe("two generations of one document", () => {
  it("collapse to the newest before the build sees them", () => {
    const kept = newestPerDocument([doc("aa", 14, "old"), doc("aa", 15, "new"), doc("bb", 15, "other")]);
    expect(kept).toHaveLength(2);
    expect(kept.find((d) => d.md5 === "aa")?.indexVersion).toBe(15);
    expect(kept.find((d) => d.md5 === "aa")?.pages[0].t).toBe("new");
  });

  it("survive whatever order IndexedDB returns them in", () => {
    const kept = newestPerDocument([doc("aa", 15, "new"), doc("aa", 14, "old")]);
    expect(kept.map((d) => d.indexVersion)).toEqual([15]);
  });

  it("would otherwise make the index build THROW, not merely go stale", async () => {
    const both = [doc("aa", 14, "old"), doc("aa", 15, "new")];
    const index = await SearchIndex.open(loadCore);
    try {
      expect(() => index.build(both)).toThrow(/already in this index/);
      index.reset();
      expect(() => index.build(newestPerDocument(both))).not.toThrow();
    } finally {
      index.close();
    }
  });
});
