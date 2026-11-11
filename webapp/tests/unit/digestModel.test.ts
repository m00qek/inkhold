// The Digest page's places, URLs, grouping and order.

import { describe, it, expect } from "vitest";
import type { Digest, DigestSnapshot } from "../../src/api/digestTypes";
import {
  categoryName, categoryRows, digestsIn, fileName, parsePlace, placePath, sourceGroups, sourceLine, viewTitle, type DigestPlace,
} from "../../src/pages/digest/digestModel";

const d = (id: string, p: Partial<Digest> & { path?: string | null; page?: number | null; kind?: Digest["source"]["kind"] } = {}): Digest => ({
  id, text: `text ${id}`, comment: null, categoryUid: "", author: null, createdAt: Number(id), note: null, waiting: false,
  source: { kind: p.kind ?? "document", path: p.path === undefined ? "Document/a.pdf" : p.path, fileId: null, page: p.page === undefined ? 1 : p.page },
  ...p,
});

const snap = (digests: Digest[]): DigestSnapshot => ({
  enabled: true,
  tabletSyncedAt: null,
  waiting: false,
  categories: [{ uid: "kb-phon", name: "Phonétique" }, { uid: "kb-empty", name: "" }],
  digests,
});

describe("a place in the URL", () => {
  const places: [string, DigestPlace][] = [
    ["", { view: { kind: "category", uid: null }, digest: null }],
    ["uncategorized", { view: { kind: "category", uid: "" }, digest: null }],
    ["category/kb-phon", { view: { kind: "category", uid: "kb-phon" }, digest: null }],
    ["sources", { view: { kind: "source", key: null }, digest: null }],
    ["sources/MyStyle%2FFran%C3%A7ais%2Fa%20b.pdf", { view: { kind: "source", key: "MyStyle/Français/a b.pdf" }, digest: null }],
    ["sources/manual", { view: { kind: "source", key: "manual" }, digest: null }],
    ["d/12", { view: { kind: "category", uid: null }, digest: "12" }],
    ["category/kb-phon/d/12", { view: { kind: "category", uid: "kb-phon" }, digest: "12" }],
    ["sources/MyStyle%2Fa.pdf/d/3", { view: { kind: "source", key: "MyStyle/a.pdf" }, digest: "3" }],
  ];

  it("reads every place and writes it back the same", () => {
    for (const [path, place] of places) {
      expect(parsePlace(path)).toEqual(place);
      expect(placePath(place)).toBe(path);
    }
  });

  it("reads anything else as All, keeping a digest it names", () => {
    expect(parsePlace("nonsense")).toEqual({ view: { kind: "category", uid: null }, digest: null });
    expect(parsePlace("category")).toEqual({ view: { kind: "category", uid: null }, digest: null });
    expect(parsePlace("category/a/b/d/4")).toEqual({ view: { kind: "category", uid: null }, digest: "4" });
    expect(parsePlace("sources/%E0%A4%A")).toEqual({ view: { kind: "source", key: "%E0%A4%A" }, digest: null });
  });
});

describe("categories", () => {
  it("All, Uncategorized, then the person's in their order, empty ones too, counted", () => {
    const s = snap([d("1"), d("2", { categoryUid: "kb-phon" }), d("3", { categoryUid: "kb-phon" })]);
    expect(categoryRows(s)).toEqual([
      { uid: null, name: "All", count: 3 },
      { uid: "", name: "Uncategorized", count: 1 },
      { uid: "kb-phon", name: "Phonétique", count: 2 },
      { uid: "kb-empty", name: "Untitled category", count: 0 },
    ]);
  });

  it("a category lists newest first", () => {
    const s = snap([d("1", { categoryUid: "kb-phon" }), d("3", { categoryUid: "kb-phon" }), d("2")]);
    expect(digestsIn(s, { kind: "category", uid: "kb-phon" }).map((x) => x.id)).toEqual(["3", "1"]);
    expect(digestsIn(s, { kind: "category", uid: null }).map((x) => x.id)).toEqual(["3", "2", "1"]);
    expect(categoryName(s, s.digests[0]!)).toBe("Phonétique");
    expect(categoryName(s, s.digests[2]!)).toBe("Uncategorized");
  });
});

describe("sources", () => {
  const s = snap([
    d("1", { path: "Document/b.pdf", page: 7 }),
    d("2", { path: "Note/n.note", kind: "note", page: 2 }),
    d("3", { path: null, kind: "manual", page: null }),
    d("4", { path: "Document/b.pdf", page: 1 }),
    d("5", { path: "Document/a.epub", page: null }),
    d("6", { path: "Document/b.pdf", page: null }),
    d("7", { path: "Document/b.pdf", page: 1 }),
  ]);

  it("documents, notes, then what was typed on the tablet; by name within each", () => {
    expect(sourceGroups(s).map((g) => [g.kind, g.name])).toEqual([
      ["document", "a"], ["document", "b"], ["note", "n"], ["manual", "Typed on the tablet"],
    ]);
  });

  it("a document's digests in page order, unknown pages last, ties in the order made", () => {
    expect(digestsIn(s, { kind: "source", key: "Document/b.pdf" }).map((x) => x.id)).toEqual(["4", "7", "1", "6"]);
    expect(digestsIn(s, { kind: "source", key: null }).map((x) => x.id)).toEqual(["5", "4", "7", "1", "6", "2", "3"]);
  });

  it("names a view, or nothing for one that is gone", () => {
    expect(viewTitle(s, { kind: "source", key: "Note/n.note" })).toBe("n");
    expect(viewTitle(s, { kind: "source", key: null })).toBe("Sources");
    expect(viewTitle(s, { kind: "category", uid: "kb-phon" })).toBe("Phonétique");
    expect(viewTitle(s, { kind: "source", key: "Document/gone.pdf" })).toBeNull();
    expect(viewTitle(s, { kind: "category", uid: "kb-gone" })).toBeNull();
  });

  it("says where a digest came from", () => {
    expect(sourceLine(s.digests[0]!)).toBe("b, page 7");
    expect(sourceLine(s.digests[2]!)).toBe("Typed on the tablet");
    expect(sourceLine(s.digests[4]!)).toBe("a");
    expect(fileName("MyStyle/Français/La_phonetique.pdf")).toBe("La_phonetique");
    expect(fileName("Note/.hidden")).toBe(".hidden");
  });
});
