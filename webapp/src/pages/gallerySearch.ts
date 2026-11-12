// The library-wide search renderer: merges name matches and transcript hits,
// both from the index, joined to the cached tree, into one list, painted
// whole (no append path; a corpus change is a repaint). The names reach the
// index as rows of their own (`nameRows`).

import { cardList } from "./galleryCards";
import { el } from "../ui/dom";
import { answerFor, coverageLine, expansionNotice, pendingLine, resultsMayGrowLine, type SearchState } from "./noteSearch";
import { crumbPath } from "./rail/railPlaces";
import { holdsInside, insideOf } from "../search/match";
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

/** Name rows' keys (`nameRows`): a note's id, a folder's. */
export const NOTE = "n:";
export const FOLDER = "f:";

/** What matched by name: notes and folders, by id. */
interface NameHits {
  readonly notes: ReadonlySet<Id>;
  readonly folders: ReadonlySet<Id>;
  /** Found by the typo ladder's spelling, not as typed. */
  readonly corrected: boolean;
}

/** The digests' and to-dos' groups, and whether any of them came from the typo ladder's spelling. */
export interface MoreResults {
  readonly node: Node;
  readonly corrected: boolean;
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
  /** The digests' and to-dos' groups, painted among the notes (see `renderSearch`); null: none. */
  moreResults?: (q: string) => MoreResults | null;
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
   * The names the index matched for `q`, once it answered. Only when none
   * matched as typed, the typed text anywhere in a name ("style" in
   * "MyStyle"), then the typo ladder's: fallbacks, never a widening.
   */
  function nameHits(q: string): NameHits {
    const s = answerFor(ctx.getSearchState(), q);
    if (!s) return { notes: new Set(), folders: new Set(), corrected: false };
    const notes = new Set<Id>();
    const folders = new Set<Id>();
    for (const key of s.items.name) {
      if (key.startsWith(NOTE)) notes.add(key.slice(NOTE.length));
      else if (key.startsWith(FOLDER)) folders.add(key.slice(FOLDER.length));
    }
    const found = notes.size > 0 || folders.size > 0;
    if (found && s.expansions.length === 0) return { notes, folders, corrected: false };
    // Before the typo ladder's answer, as for to-dos.
    const inside = insideOf(q);
    const inNotes = new Set<Id>();
    const inFolders = new Set<Id>();
    for (const cached of ctx.folders.values()) {
      for (const e of cached.entries) {
        if (e.kind === "note" && holdsInside(e.name, inside)) inNotes.add(e.id);
        else if (e.kind === "folder" && holdsInside(ctx.labelFor(e), inside)) inFolders.add(e.id);
      }
    }
    if (inNotes.size > 0 || inFolders.size > 0) return { notes: inNotes, folders: inFolders, corrected: false };
    return { notes, folders, corrected: found };
  }

  /**
  * Joins index hits (md5, file id, ordinals; no names) to the cached tree and
  * drops hits the tree doesn't name: the local index may be a superset of the
  * live library. Name matches first; otherwise the engine's order is kept.
  */
  function searchResults(names: NameHits): SearchResult[] {
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
          nameMatched: names.notes.has(noteId),
          pages: doc.pages,
          kind: segmentKind(known.note),
          md5: doc.md5,
          written: doc.tier !== "other" && doc.tier !== "marked",
        });
      }
    }

    for (const [noteId, { note, folderPath }] of cached) {
      if (byId.has(noteId) || !names.notes.has(noteId)) continue;
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

  /** Folders named like the query, by the label the rail shows; each once. */
  function folderResults(names: NameHits): Folder[] {
    const seen = new Map<Id, Folder>();
    for (const cached of ctx.folders.values()) {
      for (const e of cached.entries) {
        if (e.kind !== "folder" || seen.has(e.id) || !names.folders.has(e.id)) continue;
        seen.set(e.id, e);
      }
    }
    return [...seen.values()];
  }

  /**
  * The "matched reunião" line, once above every group: the typo ladder is one
  * for all of them. Only over something it found, or it would be false over a
  * name matched as typed, and contradict "No matches".
  */
  function expansionBlock(expansions: readonly Expansion[], shown: boolean): HTMLElement | null {
    if (!shown) return null;
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
  * Names and transcripts paint when the engine answers.
  * "Searching", "failed" and "nothing" stay three distinct states.
  */
  function renderSearch(q: string): void {
    const searchState = ctx.getSearchState();
    const names = nameHits(q);
    const results = searchResults(names);
    const folders = folderResults(names);
    const pages = results.reduce((n, r) => n + r.pages.length, 0);

    const pending = ctx.indexPending() ?? 0;

    const expansions = searchState.kind === "results" ? searchState.expansions : [];
    const extra = ctx.moreResults?.(q) ?? null;
    const more = extra?.node ?? null;
    const matched = expansionBlock(expansions, results.some((r) => r.pages.length > 0) || names.corrected || extra?.corrected === true);
    if (matched) gallery.append(matched);

    // A phrase checked against text the browser doesn't hold for every result.
    const unchecked = searchState.kind === "results" ? (searchState.unchecked ?? 0) : 0;
    if (unchecked > 0 && results.some((r) => r.pages.length > 0)) {
      gallery.append(
        el("p", { class: "hits__notice", role: "status", text: `${plural(unchecked, "result")} couldn't be checked for the exact phrase: ${unchecked === 1 ? "its" : "their"} text isn't in this browser yet.` }),
      );
    }

    if (results.length > 0) {
      const grow = resultsMayGrowLine(pending);
      if (grow) gallery.append(el("p", { class: "hits__notice", role: "status", text: grow }));
    }

    // Folders first: a name typed to get somewhere. Their own group, like the to-dos'.
    if (folders.length > 0) {
      gallery.append(el("h2", { class: "section-head" }, el("span", { text: plural(folders.length, "folder") })));
      gallery.append(cardList(...folders.map((f) => ctx.folderCard(f))));
    }

    if (results.length === 0 && (more || folders.length > 0)) {
      if (more) gallery.append(more);
      const cov = coverageBlock();
      if (cov) gallery.append(cov);
      return;
    }

    if (results.length === 0) {
      if (searchState.kind === "error" && ctx.treeLoaded()) {
        // Gated on the walk: the index raises while the tree cache is still empty,
        // which is early, not failed.
        gallery.append(ctx.emptyState("Couldn't search", "Something went wrong in this browser's search. Keep typing to try again."));
      } else if (searchState.kind === "searching" || searchState.kind === "idle" || !ctx.treeLoaded()) {
        // No "No matches" until the walk lands (`rail.settle()` repaints); the empty
        // transcript answer usually arrives before the tree the name half needs.
        gallery.append(ctx.emptyState("Searching…", "Looking through names, handwriting, typed text, to-dos and digests."));
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
        "h2",
        { class: "section-head" },
        el("span", { text: searchCountLabel(results.length, pages) }),
      ),
    );
    // The digests and to-dos are the person's writing: before the first
    // document that is neither named like the query nor a note, else at the end.
    const at = results.findIndex((r) => !r.nameMatched && !r.written);
    const cards = results.map((result, i) => ctx.resultCard(result, i, q, expansions));
    // Two lists around them when they sit between the results.
    const split = more && at >= 0 ? at : cards.length;
    if (split > 0) gallery.append(cardList(...cards.slice(0, split)));
    if (more) gallery.append(more);
    if (split < cards.length) gallery.append(cardList(...cards.slice(split)));
    const cov = coverageBlock();
    if (cov) gallery.append(cov);
  }

  return { renderSearch, coverageBlock };
}
