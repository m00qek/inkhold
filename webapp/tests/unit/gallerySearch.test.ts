// @vitest-environment happy-dom

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createGallerySearch, type GallerySearchCtx } from "../../src/pages/gallerySearch";
import { nameRows } from "../../src/pages/library/searchItems";
import { SearchIndex, type SearchCoreExports } from "../../src/search/indexEngine";
import type { SearchState } from "../../src/pages/noteSearch";
import type { SearchResult } from "../../src/pages/galleryCards";
import type { Entry, Id, Listing, NoteSummary } from "../../src/core/types";
import type { Expansion, LocalHit } from "../../src/search/localSearch";

function doc(fileId: number, pages: number[], updatedAt = 0): LocalHit {
  return { md5: `md5-${fileId}`, fileId, pages, updatedAt, tier: "note", pageCount: null };
}

function note(id: string, name: string, fileType = "note"): NoteSummary {
  return {
    kind: "note",
    id,
    name,
    pageCount: 1,
    firstPage: { index: 0, hash: null },
    updatedAt: 0,
    fileType,
    fileHash: null,
    hasRecognizedText: true,
  } as NoteSummary;
}

function listing(entries: Entry[]): Listing {
  return { folderId: null, path: [], entries, syncVersion: 1 };
}

/** The index's answer; `names` are the name rows it matched (`n:<id>`, `f:<id>`). */
function results(query: string, documents: LocalHit[], expansions: Expansion[] = [], names: string[] = []): SearchState {
  return { kind: "results", query, documents, expansions, items: { name: names, todo: [], digest: [] } };
}

/** The renderer with every collaborator stubbed; `resultCard` records the join. */
function harness(initial: { state: SearchState; pending: number | null; tree?: Entry[]; treeLoaded?: boolean; more?: () => HTMLElement }) {
  const gallery = document.createElement("section");
  let state = initial.state;
  let pending = initial.pending;
  const tree = initial.tree ?? [];
  const built: SearchResult[] = [];
  const handed: (readonly Expansion[] | undefined)[] = [];

  const ctx: GallerySearchCtx = {
    gallery,
    getSearchState: () => state,
    folders: { values: () => (tree.length === 0 ? [] : [listing(tree)]) },
    treeLoaded: () => initial.treeLoaded ?? true,
    labelFor: (f) => f.name,
    resultCard: (r, _i, _q, expansions) => {
      built.push(r);
      handed.push(expansions);
      const card = document.createElement("article");
      card.className = "card--result";
      card.textContent = r.note.name;
      return card;
    },
    folderCard: (f) => {
      const card = document.createElement("article");
      card.className = "card--folder";
      card.textContent = f.name;
      return card;
    },
    emptyState: (title, body) => {
      const box = document.createElement("div");
      box.className = "empty";
      box.dataset["title"] = title;
      box.textContent = body;
      return box;
    },
    indexPending: () => pending,
    moreResults: initial.more ? () => initial.more!() : undefined,
  };

  const search = createGallerySearch(ctx);
  return {
    gallery,
    built,
    handed,
    paint(q = "rutabaga") {
      gallery.replaceChildren();
      built.length = 0;
      handed.length = 0;
      search.renderSearch(q);
      return gallery;
    },
    setPending(n: number | null) {
      pending = n;
    },
    setState(next: SearchState) {
      state = next;
    },
    emptyBody: () => gallery.querySelector(".empty")?.textContent ?? "",
    head: () => gallery.querySelector(".section-head")?.textContent ?? "",
    notices: () => [...gallery.querySelectorAll(".hits__notice")].map((n) => n.textContent),
    matchedWords: () => [...gallery.querySelectorAll(".hits__matched")].map((n) => n.textContent),
    rows: () => [...gallery.querySelectorAll(".card--result")].map((n) => n.textContent),
    folderRows: () => [...gallery.querySelectorAll(".card--folder")].map((n) => n.textContent),
  };
}

