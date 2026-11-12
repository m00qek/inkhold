// The library-search renderer's test harness (`pages/gallerySearch.ts`): its
// collaborators stubbed, the answer set by the test.

import { createGallerySearch, type GallerySearchCtx } from "../../src/pages/gallerySearch";
import type { SearchState } from "../../src/pages/noteSearch";
import type { SearchResult } from "../../src/pages/galleryCards";
import type { Entry, Id, Listing, NoteSummary } from "../../src/core/types";
import type { Expansion, LocalHit } from "../../src/search/localSearch";

export function doc(fileId: number, pages: number[], updatedAt = 0): LocalHit {
  return { md5: `md5-${fileId}`, fileId, pages, updatedAt, tier: "note", pageCount: null };
}

export function note(id: string, name: string, fileType = "note"): NoteSummary {
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

export function listing(entries: Entry[]): Listing {
  return { folderId: null, path: [], entries, syncVersion: 1 };
}

/** The index's answer; `names` are the name rows it matched (`n:<id>`, `f:<id>`). */
export function results(query: string, documents: LocalHit[], expansions: Expansion[] = [], names: string[] = []): SearchState {
  return { kind: "results", query, documents, expansions, items: { name: names, todo: [], digest: [] } };
}

/** The renderer with every collaborator stubbed; `resultCard` records the join. */
export function harness(initial: { state: SearchState; pending: number | null; tree?: Entry[]; treeLoaded?: boolean; more?: () => HTMLElement; moreCorrected?: boolean }) {
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
    moreResults: initial.more ? () => ({ node: initial.more!(), corrected: initial.moreCorrected ?? false }) : undefined,
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

