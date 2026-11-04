// @vitest-environment happy-dom

import { describe, it, expect } from "vitest";
import { fold } from "../../src/search/fold";
import {
  byteToCharMap,
  resolveFindSegments,
  totalMatches,
  txtCountText,
  markParagraph,
  buildFindContent,
} from "../../src/pages/txt/txtFind";
import type { TxtSegmentMatch } from "../../src/pages/txt/txtFind";

describe("fold", () => {
  it("strips diacritics and lowercases, like the index", () => {
    expect(fold("Avaliação")).toBe("avaliacao");
    expect(fold("CAFÉ")).toBe("cafe");
  });
});

describe("byteToCharMap", () => {
  it("maps ASCII byte offsets one-to-one", () => {
    const text = "hello world";
    const m = byteToCharMap(text, [0, 6, 11]);
    expect(m.get(0)).toBe(0);
    expect(m.get(6)).toBe(6);
    expect(m.get(11)).toBe(11);
  });

  it("accounts for multi-byte characters BEFORE the offset (the whole hazard)", () => {
    // "é" is 2 UTF-8 bytes but 1 UTF-16 unit, so offsets diverge after it.
    const text = "café latte";
    // byte offset of "latte": c(1)a(1)f(1)é(2)space(1) = 6 bytes; char index 5.
    const m = byteToCharMap(text, [6]);
    expect(m.get(6)).toBe(5);
    expect(text.slice(5)).toBe("latte");
  });

  it("resolves an offset past the end to the end of the string", () => {
    const text = "abc";
    expect(byteToCharMap(text, [99]).get(99)).toBe(3);
  });
});

describe("resolveFindSegments", () => {
  it("turns byte ranges into char ranges and folds the terms", () => {
    const text = "café here.\n\nplain tail.";
    // "plain tail." starts at byte 13 (café = 5 bytes + " here.\n\n" = 8), char 12.
    const segs: TxtSegmentMatch[] = [{ segment: 1, offset: 13, length: 11, matches: 1, terms: ["Plain"] }];
    const [r] = resolveFindSegments(text, segs);
    expect(text.slice(r!.startChar, r!.endChar)).toBe("plain tail.");
    expect(r!.terms.has("plain")).toBe(true);
  });
});

describe("totalMatches / txtCountText", () => {
  it("sums the index's per-paragraph counts — the exact N", () => {
    expect(totalMatches([{ matches: 1 }, { matches: 2 }, { matches: 1 }])).toBe(4);
  });

  it('reads "N matches in M paragraphs", singular-aware', () => {
    expect(txtCountText(4, 2)).toBe("4 matches in 2 paragraphs");
    expect(txtCountText(1, 1)).toBe("1 match in 1 paragraph");
    expect(txtCountText(0, 0)).toBe("No matches");
  });
});

describe("markParagraph", () => {
  it("wraps ONLY the words whose fold is a counted term, and counts them", () => {
    const wrap = markParagraph("The zephyrine and the zephyrine tea.", new Set(["zephyrine"]));
    const marks = wrap.querySelectorAll("mark");
    expect(marks).toHaveLength(2);
    expect([...marks].map((m) => m.textContent)).toEqual(["zephyrine", "zephyrine"]);
    expect(wrap.textContent).toBe("The zephyrine and the zephyrine tea.");
  });

  it("marks by the FOLDED term, so an accented word matches an unaccented term", () => {
    const wrap = markParagraph("uma linha sobre café aqui", new Set(["cafe"]));
    expect(wrap.querySelector("mark")!.textContent).toBe("café");
  });

  it("marks nothing when the terms are empty (a match it cannot point at)", () => {
    const wrap = markParagraph("nothing here", new Set<string>());
    expect(wrap.querySelector("mark")).toBeNull();
    expect(wrap.textContent).toBe("nothing here");
  });
});

describe("buildFindContent", () => {
  it("wraps each matching paragraph in a .txt__match, leaving the gaps plain", () => {
    const text = "one alpha.\n\ntwo beta.\n\nthree alpha.";
    const segs = [
      { segment: 0, startChar: 0, endChar: 10, terms: new Set(["alpha"]), matches: 1 },
      { segment: 2, startChar: 23, endChar: 35, terms: new Set(["alpha"]), matches: 1 },
    ];
    const { nodes, paras } = buildFindContent(text, segs);
    expect(paras).toHaveLength(2);
    expect(paras[0]!.querySelector("mark")!.textContent).toBe("alpha");
    expect(paras[1]!.querySelector("mark")!.textContent).toBe("alpha");
    const rebuilt = nodes.map((n) => n.textContent).join("");
    expect(rebuilt).toBe(text);
  });
});
