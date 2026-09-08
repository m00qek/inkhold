// @vitest-environment happy-dom
//
// What a RESULT ROW actually renders, through the real card factory.
//
// `golden-search.md` §4.3 drops excerpts rather than deferring them, and that is
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

describe("the deep link a row opens", () => {
  // THE DECISION, in the DOM: the link carries what the user typed. There is no
  // marked term to resolve any more — the marks lived in the excerpt — and
  // inventing an expansion the row does not have would be worse than handing the
  // viewer's find the string the box actually holds.
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
});
