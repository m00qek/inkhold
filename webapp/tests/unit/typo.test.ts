// The browser's typo ladder: the index's rules, for to-dos.

import { describe, it, expect } from "vitest";
import { editDistance, maxEdits, nearest } from "../../src/search/typo";

describe("the typo ladder", () => {
  it("allows no edits up to 3 letters, then 1, then 2", () => {
    expect([3, 4, 7, 8].map(maxEdits)).toEqual([0, 1, 1, 2]);
  });

  it("counts a swap as one edit", () => {
    expect(editDistance("ednor", "endor")).toBe(1);
    expect(editDistance("reunião", "reuniao")).toBe(1);
    expect(editDistance("casa", "casa")).toBe(0);
  });

  it("keeps only the nearest tier: distance, then length difference", () => {
    expect(nearest("tset", ["test", "set", "tests"])).toEqual(["test"]);
    expect(nearest("dentsta", ["dentista", "dentes"])).toEqual(["dentista"]);
    expect(nearest("cas", ["casa"])).toEqual([]);
  });
});
