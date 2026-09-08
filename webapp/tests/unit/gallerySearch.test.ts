// @vitest-environment happy-dom
//
// The search renderer: which rows a query produces, and which sentences land
// around them.
//
// `noteSearch.test.ts` pins what the sentences SAY and what a row's count means;
// this pins what the renderer chose to paint, which is a separate failure — the
// strings can be perfect and the empty state still show the old line because the
// branch never reached them, and the merge can be perfect and still drop a name
// match. Both halves of are here too: the empty state
// explains an absence, a non-empty page qualifies a presence, and the gallery
// says nothing at all because it never claimed completeness.

import { describe, it, expect } from "vitest";
import { createGallerySearch, type GallerySearchCtx } from "../../src/pages/gallerySearch";
import type { SearchState } from "../../src/pages/noteSearch";
import type { SearchResult } from "../../src/pages/galleryCards";
import type { Entry, Id, Listing, NoteSummary } from "../../src/core/types";
import type { Expansion, LocalHit } from "../../src/search/localSearch";

/** One matching DOCUMENT, as the engine hands it over: an id and its pages. */
function doc(fileId: number, pages: number[], updatedAt = 0): LocalHit {
  return { md5: `md5-${fileId}`, fileId, pages, updatedAt };
}

/** A note in the cached tree — the other half of every row (see `searchResults`). */
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

/** One cached folder listing, which is all `folders.values()` ever yields. */
function listing(entries: Entry[]): Listing {
  return { folderId: null, path: [], entries, syncVersion: 1 };
}

function results(query: string, documents: LocalHit[], expansions: Expansion[] = []): SearchState {
  return { kind: "results", query, documents, expansions };
}

/**
 * The renderer with every collaborator stubbed to the smallest thing that
 * satisfies it. Nothing here is a fake of the search — the search state is
 * handed in directly — so a failure is always about what the renderer chose to
 * paint. `resultCard` records the {@link SearchResult} it was handed, because
 * half of what this file asserts is the JOIN rather than the DOM.
 */
function harness(initial: { state: SearchState; pending: number | null; tree?: Entry[]; treeLoaded?: boolean }) {
  const gallery = document.createElement("section");
  let state = initial.state;
  let pending = initial.pending;
  const tree = initial.tree ?? [];
  const built: SearchResult[] = [];
  /** What each row was handed for its DEEP LINK, parallel to {@link built}. */
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
    emptyState: (title, body) => {
      const box = document.createElement("div");
      box.className = "empty";
      box.dataset["title"] = title;
      box.textContent = body;
      return box;
    },
    indexPending: () => pending,
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
    setState(s: SearchState) {
      state = s;
    },
    emptyBody: () => gallery.querySelector(".empty")?.textContent ?? "",
    head: () => gallery.querySelector(".section-head")?.textContent ?? "",
    notices: () => [...gallery.querySelectorAll(".hits__notice")].map((n) => n.textContent),
    /** The words the ladder searched, as the emphasised half of the notice. */
    matchedWords: () => [...gallery.querySelectorAll(".hits__matched")].map((n) => n.textContent),
    rows: () => [...gallery.querySelectorAll(".card--result")].map((n) => n.textContent),
  };
}

// A document matching by transcript is only a row once the LISTING names it —
// the index ships no names (§4.1) and may legitimately hold documents the live
// library no longer has (§2.7).
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

  // THE INTERSECTION. §2.7 makes the local index a legitimate SUPERSET of the
  // live library, and correctness comes from intersecting hits with the
  // listing — which is also the only thing that could have named the row.
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

  // `files.id` is a number in the index and its decimal string in the listing.
  // Getting this wrong matches nothing at all, silently.
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

