// @vitest-environment happy-dom

import { describe, it, expect } from "vitest";
import type { Expansion } from "../../src/search/localSearch";
import type { Entry } from "../../src/core/types";
import type { SearchState } from "../../src/pages/noteSearch";
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

// The terms budget (`termsBudget.ts`): wherever the answer lands, the person
// learns that some documents were searched by name only, and can see which.
describe("the search renderer's left-out sentence", () => {
  const LINE = "This browser's search has no room for the text of 2 documents";
  const leftOut = (state: SearchState, ids: number[]): SearchState => ({ ...state, leftOut: ids }) as SearchState;
  const folder = (id: string, name: string): Entry => ({ kind: "folder", id, name }) as Entry;
  /** The two left-out books, named by the cached tree. */
  const BOOKS = [note("8", "Moby-Dick", "txt"), note("9", "Ulysses", "pdf")];
  const names = (g: HTMLElement) => [...g.querySelectorAll(".left-out__name")].map((a) => a.textContent);

  it("is a notice over results, with the names under it", () => {
    const h = harness({ state: leftOut(results("whale", [doc(7, [0])]), [8, 9]), pending: 0, tree: [note("7", "Notes"), ...BOOKS] });
    const g = h.paint("whale");
    expect(h.notices().some((n) => n?.startsWith(LINE))).toBe(true);
    const box = g.querySelector("details.left-out");
    expect(box?.previousElementSibling?.textContent).toMatch(new RegExp(`^${LINE}`));
    expect(names(g)).toEqual(["Moby-Dick", "Ulysses"]);
  });

  it("is part of 'No matches', before the coverage sentence, with the names under it", () => {
    const h = harness({ state: leftOut(results("whale", []), [8, 9]), pending: 0, tree: BOOKS });
    const g = h.paint("whale");
    const body = h.emptyBody();
    expect(body).toContain(LINE);
    expect(body.indexOf(LINE)).toBeLessThan(body.indexOf("recognised"));
    expect(g.querySelector(".empty")?.nextElementSibling?.matches("details.left-out")).toBe(true);
    expect(names(g)).toEqual(["Moby-Dick", "Ulysses"]);
  });

  it("is a notice when only folders matched, with the names under it", () => {
    const h = harness({ state: leftOut(results("whale", [], [], ["f:f1"]), [8, 9]), pending: 0, tree: [folder("f1", "Whale"), ...BOOKS] });
    const g = h.paint("whale");
    expect(h.folderRows()).toEqual(["Whale"]);
    expect(h.notices().some((n) => n?.startsWith(LINE))).toBe(true);
    const box = g.querySelector("details.left-out");
    expect(box?.previousElementSibling?.textContent).toMatch(new RegExp(`^${LINE}`));
    expect(names(g)).toEqual(["Moby-Dick", "Ulysses"]);
  });

  it("while the listing loads, counts every id and says the unnamed are not listed yet", () => {
    // The walk has reached the hit's folder only: neither book is named yet.
    const h = harness({ state: leftOut(results("whale", [doc(7, [0])]), [8, 9]), pending: 0, tree: [note("7", "Notes")], treeLoaded: false });
    const g = h.paint("whale");
    expect(h.notices().some((n) => n?.startsWith(LINE))).toBe(true);
    expect(names(g)).toEqual([]);
    expect(g.querySelector(".left-out__rest")?.textContent).toBe("2 more not listed yet");
  });

  it("once the listing has loaded, neither counts nor lists an id it doesn't name: that file has left the library", () => {
    const h = harness({ state: leftOut(results("whale", [doc(7, [0])]), [8, 9]), pending: 0, tree: [note("7", "Notes"), BOOKS[0]!] });
    const g = h.paint("whale");
    expect(h.notices().some((n) => n?.startsWith("This browser's search has no room for the text of 1 document:"))).toBe(true);
    expect(names(g)).toEqual(["Moby-Dick"]);
    expect(g.querySelector(".left-out__rest")).toBeNull();
  });

  it("says nothing once the listing has loaded and every left-out id has left the library", () => {
    const over = harness({ state: leftOut(results("whale", [doc(7, [0])]), [8, 9]), pending: 0, tree: [note("7", "Notes")] });
    const g = over.paint("whale");
    expect(over.notices()).toEqual([]);
    expect(g.querySelector(".left-out")).toBeNull();

    const none = harness({ state: leftOut(results("whale", []), [8, 9]), pending: 0 });
    const e = none.paint("whale");
    expect(none.emptyBody()).not.toContain("no room");
    expect(e.querySelector(".left-out")).toBeNull();
  });

  it("is not said, and nothing is listed, when everything fits", () => {
    const h = harness({ state: results("whale", [doc(7, [0])]), pending: 0, tree: [note("7", "Notes")] });
    const g = h.paint("whale");
    expect(h.notices()).toEqual([]);
    expect(g.querySelector(".left-out")).toBeNull();
  });

  it("starts closed, and stays open across a repaint once opened", () => {
    const h = harness({ state: leftOut(results("whale", [doc(7, [0])]), [8, 9]), pending: 0, tree: [note("7", "Notes"), ...BOOKS] });
    const first = h.paint("whale").querySelector<HTMLDetailsElement>("details.left-out")!;
    expect(first.open).toBe(false);
    first.open = true;
    // A late answer repaints the gallery under the person reading the list.
    expect(h.paint("whale").querySelector<HTMLDetailsElement>("details.left-out")!.open).toBe(true);
  });
});

