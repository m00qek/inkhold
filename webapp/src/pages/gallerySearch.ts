// The library-wide (universal) SEARCH renderer, extracted from the library
// shell. It merges the two halves of one query — names matched against the
// cached tree, transcripts from the index — into a single document list and
// paints it into the gallery (`renderSearch`). The controller still owns the
// search controller, the gallery element and the live search state; this module
// reads them through {@link GallerySearchCtx} and calls back into the card
// factory (`galleryCards.resultCard`) for each row.
//
// ONE QUERY, ONE SCOPE, ONE LIST. The library used to answer a query twice: a
// gallery filtered by NAME to the folder you were standing in, plus a separate
// block of transcript matches from the WHOLE library. Both halves are
// library-wide now, and both land in one list of documents.
//
// THE LIST IS PAINTED ONCE AND WHOLE. There is no append path any more: the
// index answers with every matching document at once, so there is no second page
// to grow into and no cursor to spend (`golden-search.md` §4.3). What can still
// change under a painted list is the CORPUS — a derive landing, a sync arriving
// — and that is a repaint, not a growth.

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
 * routes on: the index names documents by id and says nothing about what kind of
 * thing a document is, which is right — a second opinion about that is exactly
 * the copy the manifest deliberately does not ship.
 */
function segmentKind(note: NoteSummary): number {
  return note.fileType.trim().toLowerCase() === "txt" ? 1 : 0;
}

/**
 * What the search renderer needs from the shell. The controller keeps owning
 * the gallery, the lazy engine, the live search state and the search
 * controller; this reads them through getters/callbacks so the renderer always
 * reflects the state at paint time, exactly as the inline closures did.
 */
