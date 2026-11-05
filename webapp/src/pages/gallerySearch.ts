// The library-wide search renderer: merges name matches from the cached tree
// with transcript hits from the index into one list, painted whole (no append
// path; a corpus change is a repaint).

import { el } from "../ui/dom";
import { coverageLine, expansionNotice, pendingLine, resultsMayGrowLine, type SearchState } from "./noteSearch";
import { crumbPath } from "./rail";
import { matchesName, nameQueryFor, type NameQuery } from "../search/match";
import type { SearchCoverage } from "./searchCoverage";
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
  /** A folder whose name matched, as the gallery shows folders. */
  folderCard: (folder: Folder) => HTMLElement;
  emptyState: (title: string, body: string) => HTMLElement;
  /**
  * Documents still being derived, from the live channel's `event: index`
  * frame, or `null` if unknown. Read at paint time.
  */
  indexPending: () => number | null;
  /** Another group of results painted after the notes (the to-dos); null: none. */
  moreResults?: (q: string) => HTMLElement | null;
  /** How much handwriting search can find (`searchCoverage.ts`); absent: not said. */
  coverage?: SearchCoverage;
}

export interface GallerySearch {
  renderSearch: (q: string) => void;
  /** The coverage line and its list, for a search too short to run; null: none yet. */
  coverageBlock: () => HTMLElement | null;
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
  function searchResults(query: NameQuery | null): SearchResult[] {
    const searchState = ctx.getSearchState();
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
          nameMatched: matchesName(known.note.name, query),
          pages: doc.pages,
          kind: segmentKind(known.note),
          md5: doc.md5,
          written: doc.tier !== "other" && doc.tier !== "marked",
        });
      }
    }

    for (const [noteId, { note, folderPath }] of cached) {
      if (byId.has(noteId) || !matchesName(note.name, query)) continue;
      byId.set(noteId, { noteId, note, folderPath, nameMatched: true, pages: [], kind: segmentKind(note), md5: null, written: true });
    }

    const all = [...byId.values()];
    return [...all.filter((r) => r.nameMatched), ...all.filter((r) => !r.nameMatched)];
  }

  /** The coverage block, naming notes from the cached tree. */
  function coverageBlock(): HTMLElement | null {
    if (!ctx.coverage) return null;
    const notes = allCachedNotes();
    return ctx.coverage.block((id) => notes.get(id)?.note.name ?? null);
  }

  /** Every note and folder name the search can show, for choosing the rule. */
  function* allNames(): Generator<string> {
    for (const cached of ctx.folders.values()) {
      for (const e of cached.entries) yield e.kind === "folder" ? ctx.labelFor(e) : e.name;
    }
  }

  /** Folders named like the query, by the label the rail shows; each once. */
  function folderResults(query: NameQuery | null): Folder[] {
    const seen = new Map<Id, Folder>();
    for (const cached of ctx.folders.values()) {
      for (const e of cached.entries) {
        if (e.kind !== "folder" || seen.has(e.id) || !matchesName(ctx.labelFor(e), query)) continue;
        seen.set(e.id, e);
      }
    }
    return [...seen.values()];
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
    // The word rule; typed text anywhere in a name only when no name matched it.
    const query = nameQueryFor(q, allNames());
    const results = searchResults(query);
    const folders = folderResults(query);
    const pages = results.reduce((n, r) => n + r.pages.length, 0);

    const pending = ctx.indexPending() ?? 0;

    const expansions = searchState.kind === "results" ? searchState.expansions : [];
    const matched = expansionBlock(expansions, results);
    if (matched) gallery.append(matched);

    if (results.length > 0) {
      const grow = resultsMayGrowLine(pending);
      if (grow) gallery.append(el("p", { class: "hits__notice", role: "status", text: grow }));
    }

    // Folders first: a name typed to get somewhere. Their own group, like the to-dos'.
    if (folders.length > 0) {
      gallery.append(el("div", { class: "section-head" }, el("span", { text: plural(folders.length, "folder") })));
      for (const f of folders) gallery.append(ctx.folderCard(f));
    }

    const more = ctx.moreResults?.(q) ?? null;
    if (results.length === 0 && (more || folders.length > 0)) {
      // The notes may still answer; say so rather than "no notes".
      if (searchState.kind === "searching") gallery.append(el("p", { class: "hits__notice", role: "status", text: "Searching handwriting…" }));
      if (more) gallery.append(more);
      const cov = coverageBlock();
      if (cov) gallery.append(cov);
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
        // The coverage block says the rest, with numbers, once it has them.
        const cov = coverageBlock();
        const why = cov ? "" : coverageLine();
        gallery.append(ctx.emptyState(`No matches for “${q}”`, [still, why].filter(Boolean).join(" ")));
        if (cov) gallery.append(cov);
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
    // The to-dos are the person's writing: before the first document that is
    // neither named like the query nor a note, else at the end.
    const at = results.findIndex((r) => !r.nameMatched && !r.written);
    for (const [i, result] of results.entries()) {
      if (i === at && more) gallery.append(more);
      gallery.append(ctx.resultCard(result, i, q, expansions));
    }
    if (more && at < 0) gallery.append(more);
    const cov = coverageBlock();
    if (cov) gallery.append(cov);
  }

  return { renderSearch, coverageBlock };
}
