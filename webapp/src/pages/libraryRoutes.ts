// The library's route handlers: each place a URL names, opening notes, versions and trashed files, and teardown.

import { destinationHref, folderHref, notePageHref, redirect, searchHref } from "../router";
import { resolveVersionShort } from "./versionShort";
import { createFolderCache } from "./folderCache";
import type { Api } from "../api/types";
import type { Id, NoteMeta, NoteSummary } from "../core/types";
import { type LazyEngine } from "../render/lazy";
import { type PdfThumbs } from "../render/pdfThumb";
import type { ReaderOrigin } from "./reader";
import { type ViewerSet } from "./viewerSet";
import { type Topbar } from "./libraryTopbar";
import { type AdminDestination } from "./adminDestination";
import { createNoteSearch } from "./noteSearch";
import { createSearchService } from "../search/searchService";
import { createHistoryScope } from "./historyScope";
import type { FileVersion } from "../core/types";
// The breadcrumb is painted here, but its flattening rule is the rail's.
import { crumbPath, type RailController } from "./rail";
// Paints into `gallery`; `renderGallery()` closes it, so no teardown hook.
import { BIN_KEY, type BinController } from "./bin";
// Static, unlike the console: small, and every user has one.
import { type AccountPage } from "./account";
import type { LibraryState } from "./libraryState";
import { createLibraryRender } from "./libraryRender";
import { createLibraryData } from "./libraryData";
import { createLibraryFeatures } from "./libraryFeatures";
import { type AppShell, ADMIN_KEY, ACCOUNT_KEY, synthesizeSummary } from "./library";

export interface LibraryRoutesParts {
  handled: (e: unknown) => boolean;
  applyQuery: (next: string) => void;
  toast: (message: string) => void;
  hideActiveViewer: () => void;
  account: () => AccountPage;
  leaveAccount: () => void;
  setReading: (reading: boolean) => void;
  openHistoryPreview: (noteId: Id, version: FileVersion, startPage?: number) => Promise<void>;
  historyScope: () => ReturnType<typeof createHistoryScope>;
  api: () => Api;
  cancelLoadingPaint: () => ReturnType<typeof createLibraryData>["cancelLoadingPaint"];
  navigate: () => ReturnType<typeof createLibraryData>["navigate"];
  renderGallery: () => ReturnType<typeof createLibraryRender>["renderGallery"];
  key: () => (id: Id | null) => string;
  folderCache: () => ReturnType<typeof createFolderCache>;
  rail: () => RailController;
  topbar: () => Topbar;
  searchInput: () => Topbar["searchInput"];
  pdfThumbs: () => PdfThumbs;
  galleryEngine: () => LazyEngine;
  searchService: () => ReturnType<typeof createSearchService>;
  search: () => ReturnType<typeof createNoteSearch>;
  viewers: () => ViewerSet;
  viewerFor: () => ViewerSet["viewerFor"];
  activate: () => (ViewerSet)["activate"];
  root: () => HTMLElement;
  adminDest: () => AdminDestination;
  leaveAdmin: () => () => void;
  openAdmin: () => () => void;
  bin: () => BinController;
  uploadZone: () => ReturnType<typeof createLibraryFeatures>["uploadZone"];
  unsubscribe: () => () => void;
  detachSearchLive: () => () => void;
  osThemeQuery: () => MediaQueryList | undefined;
  onOsThemeChange: () => (e: MediaQueryListEvent) => void;
  onWindowResize: () => () => void;
}

