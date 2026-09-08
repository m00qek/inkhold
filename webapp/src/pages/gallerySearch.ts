// The library-wide SEARCH renderer. It merges the two halves of one query —
// names matched against the cached tree, transcripts from the index — into a
// single document list and paints it into the gallery (`renderSearch`), reading
// the controller's state through {@link GallerySearchCtx} and calling back into
// `galleryCards.resultCard` for each row.
//
// THE LIST IS PAINTED ONCE AND WHOLE — no append path, no cursor (§4.3). What
// can change under a painted list is the CORPUS (a derive landing, a sync
// arriving), and that is a repaint, not a growth.

import { el } from "../ui/dom";
import { coverageLine, expansionNotice, pendingLine, resultsMayGrowLine, type SearchState } from "./noteSearch";
import { crumbPath } from "./rail";
import type { FolderCache } from "./folderCache";
import type { SearchResult } from "./galleryCards";
import type { Expansion } from "../search/localSearch";
import type { Folder, Id, NoteSummary } from "../core/types";

/** `n thing` / `n things`, with the plural only where it belongs. */
function plural(n: number, one: string): string {
  return `${n} ${n === 1 ? one : `${one}s`}`;
}

/**
 * What a row's page ordinals COUNT — a `.txt`'s paragraphs (1) or a `.note`'s
 * pages (0). Read off the listing's own file type, the same source `viewerFor`
 * routes on: the index names documents by id and says nothing about their kind.
 */
function segmentKind(note: NoteSummary): number {
  return note.fileType.trim().toLowerCase() === "txt" ? 1 : 0;
}

/**
 * What the renderer needs from the shell, read through getters/callbacks so a
 * paint always reflects the state at paint time.
 */
export interface GallerySearchCtx {
  /** The gallery `<section>` the results paint into. */
  gallery: HTMLElement;
  /** The live universal-search state (results/searching/error). */
  getSearchState: () => SearchState;
  /** The whole-tree listing cache — BOTH halves of a query read it (see `searchResults`). */
  folders: Pick<FolderCache, "values">;
  /**
   * Has the tree walk that FILLS {@link GallerySearchCtx.folders} finished?
   * Until it has, an empty result set is not yet an answer — see `renderSearch`.
   */
  treeLoaded: () => boolean;
  /** The rail's category-aware folder label (never `folder.name` directly). */
  labelFor: (folder: Folder) => string;
  /** The card factory's result-row builder. */
  resultCard: (result: SearchResult, i: number, q: string, expansions?: readonly Expansion[]) => HTMLElement;
  /** The shell's empty/loading state block. */
  emptyState: (title: string, body: string) => HTMLElement;
  /**
   * How many of the caller's documents are still being derived, as last heard
   * from the live channel's `event: index` frame — `null` when this server has
   * not said. READ AT PAINT TIME, not captured, so a frame arriving while
   * results are on screen changes what the next repaint says. It is the ONLY
   * source for the number: a local answer carries no counts.
   */
  indexPending: () => number | null;
}

export interface GallerySearch {
  /** Paint the results list — THE GALLERY IS THE RESULTS. */
  renderSearch: (q: string) => void;
}

