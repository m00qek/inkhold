// @vitest-environment happy-dom
//
// What a RESULT ROW actually renders, through the real card factory.
//
// §4.3 drops excerpts rather than deferring them, and that is
// the whole reason the server ends up with no query-interpreting code at all. So
// the row's contract changed shape: it says "matches on N pages" where it used to
// splice server HTML into `innerHTML`, and its deep link carries the typed query
// where it used to carry a term reverse-engineered from that HTML. Both of those
// are assertions about the DOM, which `gallerySearch.test.ts` deliberately stubs
// out — so they live here, against the builder that really makes the row.

import { describe, it, expect, beforeEach } from "vitest";
import { createGalleryCards, type GalleryCardsCtx, type SearchResult } from "../../src/pages/galleryCards";
import type { Entry, NoteSummary } from "../../src/core/types";
import type { LazyEngine } from "../../src/render/lazy";

function note(id: string, name: string, fileType = "note"): NoteSummary {
  return {
    kind: "note",
    id,
    name,
    pageCount: 12,
    firstPage: { index: 0, hash: null },
    updatedAt: Date.UTC(2026, 0, 14),
    fileType,
    fileHash: null,
    hasRecognizedText: true,
    // Pinned so the tile's aspect is known synchronously and nothing here waits
    // on the dimension memo — this test is about the row's text, not its shape.
    thumbAspect: { w: 3, h: 4 },
  } as NoteSummary;
}

function cards() {
  const ctx: GalleryCardsCtx = {
    galleryEngine: { add: () => {}, remove: () => {} } as unknown as LazyEngine,
    imgLazy: null,
    getView: () => "list",
    labelFor: (f) => f.name,
    categoryIconFor: () => null,
    pendingCategoryOf: () => null,
    onSelectCategory: () => {},
    scheduleSpan: () => {},
    cardMenu: (_e: Entry) => document.createElement("div"),
  };
  return createGalleryCards(ctx);
}

/** A transcript match on three pages of a note the listing names. */
function hitResult(pages: number[], over: Partial<SearchResult> = {}): SearchResult {
  const n = over.note ?? note("7", "Weekly review");
  return { noteId: n.id, note: n, folderPath: "Note / Projects", nameMatched: false, pages, kind: 0, ...over };
}

beforeEach(() => {
  window.location.hash = "";
});

describe("a result row", () => {
  // THE HEADLINE OF THE REWORK. A row was a PAGE with an excerpt; it is a
  // DOCUMENT with a count.
  it("says how many pages matched instead of showing an excerpt", () => {
    const row = cards().resultCard(hitResult([2, 5, 9]), 0, "aurora");

    expect(row.querySelector(".card__matches")?.textContent).toBe("Matches on 3 pages");
    // Not hidden, not empty — the element and its rules are gone, and with them
    // the app's only `innerHTML` of server-authored data.
    expect(row.querySelector(".hit__snippet")).toBeNull();
    expect(row.innerHTML).not.toContain("<mark>");
  });

  it("says it for a single page too, now that the count is a document's own", () => {
    const row = cards().resultCard(hitResult([4]), 0, "aurora");
    expect(row.querySelector(".card__matches")?.textContent).toBe("Matches on 1 page");
  });

  it("counts paragraphs for a .txt", () => {
    const n = note("9", "readme", "txt");
    const row = cards().resultCard(hitResult([0, 3], { note: n, noteId: n.id, kind: 1 }), 0, "aurora");
    expect(row.querySelector(".card__matches")?.textContent).toBe("Matches in 2 paragraphs");
  });

  // A name-only match reached no page. "Matches on 0 pages" would make the
  // reader parse a number to learn the marked title above was the whole answer.
  it("says nothing about pages for a name-only match, and marks the title instead", () => {
    const n = note("8", "Rutabaga plans");
    const row = cards().resultCard(
      { noteId: n.id, note: n, folderPath: null, nameMatched: true, pages: [], kind: 0 },
      0,
      "rutabaga",
    );

    expect(row.querySelector(".card__matches")).toBeNull();
    expect(row.querySelector(".card__title mark")?.textContent).toBe("Rutabaga");
  });

  it("still shows the path and the date, because a result is library-wide", () => {
    const row = cards().resultCard(hitResult([1]), 0, "aurora");
    expect(row.querySelector(".card__path")?.textContent).toBe("Note / Projects");
    expect(row.querySelector(".card__meta")?.textContent).toContain("2026");
  });
});