// NAME MATCHING IS UNAFFECTED by the switch: it was always answered from the
// cached tree, with no round trip and no endpoint.
describe("the name half of the query", () => {
  it("still merges filename matches that no transcript hit named", () => {
    const h = harness({
      state: results("rut", [doc(7, [1])]),
      pending: 0,
      tree: [note("7", "Weekly review"), note("8", "Rutabaga plans")],
    });
    h.paint("rut");

    expect(h.rows()).toEqual(["Rutabaga plans", "Weekly review"]);
    // A name-only match reached no page, so its row has nothing to count.
    expect(h.built.find((r) => r.noteId === "8")?.pages).toEqual([]);
  });

  it("marks a document that matched BOTH ways once, as a name match", () => {
    const h = harness({
      state: results("weekly", [doc(7, [1, 2])]),
      pending: 0,
      tree: [note("7", "Weekly review")],
    });
    h.paint("weekly");

    expect(h.rows()).toEqual(["Weekly review"]);
    expect(h.built[0]?.nameMatched).toBe(true);
    // …and it keeps its pages: it is one document, not two rows.
    expect(h.built[0]?.pages).toEqual([1, 2]);
  });

  it("puts name matches first and otherwise keeps the engine's rank order", () => {
    const h = harness({
      // Rank order is the engine's: most matching pages first.
      state: results("plan", [doc(1, [0, 1, 2]), doc(2, [5])]),
      pending: 0,
      tree: [note("1", "Alpha"), note("2", "Beta"), note("3", "Plan B")],
    });
    h.paint("plan");

    expect(h.rows()).toEqual(["Plan B", "Alpha", "Beta"]);
  });
});

// THE CONTROL IS GONE, not hidden. A whole local index answers whole: there is
// no cursor to spend and nothing that may still grow within one query.
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

  // The old header spoke in floors — "3+ notes · 20+ pages" — because the
  // server terminated at a page boundary and never counted. It counts now.
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

