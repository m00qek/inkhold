// The library-wide (universal) SEARCH renderer, extracted from the library
// shell. It merges the two halves of one query — names matched against the
// cached tree, transcripts from the server — into a single note-grouped list,
// paints it into the gallery (`renderSearch`), and grows it in place as later
// pages arrive (`appendSearchResults`). The controller still owns the search
// controller, the gallery element and the live search state; this module reads
// them through {@link GallerySearchCtx} and calls back into the card factory
// (`galleryCards.resultCard`) for each row.
//
// ONE QUERY, ONE SCOPE, ONE LIST. The library used to answer a query twice: a
// gallery filtered by NAME to the folder you were standing in, plus a separate
// block of transcript matches from the WHOLE library. Both halves are
// library-wide now, and both land in one list of notes.

import { el } from "../ui/dom";
import { coverageLine, groupHits, type SearchState } from "./noteSearch";
import { crumbPath } from "./rail";
import type { FolderCache } from "./folderCache";
import type { SearchResult } from "./galleryCards";
import type { Folder, Id, NoteSummary } from "../core/types";
import type { LazyEngine } from "../render/lazy";

/**
 * The one thing said when the service answered approximately, above the results
 * and never per row.
 *
 * WORD-FOR-WORD what find-in-note says beside its counter (`reader.ts`). The two
 * are the same claim about the same fallback in the same service, so a user who
 * has learned one sentence must not have to learn a second.
 */
const FUZZY_NOTICE = "No exact match — showing close matches.";

/** `n thing` / `n things`, with the plural only where it belongs. */
function plural(n: number, one: string): string {
  return `${n} ${n === 1 ? one : `${one}s`}`;
}

/**
 * The search DOM the append path grows, recorded by the full paint. Alive
 * exactly while a painted results list is on screen; any full repaint of the
 * gallery replaces it (or nulls it, for the empty states). `cards` is keyed
 * by note because the LIST is keyed by note — a later page's hit for a note
 * already shown updates that note's row rather than minting a second one.
 */
export interface PaintedSearch {
  query: string;
  /** The section head's count span — `isConnected` doubles as the liveness check. */
  countEl: HTMLElement;
  /** Every painted row, with how many pages it was painted knowing about. */
  cards: Map<Id, { card: HTMLElement; pages: number }>;
  /** The "More results" control's row, or null once the stream is exhausted. */
  moreWrap: HTMLElement | null;
}

/**
 * What the search renderer needs from the shell. The controller keeps owning
 * the gallery, the lazy engine, the live search state and the search
 * controller; this reads them through getters/callbacks so the renderer always
 * reflects the state at paint time, exactly as the inline closures did.
 */
export interface GallerySearchCtx {
  /** The gallery `<section>` the results paint into (and grow within). */
  gallery: HTMLElement;
  /** The gallery's lazy render engine — the append path frees a swapped row's slot. */
  galleryEngine: LazyEngine;
  /** The live universal-search state (results/searching/error/coverage/fuzzy). */
  getSearchState: () => SearchState;
  /** Spend the server's keyset cursor for the next page ("More results"). */
  loadMore: () => Promise<unknown>;
  /** The whole-tree listing cache — the name half of the query reads it. */
  folders: Pick<FolderCache, "values">;
  /**
   * Has the tree walk that FILLS {@link GallerySearchCtx.folders}
   * finished? Until it has, the name half of a query has been matched against a
   * partial library, so an empty result set is not yet an answer — see
   * `renderSearch`.
   */
  treeLoaded: () => boolean;
  /** The rail's category-aware folder label (never `folder.name` directly). */
  labelFor: (folder: Folder) => string;
  /** The card factory's result-row builder. */
  resultCard: (result: SearchResult, i: number, q: string) => HTMLElement;
  /** The shell's empty/loading state block. */
  emptyState: (title: string, body: string) => HTMLElement;
}

export interface GallerySearch {
  /** Paint the results list — THE GALLERY IS THE RESULTS. */
  renderSearch: (q: string) => void;
  /** Grow the painted results in place with the page that just arrived. */
  appendSearchResults: (p: PaintedSearch) => void;
  /** The currently painted results (for the setState append fast-path), or null. */
  getPainted: () => PaintedSearch | null;
}