export function createLibraryRoutes(st: LibraryState, p: LibraryRoutesParts) {
  /**
  * The note's folder path from the whole-tree cache (search results carry no
  * folder), flattened like the breadcrumb. Null when unknown; the reader then
  * omits it rather than guessing.
  */
  function folderPathOf(noteId: Id): string | null {
    for (const cached of p.folderCache().values()) {
      if (!cached.entries.some((e) => e.kind === "note" && e.id === noteId)) continue;
      const names = crumbPath(cached.path).map((f) => p.rail().labelFor(f));
      return names.length === 0 ? null : names.join(" / ");
    }
    return null;
  }

  /** Null at the root. Names via `rail.labelFor`, never `folder.name`. */
  function currentFolderPath(): string | null {
    const pending = p.rail().pending();
    if (pending) return pending.label;
    if (!st.listing) return null;
    const names = crumbPath(st.listing.path).map((f) => p.rail().labelFor(f));
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
    if (p.bin().isTrashed(noteId)) {
      // So the viewer paints the same countdown as the bin row.
      return {
        origin: { kind: "bin", folderPath: p.bin().pathOf(noteId), retention: p.bin().retentionOf(noteId) },
        href: destinationHref(BIN_KEY),
      };
    }
    // The shell's `query`, never the route's `?q=`, which is in-note find.
    const q = st.query.trim();
    if (q) return { origin: { kind: "search", folderPath: folderPathOf(noteId) }, href: searchHref(q) };
    return { origin: { kind: "folder", folderPath: currentFolderPath() }, href: folderHref(st.folderId) };
  }

  /** The shell-level reset every route into a place performs. */
  function enterPlace(): void {
    st.routeToken++;
    p.hideActiveViewer();
    p.setReading(false);
    p.rail().clearPending();
  }

  const shellApi: AppShell = {
    el: p.root(),

    showFolder(id: Id | null): void {
      enterPlace();
      p.leaveAdmin()();
      p.leaveAccount();
      st.destination = null;
      void p.navigate()(id);
      requestAnimationFrame(() => p.galleryEngine().repaintVisible());
    },

    showSearch(q: string): void {
      // An empty `#/search` is corrected, not rendered.
      if (q.trim() === "") {
        redirect(folderHref(st.folderId));
        return;
      }
      enterPlace();
      st.destination = null;
      // The box agrees with the URL on reload or shared link.
      if (p.searchInput().value !== q) p.searchInput().value = q;
      p.applyQuery(q);
      // After the arriving-keystroke navigation's blur; a no-op otherwise.
      p.topbar().restoreSearchFocus();
    },

    showDestination(key: string): void {
      enterPlace();
      p.leaveAccount();
      st.query = "";
      p.searchInput().value = "";
      p.search().reset();
      // Assigned per arm: the admin arm must first repaint over a mounted bin, which
      // `renderGallery` refuses while `destination` names one.
      st.destination = null;
      switch (key) {
        // --- BIN ROUTE ---
        case BIN_KEY:
          p.leaveAdmin()(); // one st.destination at a time
          st.destination = key;
          p.bin().open();
          p.rail().build(); // the p.bin() is open now; repaint the highlight
          return;
        // --- ADMIN ROUTE ---
        case ADMIN_KEY:
          // The bin closes by being repainted over; do it while `destination` is null so
          // the guard lets it through.
          if (p.bin().isOpen()) p.renderGallery()({ rail: false });
          st.destination = key;
          p.openAdmin()();
          return;
        default:
          // Unreachable via the router; a removed destination's URL still lands somewhere.
          redirect(folderHref(st.folderId));
          return;
      }
    },

    showAccount(): void {
      enterPlace();
      // Same as the admin arm.
      if (p.bin().isOpen()) p.renderGallery()({ rail: false });
      p.leaveAdmin()();
      st.query = "";
      p.searchInput().value = "";
      p.search().reset();
      st.destination = ACCOUNT_KEY;
      p.account().open();
      // No rail row matches, so the highlight goes off.
      p.rail().build();
    },

    async openNote(id: Id, page = 0, q = ""): Promise<void> {
      const mine = ++st.routeToken;
      p.historyScope().clear();
      try {
        const { origin, href } = readerReturn(id);
      
        let summary: NoteSummary | undefined;
        if (st.listing) {
          summary = st.listing.entries.find((e): e is NoteSummary => e.kind === "note" && e.id === id);
        }
      
        let metaPromise: Promise<NoteMeta>;
        if (summary) {
          metaPromise = p.api().getNoteMeta(id);
        } else {
          const meta = await p.api().getNoteMeta(id);
          if (mine !== st.routeToken) return;
          summary = synthesizeSummary(meta);
          metaPromise = Promise.resolve(meta);
        }
      
        st.readerBack = href;
        const v = p.viewerFor()(summary.fileType);
        p.activate()(v);
        v.open(summary, metaPromise, page, origin, q);
        p.setReading(true);
      } catch (e) {
        if (p.handled(e)) return;
        p.toast("That note couldn't be opened.");
        // `redirect`, not `go`: a gone note never named a place.
        redirect(folderHref(st.folderId));
      }
    },

    async openNoteVersion(id: Id, short: string, page = 0): Promise<void> {
      const mine = ++st.routeToken;
      // Resolved against the panel's list; a non-session failure degrades to the live note.
      let history: Awaited<ReturnType<Api["noteHistory"]>>;
      try {
        history = await p.api().noteHistory(id);
      } catch (e) {
        if (mine !== st.routeToken) return;
        if (p.handled(e)) return;
        redirect(notePageHref(id, page));
        return;
      }
      if (mine !== st.routeToken) return; // routed away while fetching
      const match = resolveVersionShort(history.versions, short);
      if (match.kind === "past") {
        await p.openHistoryPreview(id, match.version, page);
        return;
      }
      // Current or none: the live note at its canonical URL (`redirect` replaces).
      // Current must not 404 after a restore; none gets a notice.
      if (match.kind === "none") p.toast("That version is no longer available.");
      redirect(notePageHref(id, page));
    },

    async openBinNote(id: Id, page = 0): Promise<void> {
      const mine = ++st.routeToken;
      // A bin open is never a version preview.
      p.historyScope().clear();
      // On a cold `#/bin/note/:id` this awaits the boot listing.
      try {
        await p.bin().ensureLoaded();
      } catch (e) {
        if (mine !== st.routeToken) return;
        if (p.handled(e)) return;
        // The bin will show its own load error.
        redirect(destinationHref(BIN_KEY));
        return;
      }
      if (mine !== st.routeToken) return; // routed away while the st.listing loaded
      // Not in the bin (purged, restored, never trashed): the listing plus a notice.
      if (!p.bin().isTrashed(id)) {
        p.toast("That file is no longer in the recycle bin.");
        redirect(destinationHref(BIN_KEY));
        return;
      }
      try {
        // The same origin a row click produces; meta comes via `binScope`.
        const { origin, href } = readerReturn(id);
        const meta = await p.api().getNoteMeta(id);
        if (mine !== st.routeToken) return; // routed away while fetching
        st.readerBack = href;
        const v = p.viewerFor()(meta.fileType);
        p.activate()(v);
        v.open(synthesizeSummary(meta), Promise.resolve(meta), page, origin, "");
        p.setReading(true);
      } catch (e) {
        if (p.handled(e)) return;
        p.toast("That file couldn't be opened.");
        redirect(destinationHref(BIN_KEY));
      }
    },

    destroy(): void {
      p.unsubscribe()();
      // Otherwise one coalescing window and engine memory leak per sign-in cycle.
      p.detachSearchLive()();
      p.searchService().dispose();
      // Otherwise these accumulate per sign-in cycle, each holding the shell alive.
      p.osThemeQuery()?.removeEventListener("change", p.onOsThemeChange());
      window.removeEventListener("resize", p.onWindowResize());
      if (st.resizeTimer !== undefined) clearTimeout(st.resizeTimer);
      p.cancelLoadingPaint()();
      // Kills the debounce timer and orphans in-flight queries.
      p.search().reset();
      p.bin().destroy();
      p.viewers().destroy();
      p.adminDest().destroy();
      st.accountPage?.destroy();
      // Aborts uploads and drops the document-level drag swallowers.
      p.uploadZone().destroy();
      p.galleryEngine().destroy();
      // Release the ~5 MB MuPDF worker now, not after its idle window.
      p.pdfThumbs().destroy();
    },
  };

  return { folderPathOf, currentFolderPath, readerReturn, enterPlace, shellApi };
}
