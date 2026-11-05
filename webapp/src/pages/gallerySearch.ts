// The library-wide search renderer: merges name matches from the cached tree
// with transcript hits from the index into one list, painted whole (no append
// path; a corpus change is a repaint).

import { el } from "../ui/dom";
import { coverageLine, expansionNotice, pendingLine, resultsMayGrowLine, type SearchState } from "./noteSearch";
import { crumbPath } from "./rail";
import type { FolderCache } from "./folderCache";
import type { SearchResult } from "./galleryCards";
import type { Expansion } from "../search/localSearch";
import type { Folder, Id, NoteSummary } from "../core/types";

function plural(n: number, one: string): string {
  return `${n} ${n === 1 ? one : `${one}s`}`;
}

/** `.txt` ordinals count paragraphs (1), `.note` pages (0); the index has no kind. */
function segmentKind(note: NoteSummary): number {
  return note.fileType.trim().toLowerCase() === "txt" ? 1 : 0;
}

/** Read through getters so a paint reflects state at paint time. */
export interface GallerySearchCtx {
  gallery: HTMLElement;
  getSearchState: () => SearchState;
  folders: Pick<FolderCache, "values">;
  /** Until the walk finishes, an empty result set is not yet an answer. */
  treeLoaded: () => boolean;
  /** Category-aware label; never `folder.name` directly. */
  labelFor: (folder: Folder) => string;
  resultCard: (result: SearchResult, i: number, q: string, expansions?: readonly Expansion[]) => HTMLElement;
  emptyState: (title: string, body: string) => HTMLElement;
  /**
  * Documents still being derived, from the live channel's `event: index`
  * frame, or `null` if unknown. Read at paint time.
  */
  indexPending: () => number | null;
  /** Another group of results painted after the notes (the to-dos); null: none. */
  moreResults?: (q: string) => HTMLElement | null;
}

export interface GallerySearch {
  renderSearch: (q: string) => void;
}

export function createGallerySearch(ctx: GallerySearchCtx): GallerySearch {
  const { gallery } = ctx;

  /** Every note in the cached (whole) tree with its folder, deduplicated. */
  function allCachedNotes(): Map<Id, { note: NoteSummary; folderPath: string | null }> {
    const seen = new Map<Id, { note: NoteSummary; folderPath: string | null }>();
    for (const cached of ctx.folders.values()) {
      const names = crumbPath(cached.path).map((f) => ctx.labelFor(f));
      const folderPath = names.length === 0 ? null : names.join(" / ");
      for (const e of cached.entries) {
        if (e.kind !== "note" || seen.has(e.id)) continue;
        seen.set(e.id, { note: e, folderPath });
      }
    }
    return seen;
  }

  /**
  * Joins index hits (md5, file id, ordinals; no names) to the cached tree and
  * drops hits the tree doesn't name: the local index may be a superset of the
  * live library. Name matches first; otherwise the engine's order is kept.
  */
  function searchResults(q: string): SearchResult[] {
    const searchState = ctx.getSearchState();
    const needle = q.toLowerCase();
    const cached = allCachedNotes();
    const byId = new Map<Id, SearchResult>();

    if (searchState.kind === "results") {
      for (const doc of searchState.documents) {
        // The index sends `fileId` as a number, the listing as a decimal string.
        const noteId = String(doc.fileId);
        const known = cached.get(noteId);
        if (!known) continue;
        byId.set(noteId, {
          noteId,
          note: known.note,
          folderPath: known.folderPath,
          nameMatched: known.note.name.toLowerCase().includes(needle),
          pages: doc.pages,
          kind: segmentKind(known.note),
        });
      }
    }

    for (const [noteId, { note, folderPath }] of cached) {
      if (byId.has(noteId) || !note.name.toLowerCase().includes(needle)) continue;
      byId.set(noteId, { noteId, note, folderPath, nameMatched: true, pages: [], kind: segmentKind(note) });
    }

    const all = [...byId.values()];
    return [...all.filter((r) => r.nameMatched), ...all.filter((r) => !r.nameMatched)];
  }

  /**
  * The "matched reunião" line, once as a header: a per-row line would be false
  * on rows that matched by name. Only shown if a row with pages survived the join.
  */
  function expansionBlock(expansions: readonly Expansion[], results: readonly SearchResult[]): HTMLElement | null {
    if (!results.some((r) => r.pages.length > 0)) return null;
    const parts = expansionNotice(expansions);
    if (!parts) return null;
    return el(
      "p",
      { class: "hits__notice", role: "status" },
      ...parts.map((p) => (p.matched ? el("strong", { class: "hits__matched", text: p.text }) : document.createTextNode(p.text))),
    );
  }

  /**
  * Counts the painted rows, not `LocalResults.totalPages`, which includes
  * documents the join dropped.
  */
  function searchCountLabel(notes: number, pages: number): string {
    return pages > 0 ? `${plural(notes, "note")} · ${plural(pages, "page")}` : plural(notes, "note");
  }

  /**
  * Names paint on the keystroke; transcripts join when the engine answers.
  * "Searching", "failed" and "nothing" stay three distinct states.
  */
  function renderSearch(q: string): void {
    const searchState = ctx.getSearchState();
    const results = searchResults(q);
    const pages = results.reduce((n, r) => n + r.pages.length, 0);

    const pending = ctx.indexPending() ?? 0;

    const expansions = searchState.kind === "results" ? searchState.expansions : [];
    const matched = expansionBlock(expansions, results);
    if (matched) gallery.append(matched);

    if (results.length > 0) {
      const grow = resultsMayGrowLine(pending);
      if (grow) gallery.append(el("p", { class: "hits__notice", role: "status", text: grow }));
    }

    const more = ctx.moreResults?.(q) ?? null;
    if (results.length === 0 && more) {
      // The notes may still answer; say so rather than "no notes".
      if (searchState.kind === "searching") gallery.append(el("p", { class: "hits__notice", role: "status", text: "Searching handwriting…" }));
      gallery.append(more);
      return;
    }

    if (results.length === 0) {
      if (searchState.kind === "error" && ctx.treeLoaded()) {
        // Gated on the walk: the index raises while the tree cache is still empty,
        // which is early, not failed.
        gallery.append(ctx.emptyState("Couldn't search", "The recognised text couldn't be searched. Keep typing to retry."));
      } else if (searchState.kind === "searching" || searchState.kind === "idle" || !ctx.treeLoaded()) {
        // No "No matches" until the walk lands (`rail.settle()` repaints); the empty
        // transcript answer usually arrives before the tree the name half needs.
        gallery.append(ctx.emptyState("Searching…", "Looking through every note — names, typing and handwriting."));
      } else {
        const still = pendingLine(pending);
        const why = coverageLine();
        gallery.append(ctx.emptyState(`No matches for “${q}”`, still ? `${still} ${why}` : why));
      }
      return;
    }

    gallery.append(
      el(
        "div",
        { class: "section-head" },
        el("span", { text: searchCountLabel(results.length, pages) }),
        searchState.kind === "searching" ? el("span", { class: "hits__count", text: "Searching handwriting…" }) : null,
      ),
    );
    for (const [i, result] of results.entries()) gallery.append(ctx.resultCard(result, i, q, expansions));
    if (more) gallery.append(more);
  }

  return { renderSearch };
}