export interface GallerySearchCtx {
  /** The gallery `<section>` the results paint into. */
  gallery: HTMLElement;
  /** The live universal-search state (results/searching/error). */
  getSearchState: () => SearchState;
  /** The whole-tree listing cache — BOTH halves of a query read it (see `searchResults`). */
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
  resultCard: (result: SearchResult, i: number, q: string, expansions?: readonly Expansion[]) => HTMLElement;
  /** The shell's empty/loading state block. */
  emptyState: (title: string, body: string) => HTMLElement;
  /**
   * How many of the caller's documents are still being derived, as last heard
   * from the live channel's `event: index` frame — `null` when this server has
   * not said (an old server, or a client that fell back to polling).
   *
   * READ AT PAINT TIME, not captured, so the frame that arrives while results
   * are on screen changes what the next repaint says. It is now the ONLY source
   * for the number: a search answers out of the local index and no response
   * accompanies it, so the zero-hit coverage block the server used to attach —
   * the only other place this count ever came from — has nothing to ride on.
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
   *
   * `prefetchTree` walks the WHOLE (household-sized) tree, so this really is the
   * library and not just the folder in view — which is what makes a library-wide
   * name match possible on the client, with no round trip and no new endpoint.
   * A note reachable from two listings (it is not, but the map makes it so) is
   * counted once.
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
   * THE LISTING IS THE OTHER HALF OF EVERY ROW, not just of the name matches.
   * A `LocalHit` is an md5, a file id and a set of page ordinals — deliberately
   * no name, because the app already holds the listing and shipping names in the
   * index would be a second copy of them (§4.1). So a hit is JOINED to the
   * cached tree, and a hit the tree does not name is DROPPED rather than rendered
   * anonymously. That is not a workaround for the missing name: §2.7 says the
   * local index may legitimately be a SUPERSET of the live library — an index
   * built before a delete, a document another device removed — and that
   * correctness comes from intersecting hits with the listing. The join is the
   * intersection.
   *
   * The cost is a real one and it is bounded: while `prefetchTree` is still
   * walking, a hit in a folder it has not reached yet is invisible. That is the
   * same window `treeLoaded` already gates the "No matches" claim on, and it
   * closes on its own.
   *
   * ORDER: documents whose NAME matched come first. They answer the query
   * literally, and the index ranks by matching pages, which has no opinion about
   * a name it never read. Within each half the order is preserved: rank order
   * for transcript hits, the tree's own order for names. The renderer never
   * re-sorts — `rankDocuments` already put them in matching-pages-then-recency
   * order.
   */
  function searchResults(q: string): SearchResult[] {
    const searchState = ctx.getSearchState();
    const needle = q.toLowerCase();
    const cached = allCachedNotes();
    const byId = new Map<Id, SearchResult>();

    if (searchState.kind === "results") {
      for (const doc of searchState.documents) {
        // KEYED ON `fileId`, WHICH IS WHAT THE LISTING CAN BE JOINED ON. The
        // index knows a document by its md5 and carries the file id beside it;
        // the listing is keyed by id, so the id is the side of the pair both
        // halves of a row have.
        //
        // `files.id` arrives from the index as a number and from the listing as
        // its decimal string (the seam stringifies every id — see `client.ts`).
        // One spelling, chosen here, so the join cannot silently match nothing.
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
      // A NAME-ONLY match reached no page, so its summary is null.
      byId.set(noteId, { noteId, note, folderPath, nameMatched: true, pages: [], kind: segmentKind(note) });
    }

    const all = [...byId.values()];
    return [...all.filter((r) => r.nameMatched), ...all.filter((r) => !r.nameMatched)];
  }

  /**
   * The line that says what the typo ladder searched — `golden-search.md` §4.3's
   * "matched **reunião**", and the last piece of it that was still unrendered.
   *
   * ## ONCE, OVER THE LIST — not on the rows
   *
   * The expansion is per TOKEN of the query, so the substitution that explains
   * the top row explains the bottom one identically; a per-row line would be one
   * sentence repeated down the page for no added fact. Worse, it would be a
   * FALSE sentence on the rows that matched by NAME — those matched the typed
   * spelling exactly, and no expansion is why they are here. A header is the
   * only placement where the sentence is true of everything under it, and it is
   * the same rule `.hits__notice` already exists for.
   *
   * It goes ABOVE the completeness caveat because it is about a different thing
   * and a prior one: `resultsMayGrowLine` qualifies the list, this qualifies the
   * QUERY, and a reader who does not yet know which word was searched has no use
   * for a note about the list growing.
   *
   * ## Gated on a row that the expansion actually produced
   *
   * `indexSearch.ts` already refuses to report a substitution over an empty
   * answer, but this renderer intersects again — a hit whose document the cached
   * tree cannot name is dropped (see `searchResults`) — so the engine's guard is
   * not this view's guard. If every transcript hit fell out of that join and the
   * list is standing on name matches alone, the sentence would be explaining
   * rows it had nothing to do with. So it is said only when a row with pages
   * survived to carry it.
   *
   * ## Nodes, never markup
   *
   * Both halves are device-authored text — a term from the index's own
   * vocabulary, a token out of the search box — and this app deleted its last
   * `innerHTML` of anything like that in step 6. Each part becomes a text node
   * or an element built with `text:`, so there is no escaping pass to forget.
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
   * What the results header says.
   *
   * IT COUNTS WHAT IT IS SHOWING, and that is the whole rule. The "N+" floors
   * are gone with the cursor: the old header spoke in "3+ notes · 20+ pages"
   * because the server terminated at a page boundary and never counted its
   * matches, and a local index has already paid for every match it holds.
   *
   * `LocalResults.totalPages` is deliberately NOT the number rendered, even
   * though it is exact. It counts matching pages across every document the
   * ENGINE matched, and the list has already dropped any document the listing
   * does not name (see `searchResults`), so a header built from it could exceed
   * the rows underneath it. Summing the painted rows cannot: it is what is on
   * screen.
   *
   * BOTH numbers, because grouping made them different questions: how many
   * documents to look in, and how much there is in them.
   */
  function searchCountLabel(notes: number, pages: number): string {
    return pages > 0 ? `${plural(notes, "note")} · ${plural(pages, "page")}` : plural(notes, "note");
  }

  /**
   * Paint the results list. THE GALLERY IS THE RESULTS — there is no separate
   * hits block any more, because there is no longer a second scope for one to
   * hold.
   *
   * The name half is already in hand (the cached tree), so it paints on the
   * keystroke and the transcript half joins it when the engine answers. The
   * states are kept distinct for the same reason they always were: "searching",
   * "the search failed" and "there is nothing" are three different things, and
   * collapsing the middle one into the last is how a broken search gets mistaken
   * for an empty one.
   */
  function renderSearch(q: string): void {
    const searchState = ctx.getSearchState();
    const results = searchResults(q);
    const pages = results.reduce((n, r) => n + r.pages.length, 0);

    // How many documents are still being derived. The live channel's last frame
    // is the whole story now — a local answer carries no counts to prefer over
    // it, because nothing on the server counts anything at query time.
    const pending = ctx.indexPending() ?? 0;

    // What was actually searched, when the query as typed answered nothing and
    // the ladder stood a vocabulary word in for it. FIRST, above the caveat: it
    // says what the question became, and everything below it is an answer to
    // that question. See `expansionBlock` for why it is one line and not N.
    const expansions = searchState.kind === "results" ? searchState.expansions : [];
    const matched = expansionBlock(expansions, results);
    if (matched) gallery.append(matched);

    // THE COMPLETENESS CAVEAT, over real results only. The list implies "this is
    // what there is"; while a derive is outstanding that is not true, and a
    // reader who does not know it reads a partial answer as a whole one. The
    // empty state says its own, stronger version below.
    if (results.length > 0) {
      const grow = resultsMayGrowLine(pending);
      if (grow) gallery.append(el("p", { class: "hits__notice", role: "status", text: grow }));
    }

    if (results.length === 0) {
      if (searchState.kind === "error" && ctx.treeLoaded()) {
        // Distinct from "no matches", deliberately: a failed search that rendered
        // as an empty one is indistinguishable from a query nobody wrote about.
        //
        // GATED ON THE WALK, like the negative below it. The index intersects
        // its answer with the cached tree and RAISES while that cache is still
        // empty, which is the ordinary state for a couple of hundred ms after
        // boot — before §6 step 6 the server fallback answered through that
        // window, and now nothing does. A query typed into it has not failed; it
        // is early, and "Couldn't search" would be the same confident lie as
        // "No matches".
        gallery.append(ctx.emptyState("Couldn't search", "The recognised text couldn't be searched. Keep typing to retry."));
      } else if (searchState.kind === "searching" || searchState.kind === "idle" || !ctx.treeLoaded()) {
        // THE NEGATIVE IS THE LAST THING SAID. Two halves answer this query and
        // they resolve independently: the transcript half waits on the engine,
        // and the NAME half is matched against the cached tree that
        // `prefetchTree` fills one folder at a time. An empty transcript answer
        // therefore arrives, routinely, before the name half can have been
        // computed against a complete library — and "No matches" painted then is
        // a confident lie about notes whose titles do match.
        //
        // So the walk gates the claim exactly as it gates a category's "is
        // empty" (`rail.loaded()`, and the pending-category branch in
        // `renderGallery`): until the data that could disprove the negative has
        // arrived, this is still a search in progress. `rail.settle()` repaints
        // when it lands — for a query typed inside a subfolder as much as at the
        // root, which is what used to leave this state stranded forever.
        gallery.append(ctx.emptyState("Searching…", "Looking through every note — names, typing and handwriting."));
      } else {
        // BOTH sentences when both apply, pending first: one says waiting will
        // help and the other says it will not, so the transient one has to lead
        // or the reader stops waiting for the thing that is about to arrive.
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
        // The transcript half is still on its way; the name half is already
        // painted. Saying so beats either a spinner over real results or silence.
        searchState.kind === "searching" ? el("span", { class: "hits__count", text: "Searching handwriting…" }) : null,
      ),
    );
    // The expansions ride along to the row for its DEEP LINK only — the row
    // renders nothing about them (see `expansionBlock`), it decides which query
    // the viewer's find opens with.
    for (const [i, result] of results.entries()) gallery.append(ctx.resultCard(result, i, q, expansions));
  }

  return { renderSearch };
}
