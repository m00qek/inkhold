// The library's gallery painting: crumbs, the folder listing or search results, and the empty states.

import { el } from "../../ui/dom";
import { closeOpenMenu } from "../../ui/menu";
import { folderHref, go } from "../../router";
import type { Entry, Folder, NoteSummary } from "../../core/types";
import { MIN_GLOBAL_QUERY_LEN } from "../noteSearch";
import { crumbPath } from "../rail";
import type { LibraryCtx } from "./libraryContext";

export interface RenderOpts {
  /** False on the typing path: typing can't change the tree. */
  rail?: boolean;
}

export interface LibraryRender {
  /** The narrow repaint the walk owes a listing: crumbs and folder cards only. */
  relabelFolders(): void;
  renderGallery(opts?: RenderOpts): void;
  emptyState(title: string, body: string): HTMLElement;
}

export function createLibraryRender(ctx: LibraryCtx): LibraryRender {
  const { st } = ctx;
  function buildCrumbs(): void {
    const parts: (Node | string)[] = [];
    const home = el("button", { type: "button", text: "Library" });
    home.addEventListener("click", () => go(folderHref(null)));
    if (st.query.trim()) {
      // Just "Search": results span the library, so a folder crumb would lie.
      ctx.topbar.crumbs.replaceChildren(el("span", { class: "crumbs__here", text: "Search" }));
      return;
    }
    const pending = ctx.rail.pending();
    if (pending) {
      // "Library" would contradict the highlighted rail row.
      parts.push(home, el("span", { class: "crumbs__sep", text: "/" }), el("span", { class: "crumbs__here", text: pending.label }));
      ctx.topbar.crumbs.replaceChildren(...parts);
      return;
    }
    if (!st.listing || (st.listing.folderId === null && st.listing.path.length === 0)) {
      parts.push(el("span", { class: "crumbs__here", text: "Library" }));
    } else {
      parts.push(home);
      const trail = crumbPath(st.listing.path);
      trail.forEach((folder, i) => {
        parts.push(el("span", { class: "crumbs__sep", text: "/" }));
        // The rail's label, so the crumb can't read `EXPORT` beside `Export`.
        const label = ctx.rail.labelFor(folder);
        if (i === trail.length - 1) {
          parts.push(el("span", { class: "crumbs__here", text: label }));
        } else {
          const crumb = el("button", { type: "button", text: label });
          crumb.addEventListener("click", () => go(folderHref(folder.id)));
          parts.push(crumb);
        }
      });
    }
    ctx.topbar.crumbs.replaceChildren(...parts);
  }

  /**
  * The narrow repaint the walk owes a folder listing: crumbs and folder cards
  * only, without resetting the render engine. Folder cards precede note cards,
  * so they line up by position; a length mismatch touches nothing.
  */
  function relabelFolders(): void {
    if (!ctx.data.galleryIsOnScreen()) return;
    buildCrumbs();
    if (st.query.trim() !== "" || !st.listing) return;
    const folders = visibleEntries().filter((e): e is Folder => e.kind === "folder");
    if (folders.length === 0) return;
    const cards = ctx.gallery.querySelectorAll<HTMLElement>(".card--folder");
    if (cards.length !== folders.length) return;

    // Only cards whose label or category status moved: a replaced node is
    // detached from under the user's hover or focus, and this runs on every sync.
    const stale = folders.filter((folder, i) => {
      const card = cards[i]!;
      const labelMoved = card.querySelector(".card__title")?.textContent !== ctx.rail.labelFor(folder);
      const categoryMoved = card.classList.contains("card--category") !== (ctx.rail.categoryIconFor(folder) !== null);
      return labelMoved || categoryMoved;
    });
    if (stale.length === 0) return;

    closeOpenMenu(); // a folder row's menu is about to be replaced
    folders.forEach((folder, i) => {
      if (!stale.includes(folder)) return;
      cards[i]!.replaceWith(ctx.features.galleryCards.folderCard(folder));
    });
    ctx.scheduleSpan();
  }

  function visibleEntries(): Entry[] {
    if (!st.listing) return [];
    // Only the root is rewritten (containers out). No query filter: a query
    // replaces the gallery with library-wide results.
    const entries = st.folderId === null ? ctx.rail.rootEntries(st.listing.entries) : st.listing.entries;
    const folders = entries.filter((e): e is Folder => e.kind === "folder");
    const notes = entries.filter((e): e is NoteSummary => e.kind === "note");
    notes.sort((a, b) => {
      if (st.sort === "title") return a.name.localeCompare(b.name);
      if (st.sort === "pages") return b.pageCount - a.pageCount;
      return b.updatedAt - a.updatedAt;
    });
    return [...folders, ...notes];
  }

  function renderGallery(opts: RenderOpts = {}): void {
    // A destination owns the surface: ambient repaints (walk settling, sync bumps,
    // late search answers) must not paint over it. Route exits reassign
    // `destination` before repainting, so they pass.
    if (st.destination !== null) return;
    if (opts.rail !== false) ctx.rail.build();
    buildCrumbs();
    const searching = st.query.trim() !== "";
    ctx.topbar.sortWrap.hidden = searching;
    ctx.topbar.segmented.hidden = searching;
    // `uploadDestination()` decides, so the button and drop target agree.
    ctx.topbar.uploadBtn.hidden = ctx.features.uploadDestination() === null;
    ctx.topbar.toolsSep.hidden = ctx.topbar.uploadBtn.hidden;
    // This repaint is how the bin closes, so it also ends bin mode.
    ctx.modes.setBinMode(false, 0);
    // Results are always a list: only a row has room for path, date and page count.
    ctx.gallery.className = `gallery${searching || st.view === "list" ? " is-list" : ""}`;
    ctx.galleryEngine.reset();
    ctx.imgLazy?.disconnect(); // drop the previous repaint's native-image observations
    closeOpenMenu(); // a card/row menu's DOM is about to be replaced
    ctx.gallery.replaceChildren();
    // Scheduled before appending; `spanTiles` knows which layouts span.
    ctx.scheduleSpan();

    if (searching) {
      const q = st.query.trim();
      // Below the floor: a quiet hint, no search. In-doc find is unaffected.
      if (q.length < MIN_GLOBAL_QUERY_LEN) {
        ctx.gallery.append(
          emptyState("Keep typing", `Type at least ${MIN_GLOBAL_QUERY_LEN} characters to search your library.`),
        );
        // What search will be able to find, before it runs.
        const cov = ctx.features.gallerySearch.coverageBlock();
        if (cov) ctx.gallery.append(cov);
        return;
      }
      ctx.features.gallerySearch.renderSearch(q);
      return;
    }

    const pending = ctx.rail.pending();
    if (pending) {
      ctx.gallery.append(
        ctx.rail.loaded()
          ? // Nothing to list and no id to list it with: a st.destination, not a
            // load and not a failure.
            emptyState(`${pending.label} is empty`, pending.pending)
          : emptyState("Loading…", "Fetching your notebooks."),
      );
      return;
    }

    if (!st.listing) {
      ctx.gallery.append(emptyState("Loading…", "Fetching your notebooks."));
      return;
    }
    const entries = visibleEntries();
    if (entries.length === 0) {
      // The empty state names the thing to do; a cloud file reaches the device on
      // the next sync.
      ctx.gallery.append(
        emptyState(
          "This folder is empty",
          "Drop a PDF here to read it on your Nomad — or it'll fill up as your Supernote syncs.",
        ),
      );
      return;
    }

    ctx.gallery.append(el("div", { class: "section-head" }, el("span", { text: listingSummary(entries) })));

    for (const [i, entry] of entries.entries()) {
      ctx.gallery.append(entry.kind === "folder" ? ctx.features.galleryCards.folderCard(entry) : ctx.features.galleryCards.noteCard(entry, i));
    }
  }

  function plural(n: number, one: string): string {
    return `${n} ${n === 1 ? one : `${one}s`}`;
  }

  /**
  * Folders and docs counted separately, each half omitted at zero. "Items" is
  * the total (matching folder rows and the rail); "docs" is any file, type-neutral.
  */
  function listingSummary(entries: Entry[]): string {
    const folders = entries.filter((e) => e.kind === "folder").length;
    const docs = entries.length - folders;
    const parts: string[] = [];
    if (folders > 0) parts.push(plural(folders, "folder"));
    if (docs > 0) parts.push(plural(docs, "doc"));
    return parts.join(" · ");
  }

  function emptyState(title: string, body: string): HTMLElement {
    return el(
      "div",
      { class: "empty" },
      el("div", { class: "empty__mark", text: ctx.rail.pending()?.label ?? (st.folderId ? "Folder" : "Library") }),
      el("h3", { text: title }),
      el("p", { text: body }),
    );
  }

  return { relabelFolders, renderGallery, emptyState };
}