export function createGallerySearch(ctx: GallerySearchCtx): GallerySearch {
  const { gallery, galleryEngine } = ctx;

  let paintedSearch: PaintedSearch | null = null;

  /**
   * Every note in the cached tree, with the folder each one lives in.
   *
   * `prefetchTree` walks the WHOLE (household-sized) tree, so this really is the
   * library and not just the folder in view — which is exactly what makes a
   * library-wide name match possible on the client, with no round trip and no
   * new endpoint. A note reachable from two listings (it is not, but the map
   * makes it so) is counted once.
   */
  function allCachedNotes(): { note: NoteSummary; folderPath: string | null }[] {
    const seen = new Map<Id, { note: NoteSummary; folderPath: string | null }>();
    for (const cached of ctx.folders.values()) {
      const names = crumbPath(cached.path).map((f) => ctx.labelFor(f));
      const folderPath = names.length === 0 ? null : names.join(" / ");
      for (const e of cached.entries) {
        if (e.kind !== "note" || seen.has(e.id)) continue;
        seen.set(e.id, { note: e, folderPath });
      }
    }
    return [...seen.values()];
  }

  /**
   * Merge the two halves of one query into a single note-grouped list.
   *
   * ORDER: notes whose NAME matched come first. They answer the query literally,
   * and bm25 — the only ranking anything here has — ranks pages, so it has no
   * opinion about a name it never read. Within each half the order is preserved:
   * server rank for transcript hits, the tree's own order for names.
   */
  function searchResults(q: string): SearchResult[] {
    const searchState = ctx.getSearchState();
    const needle = q.toLowerCase();
    const byId = new Map<Id, SearchResult>();

    const grouped = searchState.kind === "results" ? groupHits(searchState.hits) : [];
    for (const group of grouped) {
      byId.set(group.noteId, {
        noteId: group.noteId,
        noteName: group.noteName,
        note: null,
        folderPath: null,
        nameMatched: false,
        pages: group.pages,
        // The hit is the authority on what its segments are — a `.txt`'s
        // paragraphs (kind 1) or a note's pages.
        kind: group.kind,
      });
    }

    for (const { note, folderPath } of allCachedNotes()) {
      const nameMatched = note.name.toLowerCase().includes(needle);
      const existing = byId.get(note.id);
      if (existing) {
        // The listing is the better source for everything but the pages: it
        // carries the thumbnail, the date and the folder the hit does not.
        existing.note = note;
        existing.folderPath = folderPath;
        existing.nameMatched = nameMatched;
        continue;
      }
      if (!nameMatched) continue;
      // A NAME-ONLY match carries no segment hits, so its summary is null and
      // its kind matters only for coherence — derive it from the file type the
      // listing knows (`.txt` → paragraphs), the same source `viewerFor` routes on.
      const kind = note.fileType.trim().toLowerCase() === "txt" ? 1 : 0;
      byId.set(note.id, { noteId: note.id, noteName: note.name, note, folderPath, nameMatched: true, pages: [], kind });
    }

    const all = [...byId.values()];
    return [...all.filter((r) => r.nameMatched), ...all.filter((r) => !r.nameMatched)];
  }

  /**
   * What the results header says. THE HARD RULE (search-architecture.md
   * decision 6): the server never counts its matches — the query terminates at
   * the page boundary precisely so it does not — so when a cursor says more may
   * exist, the header speaks in FLOORS ("3+ notes · 20+ pages"), never in a
   * number that reads as a total. Only when the stream is exhausted (no cursor)
   * are the counts complete, and then they are simply what is on screen.
   */
  function searchCountLabel(notes: number, pages: number, more: boolean): string {
    if (more) return `${notes}+ notes · ${pages}+ pages`;
    // BOTH numbers, because grouping made them different questions: how many
    // notebooks to look in, and how much there is in them.
    return pages > 0 ? `${plural(notes, "note")} · ${plural(pages, "page")}` : plural(notes, "note");
  }

  /**
   * The keyset "more" — the ONE control the capped list offers, existing
   * exactly while the server holds a cursor. A real `<button>` (keyboard
   * reachable for free, `.btn` like every labelled control in the app), and its
   * loading affordance is its own honest state: disabled with the label saying
   * so while the page is in flight, re-armed when the attempt settles, GONE the
   * moment a response returns no cursor — removed by the append path, which
   * makes `isConnected` the natural "still relevant" guard here.
   */
  function moreControl(): HTMLElement {
    const btn = el("button", { class: "btn hits__more-btn", type: "button", text: "More results" });
    btn.addEventListener("click", () => {
      btn.disabled = true;
      btn.textContent = "Loading more…";
      void ctx.loadMore().finally(() => {
        if (btn.isConnected) {
          btn.disabled = false;
          btn.textContent = "More results";
        }
      });
    });
    return el("div", { class: "hits__more" }, btn);
  }

  /**
   * Grow the painted results in place with the page that just arrived — the
   * append half of the contract the setState fast-path enforces. Three moves,
   * none of which touches a row the user is reading:
   *
   *  - a note already on screen that the new page reached again has ITS row
   *    rebuilt in place (`replaceWith`) — the meta line and excerpt may change,
   *    but the row keeps its position, so nothing above or below shifts;
   *  - notes new to the list append at the end, ahead of the More control,
   *    which is exactly where the rank order puts them (later pages are
   *    lower-ranked by construction);
   *  - the header and the More control are updated to the new truth: floors
   *    while a cursor remains, the control removed when none came back.
   */
  function appendSearchResults(p: PaintedSearch): void {
    const q = p.query;
    const results = searchResults(q);
    const pages = results.reduce((n, r) => n + r.pages.length, 0);
    const searchState = ctx.getSearchState();
    const cursor = searchState.kind === "results" ? searchState.cursor : undefined;

    p.countEl.textContent = searchCountLabel(results.length, pages, cursor !== undefined);

    for (const [i, result] of results.entries()) {
      const known = p.cards.get(result.noteId);
      if (known) {
        if (known.pages !== result.pages.length) {
          // Free the old row's lazy slot before the swap — the engine was not
          // reset (that is the point of appending), so its bookkeeping is ours.
          const target = known.card.querySelector("canvas, img");
          if (target instanceof HTMLCanvasElement || target instanceof HTMLImageElement) {
            galleryEngine.remove(target);
          }
          const fresh = ctx.resultCard(result, 0, q);
          known.card.replaceWith(fresh);
          p.cards.set(result.noteId, { card: fresh, pages: result.pages.length });
        }
        continue;
      }
      const card = ctx.resultCard(result, i, q);
      if (p.moreWrap) gallery.insertBefore(card, p.moreWrap);
      else gallery.append(card);
      p.cards.set(result.noteId, { card, pages: result.pages.length });
    }

    if (cursor === undefined && p.moreWrap) {
      // Exhausted: the control disappears rather than disabling — a disabled
      // "More" would be a promise the server just declined to make.
      p.moreWrap.remove();
      p.moreWrap = null;
    }
  }

  /**
   * Paint the results list. THE GALLERY IS THE RESULTS — there is no separate
   * hits block any more, because there is no longer a second scope for one to
   * hold.
   *
   * The name half is already in hand (the cached tree), so it paints on the
   * keystroke and the transcript half grows the list a round-trip later. The
   * states are kept distinct for the same reason they always were: "searching",
   * "the search failed" and "there is nothing" are three different things, and
   * collapsing the middle one into the last is how a broken search gets mistaken
   * for an empty one.
   */
  function renderSearch(q: string): void {
    paintedSearch = null;
    const searchState = ctx.getSearchState();
    const results = searchResults(q);
    const pages = results.reduce((n, r) => n + r.pages.length, 0);

    // Said ONCE, above everything, and only where there is something to qualify:
    // a notice over an empty list would explain nothing.
    if (searchState.kind === "results" && searchState.usedFuzzy && results.length > 0) {
      gallery.append(el("p", { class: "hits__notice", role: "status", text: FUZZY_NOTICE }));
    }

    if (results.length === 0) {
      if (searchState.kind === "error") {
        // Distinct from "no matches", deliberately: a failed search that rendered
        // as an empty one is indistinguishable from a query nobody wrote about.
        gallery.append(ctx.emptyState("Couldn't search", "The recognised text couldn't be searched. Keep typing to retry."));
      } else if (searchState.kind === "searching" || searchState.kind === "idle" || !ctx.treeLoaded()) {
        // THE NEGATIVE IS THE LAST THING SAID. Two halves answer this query and
        // they resolve independently: the transcript half is one round trip, the
        // NAME half is matched against the cached tree that `prefetchTree` fills
        // one folder at a time. A transcript response with no hits therefore
        // arrives, routinely, before the name half can have been computed
        // against a complete library — and "No matches" painted then is a
        // confident lie about notes whose titles do match.
        //
        // So the walk gates the claim exactly as it gates a category's "is
        // empty" (`rail.loaded()`, and the pending-category branch in
        // `renderGallery`): until the data that could disprove the negative has
        // arrived, this is still a search in progress. `rail.settle()` repaints
        // when it lands — for a query typed inside a subfolder as much as at the
        // root, which is what used to leave this state stranded forever.
        gallery.append(ctx.emptyState("Searching…", "Looking through every note — names, typing and handwriting."));
      } else {
        gallery.append(ctx.emptyState(`No matches for “${q}”`, coverageLine(searchState.coverage)));
      }
      return;
    }

    const cursor = searchState.kind === "results" ? searchState.cursor : undefined;
    const countEl = el("span", { text: searchCountLabel(results.length, pages, cursor !== undefined) });
    gallery.append(
      el(
        "div",
        { class: "section-head" },
        countEl,
        // The transcript half is still on its way; the name half is already
        // painted. Saying so beats either a spinner over real results or silence.
        searchState.kind === "searching" ? el("span", { class: "hits__count", text: "Searching handwriting…" }) : null,
      ),
    );
    const cards = new Map<Id, { card: HTMLElement; pages: number }>();
    for (const [i, result] of results.entries()) {
      const card = ctx.resultCard(result, i, q);
      gallery.append(card);
      cards.set(result.noteId, { card, pages: result.pages.length });
    }
    const moreWrap = cursor !== undefined ? moreControl() : null;
    if (moreWrap) gallery.append(moreWrap);
    paintedSearch = { query: q, countEl, cards, moreWrap };
  }

  return { renderSearch, appendSearchResults, getPainted: () => paintedSearch };
}