// §4.3's "matched **reunião**" — the half of what replaced the excerpt that a
// match count cannot carry. `noteSearch.test.ts` pins the WORDING; this pins
// what the renderer chose to do with it, which is the separate failure: the
// sentence can be perfect and still be on every row, or over the wrong list.
describe("what the results say about a corrected query", () => {
  const CORRECTED: Expansion[] = [{ typed: "valjaen", matched: "valjean" }];

  // ONCE, ABOVE THE LIST. The expansion is per TOKEN, so it explains every row
  // identically — and it would be false on a row that matched by NAME, which
  // matched the typed spelling exactly. A row is never the place for it.
  it("says it once above the list, and never on a row", () => {
    const h = harness({
      state: results("valjaen", [doc(1, [0, 4]), doc(2, [7])], CORRECTED),
      pending: 0,
      tree: [note("1", "One"), note("2", "Two")],
    });
    h.paint("valjaen");

    expect(h.notices()).toEqual(["Matched valjean instead of “valjaen”."]);
    expect(h.matchedWords()).toEqual(["valjean"]);
    expect(h.rows()).toEqual(["One", "Two"]); // the stub rows say only their names
  });

  // A FALLBACK, NEVER A WIDENING: the query that answered as typed explains
  // nothing, so the line is not there at all.
  it("says nothing when the query as typed is what answered", () => {
    const h = harness({ state: results("aurora", [doc(1, [0])]), pending: 0, tree: [note("1", "One")] });
    h.paint("aurora");
    expect(h.notices()).toEqual([]);
  });

  // IT LEADS. `resultsMayGrowLine` qualifies the LIST; this qualifies the
  // QUERY, and a reader who does not yet know which word was searched has no
  // use for a note about the list growing.
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

  // THE ENGINE'S GUARD IS NOT THIS VIEW'S GUARD. `indexSearch.ts` refuses to
  // report a substitution over an empty ANSWER; this renderer intersects again
  // — a hit the cached tree cannot name is dropped (§2.7) — so a list standing
  // on name matches alone would be explained by an expansion that produced none
  // of it.
  it("stays silent when every row it could explain fell out of the listing join", () => {
    const h = harness({
      // The corrected term reached document 404, which the tree does not name.
      // "One" is here because its NAME contains the typed spelling.
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

  // NODES, NEVER MARKUP. Both halves are device-authored — an index term, a
  // token out of the search box — and step 6 deleted this app's last
  // `innerHTML` of anything like that.
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

  // The expansions reach the ROW as well, and for exactly one reason: the row
  // decides which query its deep link carries (`deepLinkQuery`).
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

// A FAILED SEARCH IS ITS OWN STATE, and since the search removal it is
// reachable: there is no server fallback behind the index, so an engine that
// cannot answer reaches the results area. What it may NOT do is claim failure
// while the thing it needs is still arriving.
describe("a search that failed", () => {
  it("says so, distinctly from 'no matches'", () => {
    const h = harness({ state: { kind: "error", query: "aurora" }, pending: 0, tree: [note("1", "One")] });
    h.paint("aurora");
    expect(h.gallery.querySelector(".empty")?.getAttribute("data-title")).toBe("Couldn't search");
  });

  // The index intersects its answer with the cached tree and raises while that
  // cache is still empty — the ordinary state for the first moments after boot.
  // That is early, not broken, and it reads as the search still running.
  it("reads as still searching while the tree walk has not finished", () => {
    const h = harness({ state: { kind: "error", query: "aurora" }, pending: 0, treeLoaded: false });
    h.paint("aurora");
    expect(h.gallery.querySelector(".empty")?.getAttribute("data-title")).toBe("Searching…");
  });
});

describe("the search renderer's pending sentences", () => {
  // THE HEADLINE. A just-uploaded file returns no matches for itself, and
  // "No matches" alone is a completeness claim the client knows to be false.
  it("says a zero-hit search is still indexing rather than leaving 'No matches' unqualified", () => {
    const h = harness({ state: results("rutabaga", []), pending: 3 });
    h.paint();
    expect(h.emptyBody()).toContain("3 documents are still being indexed");
  });

  // The two sentences, side by side, in the order that tells the reader what to
  // do: waiting helps with the first and never helps with the second.
  it("says BOTH sentences when both apply, pending first", () => {
    const h = harness({ state: results("rutabaga", []), pending: 2 });
    h.paint();
    const body = h.emptyBody();
    expect(body).toContain("2 documents are still being indexed");
    expect(body).toContain("Only notes recognised on the device are searchable.");
    expect(body.indexOf("still being indexed")).toBeLessThan(body.indexOf("recognised"));
  });

  // Nothing outstanding is the ordinary case, and it must read exactly as it did
  // before any of this existed.
  it("falls back to the coverage sentence alone when nothing is outstanding", () => {
    const h = harness({ state: results("rutabaga", []), pending: 0 });
    h.paint();
    expect(h.emptyBody()).toBe("Only notes recognised on the device are searchable.");
  });

  // The non-empty half: the list implies "this is what there is", and while a
  // derive is outstanding it is not.
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

    // `null` is "the server did not say" — an old server, or a client that fell
    // back to polling. It must read as silence, never as a claim either way.
    const silent = harness({ state: withHits, pending: null, tree });
    silent.paint();
    expect(silent.notices()).toEqual([]);
  });

  // The live half: a frame arrives, the number moves, the next paint says so.
  // Without this the sentence is only ever as fresh as the last keystroke.
  it("follows the live channel — a frame that changes the count changes the next paint", () => {
    const h = harness({ state: results("rutabaga", [doc(7, [0])]), pending: 3, tree: [note("7", "Notes")] });
    h.paint();
    expect(h.notices()).toEqual(["More may appear — 3 documents are still being indexed."]);

    h.setPending(0); // the worker finished; the server pushed `pending: 0`
    h.paint();
    expect(h.notices()).toEqual([]);
  });

  // A failed search is not an empty one, and it is not a place to explain
  // indexing either: the honest answer there is "it broke, retry".
  it("says nothing about indexing when the search itself failed", () => {
    const h = harness({ state: { kind: "error", query: "rutabaga" }, pending: 5 });
    h.paint();
    expect(h.emptyBody()).not.toContain("still being indexed");
    expect(h.notices()).toEqual([]);
  });
});
