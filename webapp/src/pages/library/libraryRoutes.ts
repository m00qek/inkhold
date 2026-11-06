// The library's route handlers: each place a URL names, and opening notes, versions and trashed files.

import { parseView, viewPath } from "../todo/todoModel";
import { destinationHref, folderHref, notePageHref, redirect, replaceRoute, searchHref, todoHref } from "../../router";
import { resolveVersionShort } from "../versionShort";
import type { Api } from "../../api/types";
import type { Id, NoteMeta, NoteSummary } from "../../core/types";
import type { ReaderOrigin } from "../reader/reader";
import { crumbPath } from "../rail";
import { BIN_KEY } from "../bin/bin";
import type { LibraryCtx } from "./libraryContext";
import { type AppShell, ADMIN_KEY, ACCOUNT_KEY, TODO_KEY, synthesizeSummary } from "./library";

/** The route handlers of `AppShell`, plus the folder path the reader shows. */
export interface LibraryRoutes extends Pick<AppShell, "showFolder" | "showSearch" | "showDestination" | "showAccount" | "showTodo" | "openNote" | "openNoteVersion" | "openBinNote"> {
  /** Null at the root. Names via `rail.labelFor`, never `folder.name`. */
  currentFolderPath(): string | null;
}

export function createLibraryRoutes(ctx: LibraryCtx): LibraryRoutes {
  const { st } = ctx;
  /**
  * The note's folder path from the whole-tree cache (search results carry no
  * folder), flattened like the breadcrumb. Null when unknown; the reader then
  * omits it rather than guessing.
  */
  function folderPathOf(noteId: Id): string | null {
    for (const cached of ctx.folderCache.values()) {
      if (!cached.entries.some((e) => e.kind === "note" && e.id === noteId)) continue;
      const names = crumbPath(cached.path).map((f) => ctx.rail.labelFor(f));
      return names.length === 0 ? null : names.join(" / ");
    }
    return null;
  }

  /** Null at the root. Names via `rail.labelFor`, never `folder.name`. */
  function currentFolderPath(): string | null {
    const pending = ctx.rail.pending();
    if (pending) return pending.label;
    if (!st.listing) return null;
    const names = crumbPath(st.listing.path).map((f) => ctx.rail.labelFor(f));
    return names.length === 0 ? null : names.join(" / ");
  }

  /**
  * A non-empty shell query makes it a search arrival. `folder` names where the
  * user stands (Back returns to that listing); `search` names the note's own
  * folder, which the user doesn't know yet.
  */
  function readerReturn(noteId: Id): { origin: ReaderOrigin; href: string } {
    // Bin first: a trashed file is in no folder or search; its path is the one it
    // had when deleted.
    if (ctx.bin.isTrashed(noteId)) {
      // So the viewer paints the same countdown as the bin row.
      return {
        origin: { kind: "bin", folderPath: ctx.bin.pathOf(noteId), retention: ctx.bin.retentionOf(noteId) },
        href: destinationHref(BIN_KEY),
      };
    }
    // A task's notebook link: Back returns to the To-Do page it was on.
    const todoView = ctx.todo?.view();
    if (todoView) return { origin: { kind: "todo", folderPath: folderPathOf(noteId) }, href: todoHref(viewPath(todoView)) };
    // The shell's `query`, never the route's `?q=`, which is in-note find.
    const q = st.query.trim();
    if (q) return { origin: { kind: "search", folderPath: folderPathOf(noteId) }, href: searchHref(q) };
    return { origin: { kind: "folder", folderPath: currentFolderPath() }, href: folderHref(st.folderId) };
  }

  /** The shell-level reset every route into a place performs. */
  function enterPlace(): void {
    st.routeToken++;
    ctx.hideActiveViewer();
    ctx.setReading(false);
    ctx.rail.clearPending();
  }

  /**
   * Browsing works offline (the listings are kept on the device, `sw/sw.js`);
   * opening a file, a version or To-Do needs the server. Say so instead of
   * showing a viewer that can never fill, and stay where the person was.
   */
  function offline(): boolean {
    if (navigator.onLine) return false;
    ctx.toast("You're offline. Opening files and To-Do needs a connection.");
    // Back to the folder or search on screen; never to To-Do, which would
    // refuse again.
    redirect(st.query ? searchHref(st.query) : folderHref(st.folderId));
    return true;
  }

  return {
    currentFolderPath,

    showFolder(id: Id | null): void {
      enterPlace();
      ctx.leaveAdmin();
      ctx.leaveAccount();
      ctx.leaveTodo();
      st.destination = null;
      void ctx.data.navigate(id);
      requestAnimationFrame(() => ctx.galleryEngine.repaintVisible());
    },

    showSearch(q: string): void {
      // An empty `#/search` is corrected, not rendered.
      if (q.trim() === "") {
        redirect(folderHref(st.folderId));
        return;
      }
      enterPlace();
      st.destination = null;
      const box = ctx.topbar.searchInput;
      // Someone typing is ahead of the route the first keystroke started: the
      // box is the truth, and the URL follows it. Otherwise (a reload, a shared
      // link) the box takes the URL's query.
      if (document.activeElement === box && box.value.trim() !== "") {
        if (box.value !== q) replaceRoute(searchHref(box.value));
        q = box.value;
      } else if (box.value !== q) {
        box.value = q;
      }
      ctx.modes.applyQuery(q);
      // After the arriving-keystroke navigation's blur; a no-op otherwise.
      ctx.topbar.restoreSearchFocus();
    },

    showDestination(key: string): void {
      enterPlace();
      ctx.leaveAccount();
      ctx.leaveTodo();
      st.query = "";
      ctx.topbar.searchInput.value = "";
      ctx.search.reset();
      // Assigned per arm: the admin arm must first repaint over a mounted bin, which
      // `renderGallery` refuses while `destination` names one.
      st.destination = null;
      switch (key) {
        // --- BIN ROUTE ---
        case BIN_KEY:
          ctx.leaveAdmin(); // one st.destination at a time
          ctx.leaveTodo();
          st.destination = key;
          ctx.bin.open();
          ctx.rail.build(); // the ctx.bin is open now; repaint the highlight
          return;
        // --- ADMIN ROUTE ---
        case ADMIN_KEY:
          // The bin closes by being repainted over; do it while `destination` is null so
          // the guard lets it through.
          if (ctx.bin.isOpen()) ctx.render.renderGallery({ rail: false });
          ctx.leaveTodo();
          st.destination = key;
          ctx.openAdmin();
          return;
        default:
          // Unreachable via the router; a removed destination's URL still lands somewhere.
          redirect(folderHref(st.folderId));
          return;
      }
    },

    showTodo(view: string): void {
      if (offline()) return;
      enterPlace();
      // Same as the account arm: repaint over a mounted bin while `destination` is null.
      if (ctx.bin.isOpen()) ctx.render.renderGallery({ rail: false });
      ctx.leaveAdmin();
      ctx.leaveAccount();
      st.query = "";
      ctx.topbar.searchInput.value = "";
      ctx.search.reset();
      st.destination = TODO_KEY;
      ctx.todo.open(parseView(view));
      ctx.rail.build();
    },

    showAccount(): void {
      enterPlace();
      // Same as the admin arm.
      if (ctx.bin.isOpen()) ctx.render.renderGallery({ rail: false });
      ctx.leaveAdmin();
      ctx.leaveTodo();
      st.query = "";
      ctx.topbar.searchInput.value = "";
      ctx.search.reset();
      st.destination = ACCOUNT_KEY;
      ctx.account().open();
      // No rail row matches, so the highlight goes off.
      ctx.rail.build();
    },

    async openNote(id: Id, page = 0, q = ""): Promise<void> {
      if (offline()) return;
      const mine = ++st.routeToken;
      ctx.historyScope.clear();
      try {
        const { origin, href } = readerReturn(id);
      
        let summary: NoteSummary | undefined;
        if (st.listing) {
          summary = st.listing.entries.find((e): e is NoteSummary => e.kind === "note" && e.id === id);
        }
      
        let metaPromise: Promise<NoteMeta>;
        if (summary) {
          metaPromise = ctx.api.getNoteMeta(id);
        } else {
          const meta = await ctx.api.getNoteMeta(id);
          if (mine !== st.routeToken) return;
          summary = synthesizeSummary(meta);
          metaPromise = Promise.resolve(meta);
        }
      
        st.readerBack = href;
        // To-Do covers the content area; the note opens in its place.
        if (origin.kind === "todo") ctx.leaveTodo();
        const v = ctx.viewers.viewerFor(summary.fileType);
        ctx.viewers.activate(v);
        v.open(summary, metaPromise, page, origin, q);
        ctx.setReading(true, summary.name);
      } catch (e) {
        if (ctx.handled(e)) return;
        ctx.toast("That note couldn't be opened.");
        // `redirect`, not `go`: a gone note never named a place.
        redirect(folderHref(st.folderId));
      }
    },

    async openNoteVersion(id: Id, short: string, page = 0): Promise<void> {
      if (offline()) return;
      const mine = ++st.routeToken;
      // Resolved against the panel's list; a non-session failure degrades to the live note.
      let history: Awaited<ReturnType<Api["noteHistory"]>>;
      try {
        history = await ctx.api.noteHistory(id);
      } catch (e) {
        if (mine !== st.routeToken) return;
        if (ctx.handled(e)) return;
        redirect(notePageHref(id, page));
        return;
      }
      if (mine !== st.routeToken) return; // routed away while fetching
      const match = resolveVersionShort(history.versions, short);
      if (match.kind === "past") {
        await ctx.previews.openHistoryPreview(id, match.version, page);
        return;
      }
      // Current or none: the live note at its canonical URL (`redirect` replaces).
      // Current must not 404 after a restore; none gets a notice.
      if (match.kind === "none") ctx.toast("That version is no longer available.");
      redirect(notePageHref(id, page));
    },

    async openBinNote(id: Id, page = 0): Promise<void> {
      if (offline()) return;
      const mine = ++st.routeToken;
      // A bin open is never a version preview.
      ctx.historyScope.clear();
      // On a cold `#/bin/note/:id` this awaits the boot listing.
      try {
        await ctx.bin.ensureLoaded();
      } catch (e) {
        if (mine !== st.routeToken) return;
        if (ctx.handled(e)) return;
        // The bin will show its own load error.
        redirect(destinationHref(BIN_KEY));
        return;
      }
      if (mine !== st.routeToken) return; // routed away while the st.listing loaded
      // Not in the bin (purged, restored, never trashed): the listing plus a notice.
      if (!ctx.bin.isTrashed(id)) {
        ctx.toast("That file is no longer in the recycle bin.");
        redirect(destinationHref(BIN_KEY));
        return;
      }
      try {
        // The same origin a row click produces; meta comes via `binScope`.
        const { origin, href } = readerReturn(id);
        const meta = await ctx.api.getNoteMeta(id);
        if (mine !== st.routeToken) return; // routed away while fetching
        st.readerBack = href;
        const v = ctx.viewers.viewerFor(meta.fileType);
        ctx.viewers.activate(v);
        v.open(synthesizeSummary(meta), Promise.resolve(meta), page, origin, "");
        ctx.setReading(true, meta.name);
      } catch (e) {
        if (ctx.handled(e)) return;
        ctx.toast("That file couldn't be opened.");
        redirect(destinationHref(BIN_KEY));
      }
    },
  };
}