describe("the join between a hit and the listing", () => {
  it("names a transcript hit from the cached tree and counts its pages", () => {
    const h = harness({
      state: results("aurora", [doc(7, [2, 5, 9])]),
      pending: 0,
      tree: [note("7", "Weekly review")],
    });
    h.paint("aurora");

    expect(h.rows()).toEqual(["Weekly review"]);
    expect(h.built[0]?.pages).toEqual([2, 5, 9]);
    expect(h.built[0]?.nameMatched).toBe(false);
  });

  // The local index may be a superset of the library; only the listing names a row.
  it("DROPS a hit the listing does not name rather than rendering it anonymously", () => {
    const h = harness({
      state: results("aurora", [doc(7, [1]), doc(404, [1, 2])]),
      pending: 0,
      tree: [note("7", "Weekly review")],
    });
    h.paint("aurora");

    expect(h.rows()).toEqual(["Weekly review"]);
    expect(h.head()).toContain("1 note");
  });

  // `files.id` is a number in the index and a decimal string in the listing.
  it("joins the index's numeric file id to the listing's string id", () => {
    const h = harness({ state: results("aurora", [doc(12, [0])]), pending: 0, tree: [note("12", "Twelve")] });
    h.paint("aurora");
    expect(h.rows()).toEqual(["Twelve"]);
  });

  it("takes the segment kind from the listing's file type, not from the hit", () => {
    const h = harness({
      state: results("readme", [doc(1, [3]), doc(2, [4])]),
      pending: 0,
      tree: [note("1", "readme", "txt"), note("2", "Weekly review", "note")],
    });
    h.paint("readme");

    expect(h.built.find((r) => r.noteId === "1")?.kind).toBe(1);
    expect(h.built.find((r) => r.noteId === "2")?.kind).toBe(0);
  });
});

describe("the name half of the query", () => {
  it("still merges filename matches that no transcript hit named", () => {
    const h = harness({
      state: results("rut", [doc(7, [1])], [], ["n:8"]),
      pending: 0,
      tree: [note("7", "Weekly review"), note("8", "Rutabaga plans")],
    });
    h.paint("rut");

    expect(h.rows()).toEqual(["Rutabaga plans", "Weekly review"]);
    expect(h.built.find((r) => r.noteId === "8")?.pages).toEqual([]);
  });

  it("marks a document that matched BOTH ways once, as a name match", () => {
    const h = harness({
      state: results("weekly", [doc(7, [1, 2])], [], ["n:7"]),
      pending: 0,
      tree: [note("7", "Weekly review")],
    });
    h.paint("weekly");

    expect(h.rows()).toEqual(["Weekly review"]);
    expect(h.built[0]?.nameMatched).toBe(true);
    expect(h.built[0]?.pages).toEqual([1, 2]);
  });

  it("puts name matches first and otherwise keeps the engine's rank order", () => {
    const h = harness({
      state: results("plan", [doc(1, [0, 1, 2]), doc(2, [5])], [], ["n:3"]),
      pending: 0,
      tree: [note("1", "Alpha"), note("2", "Beta"), note("3", "Plan B")],
    });
    h.paint("plan");

    expect(h.rows()).toEqual(["Plan B", "Alpha", "Beta"]);
  });
});

describe("no continuation", () => {
  it("paints no 'More results' affordance, whatever the result size", () => {
    const h = harness({
      state: results("a", [doc(1, [0]), doc(2, [1]), doc(3, [2])]),
      pending: 0,
      tree: [note("1", "One"), note("2", "Two"), note("3", "Three")],
    });
    h.paint("a");

    expect(h.gallery.querySelector(".hits__more")).toBeNull();
    expect(h.gallery.textContent).not.toContain("More results");
  });

  it("states the counts plainly, with no '+' floors", () => {
    const h = harness({
      state: results("a", [doc(1, [0, 1]), doc(2, [4])]),
      pending: 0,
      tree: [note("1", "One"), note("2", "Two")],
    });
    h.paint("a");

    expect(h.head()).toContain("2 notes · 3 pages");
    expect(h.head()).not.toContain("+");
  });

  it("counts only documents when nothing matched by transcript", () => {
    const h = harness({ state: results("one", []), pending: 0, tree: [note("1", "One")] });
    h.paint("one");
    expect(h.head()).toContain("1 note");
    expect(h.head()).not.toContain("page");
  });
});

