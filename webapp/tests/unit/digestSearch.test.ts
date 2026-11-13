// @vitest-environment happy-dom
// Digests in the library's search (`pages/digest/digestSearch.ts`): their rows
// for the index, the order found ones come in, and their group.

import { describe, it, expect } from "vitest";
import type { Digest, DigestSnapshot } from "../../src/api/digestTypes";
import { digestHits, digestRows, foundDigests } from "../../src/pages/digest/digestSearch";

const digest = (p: Partial<Digest> & { id: string }): Digest => ({
  text: "x",
  comment: null,
  categoryUid: "",
  author: null,
  createdAt: 0,
  modifiedAt: 0,
  source: { kind: "document", path: "Document/Lease.pdf", fileId: "7", page: 3, changed: false },
  note: null,
  waiting: false,
  ...p,
});
const snap = (digests: Digest[], enabled = true): DigestSnapshot => ({
  enabled,
  categories: [{ uid: "home", name: "Home" }],
  digests,
  tabletSyncedAt: null,
  waiting: false,
});

describe("digests' rows", () => {
  it("one per digest: passage, comment, category and source, each a field", () => {
    const rows = digestRows(snap([digest({ id: "1", text: "May sublet", comment: "Ask first", categoryUid: "home" })]));
    expect(rows).toEqual([{ key: "1", text: "May sublet\x1fAsk first\x1fHome\x1fLease" }]);
  });

  it("no comment, Uncategorized, typed on the tablet: only what there is", () => {
    const rows = digestRows(snap([digest({ id: "2", text: "Call the plumber", source: { kind: "manual", path: null, fileId: null, page: null, changed: false } })]));
    expect(rows).toEqual([{ key: "2", text: "Call the plumber" }]);
  });

  it("none when digest sync is off", () => {
    expect(digestRows(snap([digest({ id: "1" })], false))).toEqual([]);
  });
});

describe("digests found", () => {
  it("newest first, and only those the index named", () => {
    const s = snap([digest({ id: "old", createdAt: 1 }), digest({ id: "new", createdAt: 2 }), digest({ id: "other", createdAt: 3 })]);
    expect(foundDigests(s, ["old", "new", "gone"]).map((d) => d.id)).toEqual(["new", "old"]);
  });
});

describe("the Digests group", () => {
  const s = snap([digest({ id: "1", text: "The tenant may sublet the flat.", comment: "Ask before the summer", categoryUid: "home" })]);

  it("says how many, marks the words in the passage and the comment, and where it came from", () => {
    const g = digestHits(s, s.digests, "sublet summer", [], () => {})!;
    expect(g.querySelector(".section-head")?.textContent).toBe("1 digest");
    expect([...g.querySelectorAll(".digest-hit__text mark")].map((m) => m.textContent)).toEqual(["sublet"]);
    expect([...g.querySelectorAll(".digest-hit__comment mark")].map((m) => m.textContent)).toEqual(["summer"]);
    expect(g.querySelector(".digest-hit__meta")?.textContent).toBe("Home · Lease, page 3");
    expect(g.querySelector("a")?.getAttribute("href")).toBe("#/digest/all/d/1");
  });

  it("marks the typo ladder's spelling, not the typed one", () => {
    const g = digestHits(s, s.digests, "sublte", [{ typed: "sublte", matched: "sublet" }], () => {})!;
    expect([...g.querySelectorAll(".digest-hit__text mark")].map((m) => m.textContent)).toEqual(["sublet"]);
  });

  it("is null when none matched", () => {
    expect(digestHits(s, [], "x", [], () => {})).toBeNull();
  });
});
