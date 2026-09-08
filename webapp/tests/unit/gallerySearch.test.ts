// @vitest-environment happy-dom
//
// The search renderer's PENDING sentences, where they actually get painted.
//
// `noteSearch.test.ts` pins what the two sentences SAY; this pins where each one
// lands, which is a separate failure: the strings can be perfect and the empty
// state still show the old unquantified line because the branch never reached
// them. Both halves of `pending-ness.md` §6 are here — the empty state explains
// an absence, a non-empty page qualifies a presence, and the gallery says
// nothing at all because it never claimed completeness.

import { describe, it, expect } from "vitest";
import { createGallerySearch, type GallerySearchCtx } from "../../src/pages/gallerySearch";
import type { SearchState } from "../../src/pages/noteSearch";
import type { LazyEngine } from "../../src/render/lazy";

/** A hit shaped like the server's, enough for `groupHits` to make a row of it. */
function hit(noteId: string, name: string) {
  return { noteId, noteName: name, pageIndex: 0, snippet: "an <mark>excerpt</mark>", kind: 0 };
}

/**
 * The renderer with every collaborator stubbed to the smallest thing that
 * satisfies it. Nothing here is a fake of the search — the search state is
 * handed in directly — so a failure is always about what the renderer chose to
 * paint.
 */
function harness(initial: { state: SearchState; pending: number | null }) {
  const gallery = document.createElement("section");
  let state = initial.state;
  let pending = initial.pending;

  const ctx: GallerySearchCtx = {
    gallery,
    // Never reached: only the append path frees lazy slots, and these tests
    // paint from scratch.
    galleryEngine: { remove: () => {} } as unknown as LazyEngine,
    getSearchState: () => state,
    loadMore: () => Promise.resolve(),
    folders: { values: () => [] }, // no cached tree: the name half matches nothing
    treeLoaded: () => true,
    labelFor: (f) => f.name,
    resultCard: (r) => {
      const card = document.createElement("article");
      card.textContent = r.noteName;
      return card;
    },
    emptyState: (title, body) => {
      const box = document.createElement("div");
      box.className = "empty";
      box.dataset.title = title;
      box.textContent = body;
      return box;
    },
    indexPending: () => pending,
  };

  const search = createGallerySearch(ctx);
  return {
    paint(q = "rutabaga") {
      gallery.replaceChildren();
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
    notices: () => [...gallery.querySelectorAll(".hits__notice")].map((n) => n.textContent),
  };
}

const noHits: SearchState = {
  kind: "results",
  query: "rutabaga",
  hits: [],
  usedFuzzy: false,
  coverage: { notes: 4, unsearchable: 0, pending: 0 },
};

describe("the search renderer's pending sentences", () => {
  // THE HEADLINE. A just-uploaded file returns no matches for itself, and
  // "No matches" alone is a completeness claim the server knows to be false.
  it("says a zero-hit search is still indexing rather than leaving 'No matches' unqualified", () => {
    const h = harness({
      state: { ...noHits, coverage: { notes: 4, unsearchable: 0, pending: 3 } },
      pending: null,
    });
    h.paint();
    expect(h.emptyBody()).toContain("3 documents are still being indexed");
  });

  // The two numbers, side by side, in the order that tells the reader what to
  // do: waiting helps with the first and never helps with the second.
  it("says BOTH sentences when both apply, pending first", () => {
    const h = harness({
      state: { ...noHits, coverage: { notes: 40, unsearchable: 12, pending: 2 } },
      pending: null,
    });
    h.paint();
    const body = h.emptyBody();
    expect(body).toContain("2 documents are still being indexed");
    expect(body).toContain("12 of your 40 notes have no recognised text");
    expect(body.indexOf("still being indexed")).toBeLessThan(body.indexOf("no recognised text"));
  });

  // Nothing outstanding is the ordinary case, and it must read exactly as it did
  // before any of this existed.
  it("falls back to the unquantified coverage sentence when nothing is outstanding", () => {
    const h = harness({ state: noHits, pending: 0 });
    h.paint();
    expect(h.emptyBody()).toBe("Only notes recognised on the device are searchable.");
  });

  // The non-empty half: the list implies "this is what there is", and while a
  // derive is outstanding it is not.
  it("qualifies a NON-EMPTY page from the live channel, since that response carries no coverage", () => {
    const h = harness({
      state: { kind: "results", query: "rutabaga", hits: [hit("7", "Notes")], usedFuzzy: false, coverage: null },
      pending: 2,
    });
    h.paint();
    expect(h.notices()).toContain("More may appear — 2 documents are still being indexed.");
  });

  it("says nothing over results when nothing is outstanding, and nothing when the server never said", () => {
    const withHits: SearchState = {
      kind: "results",
      query: "rutabaga",
      hits: [hit("7", "Notes")],
      usedFuzzy: false,
      coverage: null,
    };
    const zero = harness({ state: withHits, pending: 0 });
    zero.paint();
    expect(zero.notices()).toEqual([]);

    // `null` is "the server did not say" — an old server, or a client that fell
    // back to polling. It must read as silence, never as a claim either way.
    const silent = harness({ state: withHits, pending: null });
    silent.paint();
    expect(silent.notices()).toEqual([]);
  });

  // The live half: a frame arrives, the number moves, the next paint says so.
  // Without this the sentence is only ever as fresh as the last keystroke.
  it("follows the live channel — a frame that changes the count changes the next paint", () => {
    const h = harness({
      state: { kind: "results", query: "rutabaga", hits: [hit("7", "Notes")], usedFuzzy: false, coverage: null },
      pending: 3,
    });
    h.paint();
    expect(h.notices()).toEqual(["More may appear — 3 documents are still being indexed."]);

    h.setPending(0); // the worker finished; the server pushed `pending: 0`
    h.paint();
    expect(h.notices()).toEqual([]);
  });

  // A zero-hit response's own number wins over the channel's: it is the fresher
  // of the two and it is guaranteed present. They are the same number from two
  // routes, and adding them would double-count.
  it("prefers the response's own count on a zero-hit page over the live channel's", () => {
    const h = harness({
      state: { ...noHits, coverage: { notes: 4, unsearchable: 0, pending: 1 } },
      pending: 9,
    });
    h.paint();
    expect(h.emptyBody()).toContain("1 document is still being indexed");
    expect(h.emptyBody()).not.toContain("9 documents");
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