describe("what the results say about a corrected query", () => {
  const CORRECTED: Expansion[] = [{ typed: "valjaen", matched: "valjean" }];

  // Once above the list: the expansion is per token and false for name matches.
  it("says it once above the list, and never on a row", () => {
    const h = harness({
      state: results("valjaen", [doc(1, [0, 4]), doc(2, [7])], CORRECTED),
      pending: 0,
      tree: [note("1", "One"), note("2", "Two")],
    });
    h.paint("valjaen");

    expect(h.notices()).toEqual(["Matched valjean instead of “valjaen”."]);
    expect(h.matchedWords()).toEqual(["valjean"]);
    expect(h.rows()).toEqual(["One", "Two"]);
  });

  it("says nothing when the query as typed is what answered", () => {
    const h = harness({ state: results("aurora", [doc(1, [0])]), pending: 0, tree: [note("1", "One")] });
    h.paint("aurora");
    expect(h.notices()).toEqual([]);
  });

  it("comes before the completeness caveat, and before the counts", () => {
    const h = harness({
      state: results("valjaen", [doc(1, [0])], CORRECTED),
      pending: 2,
      tree: [note("1", "One")],
    });
    h.paint("valjaen");

    expect(h.notices()).toEqual([
      "Matched valjean instead of “valjaen”.",
      "More may appear — 2 documents are still being indexed.",
    ]);
    const order = [...h.gallery.children].map((n) => n.className);
    expect(order.indexOf("hits__notice")).toBeLessThan(order.indexOf("section-head"));
  });

  // The renderer intersects again, so it can drop every hit the expansion produced.
  it("stays silent when every row it could explain fell out of the listing join", () => {
    const h = harness({
      // Document 404 is not in the tree; "One" matches by name.
      state: results("valjaen", [doc(404, [1, 2])], CORRECTED),
      pending: 0,
      tree: [note("1", "valjaen plans")],
    });
    h.paint("valjaen");

    expect(h.rows()).toEqual(["valjaen plans"]);
    expect(h.notices()).toEqual([]);
  });

  it("stays silent over an empty result set, where it would contradict 'No matches'", () => {
    const h = harness({ state: results("valjaen", [], CORRECTED), pending: 0, tree: [note("1", "One")] });
    h.paint("valjaen");

    expect(h.notices()).toEqual([]);
    expect(h.emptyBody()).not.toContain("valjean");
  });

  // Both halves are device-authored, so nodes, never markup.
  it("builds the sentence from text, so neither half can be markup", () => {
    const h = harness({
      state: results("<b>x</b>", [doc(1, [0])], [{ typed: "<b>x</b>", matched: "<i>y</i>" }]),
      pending: 0,
      tree: [note("1", "One")],
    });
    h.paint("<b>x</b>");

    const notice = h.gallery.querySelector(".hits__notice")!;
    expect(notice.textContent).toBe("Matched <i>y</i> instead of “<b>x</b>”.");
    expect(notice.querySelector("i")).toBeNull();
    expect(notice.querySelector("b")).toBeNull();
  });

  it("hands the substitution to each row, for its deep link", () => {
    const h = harness({
      state: results("valjaen", [doc(1, [0])], CORRECTED),
      pending: 0,
      tree: [note("1", "One")],
    });
    h.paint("valjaen");
    expect(h.handed).toEqual([CORRECTED]);
  });
});

describe("a search that failed", () => {
  it("says so, distinctly from 'no matches'", () => {
    const h = harness({ state: { kind: "error", query: "aurora" }, pending: 0, tree: [note("1", "One")] });
    h.paint("aurora");
    expect(h.gallery.querySelector(".empty")?.getAttribute("data-title")).toBe("Couldn't search");
  });

  // The index raises while the cached tree is still empty: early, not broken.
  it("reads as still searching while the tree walk has not finished", () => {
    const h = harness({ state: { kind: "error", query: "aurora" }, pending: 0, treeLoaded: false });
    h.paint("aurora");
    expect(h.gallery.querySelector(".empty")?.getAttribute("data-title")).toBe("Searching…");
  });
});

describe("the search renderer's pending sentences", () => {
  it("says a zero-hit search is still indexing rather than leaving 'No matches' unqualified", () => {
    const h = harness({ state: results("rutabaga", []), pending: 3 });
    h.paint();
    expect(h.emptyBody()).toContain("3 documents are still being indexed");
  });

  it("says BOTH sentences when both apply, pending first", () => {
    const h = harness({ state: results("rutabaga", []), pending: 2 });
    h.paint();
    const body = h.emptyBody();
    expect(body).toContain("2 documents are still being indexed");
    expect(body).toContain("Only notes recognised on the device are searchable.");
    expect(body.indexOf("still being indexed")).toBeLessThan(body.indexOf("recognised"));
  });

  it("falls back to the coverage sentence alone when nothing is outstanding", () => {
    const h = harness({ state: results("rutabaga", []), pending: 0 });
    h.paint();
    expect(h.emptyBody()).toBe("Only notes recognised on the device are searchable.");
  });

  it("qualifies a NON-EMPTY page from the live channel, which is now the only source", () => {
    const h = harness({ state: results("rutabaga", [doc(7, [0])]), pending: 2, tree: [note("7", "Notes")] });
    h.paint();
    expect(h.notices()).toContain("More may appear — 2 documents are still being indexed.");
  });

  it("says nothing over results when nothing is outstanding, and nothing when the server never said", () => {
    const withHits = results("rutabaga", [doc(7, [0])]);
    const tree = [note("7", "Notes")];

    const zero = harness({ state: withHits, pending: 0, tree });
    zero.paint();
    expect(zero.notices()).toEqual([]);

    // `null` means the server did not say; it must read as silence.
    const silent = harness({ state: withHits, pending: null, tree });
    silent.paint();
    expect(silent.notices()).toEqual([]);
  });

  it("follows the live channel — a frame that changes the count changes the next paint", () => {
    const h = harness({ state: results("rutabaga", [doc(7, [0])]), pending: 3, tree: [note("7", "Notes")] });
    h.paint();
    expect(h.notices()).toEqual(["More may appear — 3 documents are still being indexed."]);

    h.setPending(0);
    h.paint();
    expect(h.notices()).toEqual([]);
  });

  it("says nothing about indexing when the search itself failed", () => {
    const h = harness({ state: { kind: "error", query: "rutabaga" }, pending: 5 });
    h.paint();
    expect(h.emptyBody()).not.toContain("still being indexed");
    expect(h.notices()).toEqual([]);
  });
});