export function createGallerySearch(ctx: GallerySearchCtx): GallerySearch {
  const { gallery } = ctx;

  /**
   * Every note in the cached tree, with the folder each one lives in.
   * `prefetchTree` walks the WHOLE tree, so this really is the library and not
   * the folder in view — which is what makes a library-wide name match possible
   * with no round trip. A note reachable from two listings is counted once.
   */
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
   * Merge the two halves of one query into a single document list.
   *
   * THE LISTING IS THE OTHER HALF OF EVERY ROW. A `LocalHit` is an md5, a file
   * id and page ordinals — the index ships no names (§4.1) — so a hit is JOINED
   * to the cached tree, and a hit the tree does not name is DROPPED rather than
   * rendered anonymously. The drop is also §2.7's correctness: the local index
   * may legitimately be a SUPERSET of the live library (built before a delete,
   * a document another device removed), and intersecting with the listing is
   * what says which documents still exist. The cost: while `prefetchTree` is
   * still walking, a hit in a folder it has not reached is invisible — the same
   * window `treeLoaded` gates "No matches" on, and it closes on its own.
   *
   * ORDER: name matches first (they answer the query literally, and the index
   * has no opinion about a name it never read); within each half the order is
   * preserved. The renderer never re-sorts — `rankDocuments` already did.
   */
  function searchResults(q: string): SearchResult[] {
    const searchState = ctx.getSearchState();
    const needle = q.toLowerCase();
    const cached = allCachedNotes();
    const byId = new Map<Id, SearchResult>();

    if (searchState.kind === "results") {
      for (const doc of searchState.documents) {
        // KEYED ON `fileId` — the one identity both halves of a row have (the
        // index knows a document by md5, the listing by id). It arrives from the
        // index as a number and from the listing as its decimal string (the seam
        // stringifies every id — see `client.ts`): one spelling, chosen here, so
        // the join cannot silently match nothing.
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
   * The line that says what the typo ladder searched — §4.3's "matched
   * **reunião**".
   *
   * ONCE, AS A HEADER — never per row. The expansion is per TOKEN of the query,
   * so one substitution explains every transcript row identically, and a
   * per-row line would be FALSE on the rows that matched by NAME: those matched
   * the typed spelling exactly. A header is the only placement where the
   * sentence is true of everything under it.
   *
   * Gated on a row with pages, because the engine's own guard (no expansion
   * reported over an empty answer) is not this view's guard: `searchResults`
   * intersects again, and if every transcript hit fell out of that join the
   * sentence would be explaining rows it had nothing to do with.
   *
   * Nodes, never markup — both halves are device-authored text (see
   * `ExpansionPart`).
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
   * What the results header says: IT COUNTS WHAT IT IS SHOWING.
   *
   * `LocalResults.totalPages` is deliberately NOT rendered even though it is
   * exact: it counts pages across every document the ENGINE matched, and the
   * list has already dropped documents the listing does not name, so a header
   * built from it could exceed the rows underneath. Summing the painted rows
   * cannot.
   */
  function searchCountLabel(notes: number, pages: number): string {
    return pages > 0 ? `${plural(notes, "note")} · ${plural(pages, "page")}` : plural(notes, "note");
  }

  /**
   * Paint the results list. The name half is already in hand (the cached tree),
   * so it paints on the keystroke; the transcript half joins when the engine
   * answers. "Searching", "failed" and "nothing" stay three distinct states —
   * collapsing the middle one into the last is how a broken search gets mistaken
   * for an empty one.
   */
  function renderSearch(q: string): void {
    const searchState = ctx.getSearchState();
    const results = searchResults(q);
    const pages = results.reduce((n, r) => n + r.pages.length, 0);

    const pending = ctx.indexPending() ?? 0;

    // The expansion line goes FIRST, above the completeness caveat: it says what
    // the question became, and everything below is an answer to that question.
    const expansions = searchState.kind === "results" ? searchState.expansions : [];
    const matched = expansionBlock(expansions, results);
    if (matched) gallery.append(matched);

    // The completeness caveat, over real results only; the empty state says its
    // own, stronger version below.
    if (results.length > 0) {
      const grow = resultsMayGrowLine(pending);
      if (grow) gallery.append(el("p", { class: "hits__notice", role: "status", text: grow }));
    }

    if (results.length === 0) {
      if (searchState.kind === "error" && ctx.treeLoaded()) {
        // GATED ON THE WALK, like the negative below it. The index intersects
        // its answer with the cached tree and RAISES while that cache is still
        // empty — the ordinary state for a couple of hundred ms after boot. A
        // query typed into that window has not failed; it is early, and
        // "Couldn't search" would be the same confident lie as "No matches".
        gallery.append(ctx.emptyState("Couldn't search", "The recognised text couldn't be searched. Keep typing to retry."));
      } else if (searchState.kind === "searching" || searchState.kind === "idle" || !ctx.treeLoaded()) {
        // THE NEGATIVE IS THE LAST THING SAID. The two halves resolve
        // independently, and an empty transcript answer routinely arrives before
        // `prefetchTree` has filled the tree the NAME half is matched against —
        // "No matches" painted then is a confident lie about notes whose titles
        // do match. So the walk gates the claim exactly as it gates a category's
        // "is empty" (`rail.loaded()`), and `rail.settle()` repaints when it
        // lands — inside a subfolder as much as at the root, which is what used
        // to leave this state stranded forever.
        gallery.append(ctx.emptyState("Searching…", "Looking through every note — names, typing and handwriting."));
      } else {
        // Both sentences when both apply, pending first: it is the one that
        // changes what the reader should do next.
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
        // The transcript half is still on its way over an already-painted name half.
        searchState.kind === "searching" ? el("span", { class: "hits__count", text: "Searching handwriting…" }) : null,
      ),
    );
    // The expansions reach the row for its DEEP LINK only (see `expansionBlock`).
    for (const [i, result] of results.entries()) gallery.append(ctx.resultCard(result, i, q, expansions));
  }

  return { renderSearch };
}
