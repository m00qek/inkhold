// @vitest-environment happy-dom

import { describe, it, expect } from "vitest";
import type { Expansion } from "../../src/search/localSearch";
import { doc, harness, note, results } from "./gallerySearch.shared";

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

describe("the typo ladder's notice over the apps' groups", () => {
  const group = () => {
    const box = document.createElement("section");
    box.className = "digest-hits";
    return box;
  };

  const SUBLET: Expansion[] = [{ typed: "sublte", matched: "sublet" }];

  it("is said once, above them, when they came from its spelling", () => {
    const g = harness({ state: results("sublte", [], SUBLET), pending: 0, tree: [note("1", "One")], more: group, moreCorrected: true }).paint("sublte");
    expect(g.querySelectorAll(".hits__notice")).toHaveLength(1);
    expect(g.firstElementChild?.className).toBe("hits__notice");
  });

  it("is not said over a group matched as typed", () => {
    const g = harness({ state: results("sublte", [], SUBLET), pending: 0, tree: [note("1", "One")], more: group }).paint("sublte");
    expect(g.querySelectorAll(".hits__notice")).toHaveLength(0);
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