describe("names follow the index's rule", () => {
  const folder = (id: string, name: string): Entry => ({ kind: "folder", id, name }) as Entry;
  const idle: SearchState = results("x", []);
  // From the working directory: under happy-dom `import.meta.url` is not a file URL.
  const wasm = readFileSync(resolve("public/sqlite-core.wasm"));

  /** The renderer over the real index (`sqlite-core.wasm`), holding the tree's names. */
  async function indexed(tree: Entry[]) {
    const h = harness({ state: idle, pending: 0, tree });
    const index = await SearchIndex.open(async () => {
      const { instance } = await WebAssembly.instantiate(wasm, {});
      const core = instance.exports as unknown as SearchCoreExports;
      core._initialize?.();
      return core;
    });
    index.build([]);
    index.setItems("name", nameRows({ values: () => [listing(tree)] }, (f) => f.name));
    return {
      ...h,
      paint(q: string) {
        const r = index.query(q, 1000, true);
        h.setState(results(q, [], r.expansions, r.items.map((i) => i.key)));
        return h.paint(q);
      },
    };
  }

  it("ignores accents and case, and takes the words in any order", async () => {
    const h = await indexed([note("1", "Reunião de pais"), note("2", "Haus of gabin"), note("3", "Ideias")]);
    h.paint("reuniao");
    expect(h.rows()).toEqual(["Reunião de pais"]);
    h.paint("gabin haus");
    expect(h.rows()).toEqual(["Haus of gabin"]);
  });

  it("the last word may be the start of one; the others are whole words", async () => {
    const h = await indexed([note("1", "Haus of gabin")]);
    h.paint("haus gab");
    expect(h.rows()).toEqual(["Haus of gabin"]);
    h.paint("hau gabin");
    expect(h.rows()).toEqual([]);
  });

  it("falls back to the text inside a name only when no name matched by words", async () => {
    const h = await indexed([note("1", "MyStyle"), note("2", "Style guide")]);
    // "style" is a word of "Style guide": the word rule answers, alone.
    h.paint("style");
    expect(h.rows()).toEqual(["Style guide"]);
    // No name has the word "tyle": then anywhere inside a name.
    h.paint("tyle");
    expect(h.rows()).toEqual(["MyStyle", "Style guide"]);
  });

  it("finds folders by name, in their own group before the notes", async () => {
    const h = await indexed([folder("f1", "Aulas de Francês"), note("1", "Francês 3")]);
    const g = h.paint("frances");
    expect(h.folderRows()).toEqual(["Aulas de Francês"]);
    expect(h.rows()).toEqual(["Francês 3"]);
    expect(g.querySelector(".section-head")?.textContent).toBe("1 folder");
    // The folders' heading, then their list.
    expect(g.querySelector(".section-head + ul.cards > .card--folder")?.textContent).toBe("Aulas de Francês");
  });

  it("a folder alone is an answer, not 'no matches'", async () => {
    const h = await indexed([folder("f1", "Receitas")]);
    h.paint("receitas");
    expect(h.folderRows()).toEqual(["Receitas"]);
    expect(h.gallery.querySelector(".empty")).toBeNull();
  });
});

describe("where the to-dos go", () => {
  const todos = () => {
    const box = document.createElement("section");
    box.className = "todo-hits";
    return box;
  };
  const order = (g: HTMLElement) => [...g.children].map((c) => (c.className === "todo-hits" ? "todos" : c.textContent));

  it("before the first document that is neither named like the query nor written by the person", () => {
    const book = { ...doc(2, [0]), tier: "other" as const };
    const h = harness({ state: results("q", [doc(1, [0]), book]), pending: 0, tree: [note("1", "Diário"), note("2", "Les Misérables")], more: todos });
    const g = h.paint("valjean");
    expect(order(g).filter((x) => x !== "2 notes · 2 pages")).toEqual(["Diário", "todos", "Les Misérables"]);
  });

  it("at the end when everything found is the person's writing", () => {
    const h = harness({ state: results("q", [doc(1, [0])]), pending: 0, tree: [note("1", "Diário")], more: todos });
    const g = h.paint("valjean");
    expect(order(g).slice(-2)).toEqual(["Diário", "todos"]);
  });
});