// THE ROW SAYS NOTHING ABOUT THE SUBSTITUTION, and that is the placement
// decision made visible. The ladder substitutes per TOKEN of the query, so one
// sentence explains every row identically — it is said once, over the list, by
// `gallerySearch.ts`. Repeating it per row would also be a LIE on the rows that
// matched by name, which matched the typed spelling exactly.
describe("what a row does NOT say about a corrected query", () => {
  it("renders no expansion line of its own", () => {
    const row = cards().resultCard(hitResult([2]), 0, "valjaen", [{ typed: "valjaen", matched: "valjean" }]);
    expect(row.textContent).not.toContain("valjean");
    expect(row.querySelector(".hits__matched")).toBeNull();
  });
});

describe("the deep link a row opens", () => {
  // The ordinary case, which is nearly every case: the query as typed answered,
  // so there is nothing to resolve and the link carries the string the box holds.
  it("carries the typed query, verbatim, to the FIRST matching page", () => {
    const row = cards().resultCard(hitResult([4, 7, 11]), 0, "reunaio");
    (row.querySelector(".card__open") as HTMLElement).click();

    // `notePageHref` writes pages one-based; internal page 4 is `/page/5`.
    expect(window.location.hash).toBe("#/note/7/page/5?q=reunaio");
  });

  it("opens a name-only match at the document, still carrying the query", () => {
    const n = note("8", "Rutabaga plans");
    const row = cards().resultCard(
      { noteId: n.id, note: n, folderPath: null, nameMatched: true, pages: [], kind: 0 },
      0,
      "rutabaga",
    );
    (row.querySelector(".card__open") as HTMLElement).click();

    expect(window.location.hash).toBe("#/note/8?q=rutabaga");
  });

  it("collapses page 0 to the bare document route, as the router's one canonical URL", () => {
    const row = cards().resultCard(hitResult([0, 3]), 0, "aurora");
    (row.querySelector(".card__open") as HTMLElement).click();

    expect(window.location.hash).toBe("#/note/7?q=aurora");
  });

  // THE DECISION REVERSED, in the DOM. The row could not know the correction
  // while it lived inside a server-marked excerpt; the CLIENT runs the ladder
  // now, so the term arrives as data. And it is a defect being closed rather
  // than a nicety added: the viewers gate a fuzzy answer behind an opt-in, so a
  // link carrying the typo opened a find reading "No matches" over a "search
  // similar" prompt, on a row that had just said the document matched.
  it("carries the CORRECTED term when the ladder resolved the typo", () => {
    const row = cards().resultCard(hitResult([4, 7]), 0, "valjaen", [{ typed: "valjaen", matched: "valjean" }]);
    (row.querySelector(".card__open") as HTMLElement).click();

    expect(window.location.hash).toBe("#/note/7/page/5?q=valjean");
  });

  // A TIE IS NOT RESOLVED. Two readings one edit apart, and the row does not say
  // which one this document holds — so it hands over what was typed and lets the
  // viewer's own ladder do what it already does well.
  it("keeps the typed word when the ladder offered two readings of it", () => {
    const row = cards().resultCard(hitResult([4]), 0, "valjen", [
      { typed: "valjen", matched: "valen" },
      { typed: "valjen", matched: "valjean" },
    ]);
    (row.querySelector(".card__open") as HTMLElement).click();

    expect(window.location.hash).toBe("#/note/7/page/5?q=valjen");
  });

  // A NAME-ONLY ROW IS NOT AN EXPANSION'S DOING. It matched the typed spelling
  // in its title, and nothing says the corrected word is anywhere inside it —
  // opening the find on a word the reader never typed, in a document that
  // matched for an unrelated reason, is a worse arrival than the typo.
  it("does NOT substitute for a name-only match, whatever the ladder found", () => {
    const n = note("8", "Valjaen plans");
    const row = cards().resultCard(
      { noteId: n.id, note: n, folderPath: null, nameMatched: true, pages: [], kind: 0 },
      0,
      "valjaen",
      [{ typed: "valjaen", matched: "valjean" }],
    );
    (row.querySelector(".card__open") as HTMLElement).click();

    expect(window.location.hash).toBe("#/note/8?q=valjaen");
  });
});
