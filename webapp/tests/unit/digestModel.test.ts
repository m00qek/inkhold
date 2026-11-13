// The Digest page's places, URLs, grouping and order.

import { describe, it, expect } from "vitest";
import type { Digest, DigestSnapshot } from "../../src/api/digestTypes";
import { categoryName, categoryRows, changedLine, digestPlace, digestsIn, fileDigests, fileName, opensAtPage, parsePlace, placePath, sourceGroups, sourceLine, viewTitle, type DigestPlace } from "../../src/pages/digest/digestModel";
import { shorten } from "../../src/core/passage";

const d = (id: string, p: Partial<Digest> & { path?: string | null; page?: number | null; kind?: Digest["source"]["kind"] } = {}): Digest => ({
  id, text: `text ${id}`, comment: null, categoryUid: "", author: null, createdAt: Number(id), modifiedAt: Number(id), note: null, waiting: false,
  source: { kind: p.kind ?? "document", path: p.path === undefined ? "Document/a.pdf" : p.path, fileId: null, page: p.page === undefined ? 1 : p.page, changed: false },
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
    ["", { view: { kind: "categories" }, digest: null }],
    ["all", { view: { kind: "category", uid: null }, digest: null }],
    ["uncategorized", { view: { kind: "category", uid: "" }, digest: null }],
    ["category/kb-phon", { view: { kind: "category", uid: "kb-phon" }, digest: null }],
    ["sources", { view: { kind: "sources" }, digest: null }],
    ["sources/MyStyle%2FFran%C3%A7ais%2Fa%20b.pdf", { view: { kind: "source", key: "MyStyle/Français/a b.pdf" }, digest: null }],
    ["sources/manual", { view: { kind: "source", key: "manual" }, digest: null }],
    ["all/d/12", { view: { kind: "category", uid: null }, digest: "12" }],
    ["category/kb-phon/d/12", { view: { kind: "category", uid: "kb-phon" }, digest: "12" }],
    ["sources/MyStyle%2Fa.pdf/d/3", { view: { kind: "source", key: "MyStyle/a.pdf" }, digest: "3" }],
  ];

  it("reads every place and writes it back the same", () => {
    for (const [path, place] of places) {
      expect(parsePlace(path)).toEqual(place);
      expect(placePath(place)).toBe(path);
    }
  });

  it("reads anything else as the categories' overview, where no digest opens", () => {
    const overview = { view: { kind: "categories" }, digest: null };
    expect(parsePlace("nonsense")).toEqual(overview);
    expect(parsePlace("category")).toEqual(overview);
    expect(parsePlace("category/a/b/d/4")).toEqual(overview);
    expect(parsePlace("sources/d/4")).toEqual({ view: { kind: "sources" }, digest: null });
    expect(parsePlace("sources/%E0%A4%A")).toEqual({ view: { kind: "source", key: "%E0%A4%A" }, digest: null });
  });

  it("reads a bare d/<id>, the page's links before the overviews, as the digest open in All", () => {
    expect(parsePlace("d/12")).toEqual({ view: { kind: "category", uid: null }, digest: "12" });
    expect(placePath({ view: { kind: "categories" }, digest: "12" })).toBe("");
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

  it("documents and notes are one section, by name across both", () => {
    const mixed = snap([d("1", { path: "Document/m.pdf" }), d("2", { path: "Note/Aufgaben.note", kind: "note" }), d("3", { path: "Document/z.pdf" })]);
    expect(sourceGroups(mixed).map((g) => g.name)).toEqual(["Aufgaben", "m", "z"]);
  });

  it("a document's digests in page order, unknown pages last, ties in the order made", () => {
    expect(digestsIn(s, { kind: "source", key: "Document/b.pdf" }).map((x) => x.id)).toEqual(["4", "7", "1", "6"]);
    // An overview lists cards, not digests.
    expect(digestsIn(s, { kind: "sources" })).toEqual([]);
    expect(sourceGroups(s).flatMap((g) => g.digests).map((x) => x.id)).toEqual(["5", "4", "7", "1", "6", "2", "3"]);
  });

  it("names a view, or nothing for one that is gone", () => {
    expect(viewTitle(s, { kind: "source", key: "Note/n.note" })).toBe("n");
    expect(viewTitle(s, { kind: "sources" })).toBe("Sources");
    expect(viewTitle(s, { kind: "categories" })).toBe("Categories");
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

describe("a file's digests, for its viewer", () => {
  it("only that file's, in page order; never one typed on the tablet", () => {
    const f = (id: string, fileId: string | null, page: number | null, kind: Digest["source"]["kind"] = "document"): Digest => {
      const x = d(id, { kind, page, path: kind === "manual" ? null : "Document/a.pdf" });
      return { ...x, source: { ...x.source, fileId } };
    };
    const s = snap([f("1", "57", 3), f("2", "58", 1), f("3", "57", 1), f("4", "57", null), f("5", "57", 1, "manual")]);
    expect(fileDigests(s, "57").map((x) => x.id)).toEqual(["3", "1", "4"]);
    expect(fileDigests(s, "99")).toEqual([]);
    expect(digestPlace(s.digests[0]!)).toEqual({ view: { kind: "source", key: "Document/a.pdf" }, digest: "1" });
  });
});

describe("opening a digest's source", () => {
  const at = (path: string, fileId: string | null = "9") => ({ ...d("1", { path }), source: { ...d("1", { path }).source, fileId } });

  it("a PDF or a note opens at its page; an EPUB, or a file not in the library, does not", () => {
    expect(opensAtPage(at("Document/a.PDF"))).toBe(true);
    expect(opensAtPage(at("Note/n.note"))).toBe(true);
    expect(opensAtPage(at("Document/book.epub"))).toBe(false);
    expect(opensAtPage(at("Document/a.pdf", null))).toBe(false);
  });
});

describe("a passage made short for a list", () => {
  it("is kept whole when it fits, its spaces made one", () => {
    expect(shorten("a  b\n\nc ")).toBe("a b c");
  });

  it("is cut at a word, and says so", () => {
    const long = "word ".repeat(100);
    const out = shorten(long, 22);
    expect(out).toBe("word word word word…");
    expect(out.length).toBeLessThanOrEqual(23);
  });
});

describe("a digest from a changed file", () => {
  it("names its page, or, without one, says the passage may have moved", () => {
    expect(changedLine(d("1", { page: 4 }))).toBe("This file has changed since the digest was taken: page 4 may no longer hold the passage.");
    expect(changedLine(d("1", { page: null }))).toBe("This file has changed since the digest was taken: the passage may have moved.");
  });
});
