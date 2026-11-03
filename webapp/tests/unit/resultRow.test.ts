// @vitest-environment happy-dom

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
    // Pinned so the tile's aspect is known synchronously, without the dims memo.
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
  it("says how many pages matched instead of showing an excerpt", () => {
    const row = cards().resultCard(hitResult([2, 5, 9]), 0, "aurora");

    expect(row.querySelector(".card__matches")?.textContent).toBe("Matches on 3 pages");
    // The element is gone, and with it the only `innerHTML` of server-authored data.
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

// The substitution is said once above the list, never per row.
describe("what a row does NOT say about a corrected query", () => {
  it("renders no expansion line of its own", () => {
    const row = cards().resultCard(hitResult([2]), 0, "valjaen", [{ typed: "valjaen", matched: "valjean" }]);
    expect(row.textContent).not.toContain("valjean");
    expect(row.querySelector(".hits__matched")).toBeNull();
  });
});

describe("the deep link a row opens", () => {
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

  // The link carries the corrected term: viewers gate fuzzy answers behind an opt-in.
  it("carries the CORRECTED term when the ladder resolved the typo", () => {
    const row = cards().resultCard(hitResult([4, 7]), 0, "valjaen", [{ typed: "valjaen", matched: "valjean" }]);
    (row.querySelector(".card__open") as HTMLElement).click();

    expect(window.location.hash).toBe("#/note/7/page/5?q=valjean");
  });

  // A tie is not resolved: the typed query is handed over.
  it("keeps the typed word when the ladder offered two readings of it", () => {
    const row = cards().resultCard(hitResult([4]), 0, "valjen", [
      { typed: "valjen", matched: "valen" },
      { typed: "valjen", matched: "valjean" },
    ]);
    (row.querySelector(".card__open") as HTMLElement).click();

    expect(window.location.hash).toBe("#/note/7/page/5?q=valjen");
  });

  // A name-only row matched the typed spelling, so no corrected term.
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