// The scope (`searchScope.ts`): wherever the answer lands, the person learns
// that documents' text isn't searched here, and where to change it.
describe("the search renderer's scope line", () => {
  const LINE = "This browser doesn't search the text inside documents, only their names.";
  const OFF = { documents: false };
  const folder = (id: string, name: string): Entry => ({ kind: "folder", id, name }) as Entry;
  /** The notice holding the line, if any. */
  const notice = (g: HTMLElement) => [...g.querySelectorAll(".hits__notice")].find((n) => n.textContent?.startsWith(LINE)) ?? null;

  it("is a notice over results, linking to the setting, and not a status announcement", () => {
    const h = harness({ state: results("whale", [doc(7, [0])]), pending: 0, tree: [note("7", "Notes")], scope: OFF });
    const n = notice(h.paint("whale"))!;
    expect(n.textContent).toBe(`${LINE} Change it in your account`);
    expect(n.querySelector("a")?.getAttribute("href")).toBe("#/account");
    expect(n.getAttribute("role")).toBeNull();
  });

  it("is a notice when only folders matched", () => {
    const h = harness({ state: results("whale", [], [], ["f:f1"]), pending: 0, tree: [folder("f1", "Whale")], scope: OFF });
    expect(notice(h.paint("whale"))?.querySelector("a")?.getAttribute("href")).toBe("#/account");
  });

  it("is part of 'No matches', with its link inside the sentence, before the coverage sentence", () => {
    const h = harness({ state: results("whale", []), pending: 0, scope: OFF });
    const g = h.paint("whale");
    const body = h.emptyBody();
    expect(body).toContain(`${LINE} Change it in your account`);
    expect(body.indexOf(LINE)).toBeLessThan(body.indexOf("recognised"));
    expect(g.querySelector(".empty a")?.getAttribute("href")).toBe("#/account");
  });

  it("comes after the left-out line and its list", () => {
    const h = harness({
      state: { ...results("whale", [doc(7, [0])]), leftOut: [8] } as SearchState,
      pending: 0,
      tree: [note("7", "Notes"), note("8", "Moby-Dick", "txt")],
      scope: OFF,
    });
    const g = h.paint("whale");
    expect(notice(g)?.previousElementSibling?.matches("details.left-out")).toBe(true);
  });

  it("is not said when everything is searched", () => {
    for (const scope of [undefined, { documents: true }]) {
      const h = harness({ state: results("whale", []), pending: 0, ...(scope ? { scope } : {}) });
      const g = h.paint("whale");
      expect(h.emptyBody()).not.toContain(LINE);
      expect(g.querySelector("a")).toBeNull();
    }
  });
});
