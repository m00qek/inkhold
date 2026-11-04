// The library shell: rail, topbar and lazily-thumbnailed gallery, with the
// reader overlaying it. A long-lived controller (created once in main.ts) so
// gallery state survives opening a note. The route is the source of truth:
// every entry point only `go()`s a URL, and the `show*` handlers are the only
// writers of the state that URL describes (see `router.ts`).

import { el } from "../../ui/dom";
import { SORT_KEY, readLocal, writeLocal } from "../../ui/storage";
import { binNotePageHref, folderHref, go } from "../../router";
import type { Api } from "../../api/types";
import type { NoteRenderer } from "../../render/types";
import type { RenderCache } from "../../cache/types";
import type { PersistentThumbStore } from "../../cache/idb";
import type { LiveChannel } from "../../sync/types";
import type { Hash, Id, NoteMeta, NoteSummary } from "../../core/types";
import { skeletonPage } from "../../core/noteSkeleton";
import { dispatchApiFailure, type ApiFailureSink } from "../../api/client";
import { createExporter, type Exporter } from "../../export/exporter";
import { createPdfThumbs, type PdfThumbs } from "../../render/pdfThumb";
import { createViewerSet, type ViewerSet } from "../viewer/viewerSet";
import { createMasonry, type Masonry } from "../masonry";
import { createTopbar, type SortKey, type Topbar } from "./libraryTopbar";
import { createAdminDestination, type AdminDestination } from "../admin/adminDestination";
import { createHistoryScope } from "../historyScope";
// The breadcrumb is painted here, but its flattening rule is the rail's.
// Paints into `gallery`; `renderGallery()` closes it, so no teardown hook.
import { createBin, createBinScope, createBinView, type BinController } from "../bin/bin";
// Static, unlike the console: small, and every user has one.
import { createAccountPage, type AccountPage } from "../account/account";
import type { LibraryState } from "./libraryState";
import { createLibraryRender } from "./libraryRender";
import { createLibraryData } from "./libraryData";
import { createLibraryView } from "./libraryView";
import { createLibraryFeatures } from "./libraryFeatures";
import { createLibraryRoutes } from "./libraryRoutes";
import { createLibraryModes } from "./libraryModes";
import { createLibraryEngines } from "./libraryEngines";
import { createLibraryViewerDeps } from "./libraryViewerDeps";
import { createLibraryPreviews } from "./libraryPreviews";
import { createLibraryRail } from "./libraryRail";

export const ADMIN_KEY = "admin";
/**
* Not a `Destination` (no rail row), but written into `destination` so every
* "is a folder listing on screen?" guard treats it like the bin and console.
*/
export const ACCOUNT_KEY = "account";

export interface AppDeps {
  api: Api;
  renderer: NoteRenderer;
  cache: RenderCache;
  /** The same `sn-thumbs` instance as the render cache: one store, one budget. */
  persistentThumbs?: PersistentThumbStore | null;
  live: LiveChannel;
  /** `isAdmin` hides admin-only rail rows; the server is the access check. */
  identity: { email: string; isAdmin: boolean };
  onSignOut: () => void;
  /** Fired at most once per shell; main.ts owns navigation. */
  onSessionExpired: () => void;
}

/**
* The route handlers, called only by main.ts. Each is idempotent (a route can
* dispatch twice) and closes the reader, console and pending category.
*/
export interface AppShell {
  el: HTMLElement;
  /** The device's folder ids are stable, so a folder link outlives a sync. */
  showFolder(id: Id | null): void;
  /** A blank query redirects to the current folder. */
  showSearch(q: string): void;
  /** `#/admin` always lands on the elevation gate: addressable is not accessible. */
  showDestination(key: string): void;
  /** Not a `Destination`; open to any signed-in user. */
  showAccount(): void;
  /**
  * `page` is 0-based; the router converts from the URL's 1-based pages. `q`
  * primes find-in-note. All from the route, so reloads and links land exactly.
  */
  openNote(id: Id, page?: number, q?: string): Promise<void>;
  /**
  * `short` is a 7-hex md5 prefix resolved against `noteHistory`: a past version
  * opens the preview, the current md5 opens the live note with a canonical URL
  * (a restore makes this case common), and no match opens the live note with a
  * notice.
  */
  openNoteVersion(id: Id, short: string, page?: number): Promise<void>;
  /**
  * A trashed file in its viewer via the same path as a bin-row click (waiting
  * for the bin listing on a cold load). A file no longer in the bin falls back
  * to `#/bin` with a notice.
  */
  openBinNote(id: Id, page?: number): Promise<void>;
  destroy(): void;

  // ---- destination views ----
  // A destination is a line in `DESTINATIONS` plus an arm in `showDestination`.
}

/** Validated, not cast: localStorage may hold a stale or hand-edited key. */
function readStoredSort(): SortKey {
  const raw = readLocal(SORT_KEY);
  return raw === "title" || raw === "pages" || raw === "recent" ? raw : "recent";
}

export function createAppShell(deps: AppDeps): AppShell {
  const { renderer, cache, live, identity } = deps;

  /**
  * Wrapped once here so the reader, lazy engine, exporter and `openNote` never
  * learn the bin exists. `attach` comes later; until then nothing is trashed.
  */
  const binScope = createBinScope();

  // Two composed `Api` wrappers: version preview and bin. They never both fire
  // (previews are of live notes) and pass through when inactive.
  const historyScope = createHistoryScope();
  const api = historyScope.wrap(binScope.wrap(deps.api));

  // ---- state ----
  const st: LibraryState = {
    folderId: null,
    destination: null,
    listing: undefined,
    query: "",
    sort: readStoredSort(),
    view: "grid",
    knownSyncVersion: 0,
    sessionExpired: false,
    searchState: { kind: "idle" },
    toastTimer: undefined,
    accountPage: null,
    readerBack: folderHref(null),
    routeToken: 0,
    loadingPaintTimer: undefined,
    indexPending: null,
    resizeTimer: undefined,
  };

  const { applyQuery, setDestinationMode, setBinMode } = createLibraryModes(st, {
    leaveAccount,
    renderGallery: () => renderGallery,
    rail: () => rail,
    uploadBtn: () => uploadBtn,
    toolsSep: () => toolsSep,
    emptyBinBtn: () => emptyBinBtn,
    lockAdminBtn: () => lockAdminBtn,
    destinationsOpen: () => destinationsOpen,
    search: () => search,
    root: () => root,
    leaveAdmin: () => leaveAdmin,
  });

  const { setView, repaintForTheme, setThemeTo } = createLibraryView(st, {
    cache: () => cache,
    renderGallery: () => renderGallery,
    topbar: () => topbar,
    thumbnails: () => thumbnails,
    galleryEngine: () => galleryEngine,
    reader: () => reader,
  });

  const { enterPendingCategory, cancelLoadingPaint, navigate, galleryIsOnScreen, refetch, onBump, onIndex } = createLibraryData(st, {
    handled,
    toast,
    hideActiveViewer,
    leaveAccount,
    setReading,
    renderGallery: () => renderGallery,
    emptyState: () => emptyState,
    folderCache: () => folderCache,
    rail: () => rail,
    searchInput: () => searchInput,
    gallery: () => gallery,
    search: () => search,
    viewers: () => viewers,
    leaveAdmin: () => leaveAdmin,
    bin: () => bin,
  });

  const { relabelFolders, renderGallery, emptyState } = createLibraryRender(st, {
    setBinMode,
    uploadDestination: () => uploadDestination(),
    scheduleSpan,
    galleryIsOnScreen,
    rail: () => rail,
    crumbs: () => crumbs,
    sortWrap: () => sortWrap,
    segmented: () => segmented,
    uploadBtn: () => uploadBtn,
    toolsSep: () => toolsSep,
    gallery: () => gallery,
    galleryEngine: () => galleryEngine,
    imgLazy: () => imgLazy,
    search: () => search,
    galleryCards: () => galleryCards,
    gallerySearch: () => gallerySearch,
  });
  const key = (id: Id | null) => id ?? "\0root";

  // ---- failure routing ----
  function sessionDidExpire(): void {
    if (st.sessionExpired) return;
    st.sessionExpired = true;
    deps.onSessionExpired();
  }

  /**
  * A thumbnail's `?v=` 404'd: refetch the listing (STALE_PAGE). Once per hash,
  * so new hashes that also 404 can't spin.
  */
  const staleHandled = new Set<Hash>();
  function onStaleThumbnail(hash: Hash): void {
    if (st.sessionExpired || staleHandled.has(hash)) return;
    staleHandled.add(hash);
    void refetch(st.folderId, folderCache.get(st.folderId));
  }

  const failures: ApiFailureSink = {
    onSessionExpired: sessionDidExpire,
    onStalePage: (_noteId, page) => onStaleThumbnail(page.hash),
  };

  /** For listing/metadata errors; true means handled, skip the fallback. */
  function handled(e: unknown): boolean {
    return dispatchApiFailure(failures, e);
  }

  // ---- DOM: rail ----
  const { folderCache, rail, quota, sidebar } = createLibraryRail(st, {
    handled,
    identity: () => identity,
    api: () => api,
    enterPendingCategory: () => enterPendingCategory,
    relabelFolders: () => relabelFolders,
    renderGallery: () => renderGallery,
    adminDest: () => adminDest,
    bin: () => bin,
  });

  quota.refresh();

  // ---- DOM: topbar ----
  const topbar: Topbar = createTopbar({
    initialSort: st.sort,
    folderId: () => st.folderId,
    applyQuery: (q) => applyQuery(q),
    onSort: (next) => {
      st.sort = next;
      writeLocal(SORT_KEY, st.sort);
      renderGallery();
    },
    onView: (next) => setView(next),
    onEmptyBin: () => bin.empty(),
    onLockAdmin: () => adminDest.lock(),
    onFiles: (files) => uploadZone.add(files),
  });
  const { crumbs, searchInput, sortWrap, segmented, uploadBtn, toolsSep, emptyBinBtn, lockAdminBtn } = topbar;

  // ---- destination mode ----
  // `is-destination` hides the search box (it would search a library not on
  // screen and navigate away). Tracked per destination: `renderGallery()` runs on
  // sync bumps and must not strip another destination's mode.
  const destinationsOpen = { bin: false, admin: false, account: false };

  // ---- DOM: content (gallery + reader) ----
  const gallery = el("section", { class: "gallery", id: "gallery", "aria-label": "Notes" });
  const content = el("div", { class: "content" }, gallery);
  const toastEl = el("div", { class: "toast", role: "status", "aria-live": "polite" });

  // The thumbnail facade: every tile is a WebP blob from one call. PDF page 0
  // uses the viewer's MuPDF wasm, inert until a visible, uncached PDF tile needs
  // it (a persistent `sn-thumbs` hit answers first).
  const pdfThumbs: PdfThumbs = createPdfThumbs();
  const { thumbnails, galleryEngine, imgLazy, searchService, search } = createLibraryEngines(st, {
    deps,
    renderer: () => renderer,
    cache: () => cache,
    api: () => api,
    renderGallery: () => renderGallery,
    failures: () => failures,
    folderCache: () => folderCache,
    rail: () => rail,
    content: () => content,
    pdfThumbs: () => pdfThumbs,
    root: () => root,
  });

  // ---- transcript search ----

  function toast(message: string): void {
    toastEl.textContent = message;
    toastEl.classList.add("is-shown");
    if (st.toastTimer !== undefined) clearTimeout(st.toastTimer);
    st.toastTimer = setTimeout(() => toastEl.classList.remove("is-shown"), 2400);
  }

  const exporter: Exporter = createExporter({ api, renderer });

  const { viewerDeps } = createLibraryViewerDeps(st, {
    sessionDidExpire,
    toast,
    restoreVersion: (...a) => restoreVersion(...a),
    renderer: () => renderer,
    cache: () => cache,
    api: () => api,
    searchService: () => searchService,
    bin: () => bin,
    historyController: () => historyController,
  });

  const viewers: ViewerSet = createViewerSet(viewerDeps, content, gallery);
  const { reader, viewerFor } = viewers;
  const activate = viewers.activate;

  function hideActiveViewer(): void {
    // The next live read must not stay pinned to a retained version.
    historyScope.clear();
    viewers.hideActive();
  }

  const root = el(
    "div",
    { class: "sn-root" },
    el("div", { class: "app" }, sidebar, el("main", { class: "main" }, topbar.el, content)),
    toastEl,
  );

  const adminDest: AdminDestination = createAdminDestination({
    api,
    account: identity.email,
    content,
    gallery,
    crumbs,
    sortWrap,
    segmented,
    lockBtn: lockAdminBtn,
    setMode: (open) => setDestinationMode("admin", open),
    rebuildRail: () => rail.build(),
    isCurrent: () => st.destination === ADMIN_KEY,
    toast,
    onSessionExpired: sessionDidExpire,
  });
  const leaveAdmin = (): void => adminDest.leave();
  const openAdmin = (): void => adminDest.open();

  const bin: BinController = createBin({
    api,
    // The gallery's own engine; its `reset()` is the bin's teardown.
    view: createBinView({
      gallery,
      crumbs,
      sortWrap,
      segmented,
      root,
      engine: galleryEngine,
      setMode: setBinMode,
      onLeave: () => go(folderHref(null)),
    }),
    // Routed to `#/bin/note/:id` (the live route 404s for trashed files) so Back,
    // reload and copy-link reopen the same trashed file with a `"bin"` origin.
    onOpen: (entry) => go(binNotePageHref(entry.id)),
    onChanged: (mutated) => {
      // The badge moves every refresh; the folder only refetches on a real mutation.
      rail.build();
      if (mutated) void refetch(st.folderId, folderCache.get(st.folderId));
    },
    handled,
  });
  binScope.attach((id) => bin.isTrashed(id));

  // ---- the extracted features ----
  const { historyController, galleryCards, gallerySearch, uploadDestination, uploadZone, ACCOUNT_HOST } = createLibraryFeatures(st, {
    deps,
    sessionDidExpire,
    handled,
    setDestinationMode,
    toast,
    account,
    scheduleSpan,
    openHistoryPreview: (...a) => openHistoryPreview(...a),
    openAnnotationsPreview: (...a) => openAnnotationsPreview(...a),
    restoreVersion: (...a) => restoreVersion(...a),
    identity: () => identity,
    api: () => api,
    setThemeTo: () => setThemeTo,
    refetch: () => refetch,
    renderGallery: () => renderGallery,
    emptyState: () => emptyState,
    key: () => key,
    folderCache: () => folderCache,
    rail: () => rail,
    quota: () => quota,
    crumbs: () => crumbs,
    sortWrap: () => sortWrap,
    segmented: () => segmented,
    gallery: () => gallery,
    content: () => content,
    galleryEngine: () => galleryEngine,
    imgLazy: () => imgLazy,
    exporter: () => exporter,
    viewers: () => viewers,
    root: () => root,
    bin: () => bin,
  });

  function account(): AccountPage {
    st.accountPage ??= createAccountPage(ACCOUNT_HOST);
    return st.accountPage;
  }

  function leaveAccount(): void {
    st.accountPage?.close();
  }

  // ---- rendering ----

  const masonry: Masonry = createMasonry(gallery, () => st.view === "grid" && st.query.trim() === "");
  function scheduleSpan(): void {
    masonry.schedule();
  }

  // ---- where the reader was opened from ----

  /** Reading hides the topbar; toggled only in `openNote` and `enterPlace`. */
  function setReading(reading: boolean): void {
    root.classList.toggle("is-reading", reading);
  }

  const { openHistoryPreview, openAnnotationsPreview, restoreVersion } = createLibraryPreviews(st, {
    handled,
    toast,
    setReading,
    historyScope: () => historyScope,
    api: () => api,
    refetch: () => refetch,
    folderCache: () => folderCache,
    rail: () => rail,
    viewers: () => viewers,
    root: () => root,
    bin: () => bin,
    currentFolderPath: () => currentFolderPath,
  });

  // ---- data / freshness ----

  // ---- the delayed loading paint ----
  // Loading, known-empty and "still the last folder" are different states. The
  // "Loading…" paint is delayed so a fast response shows none at all.

  const unsubscribe = live.subscribe(onBump, onIndex);

  // The index's lifecycle on the same socket: derive-complete and sync frames
  // coalesce in `attachLive`, so a big sync is a few manifest requests. Nothing
  // here instantiates the engine; only `search()` does.
  const detachSearchLive = searchService.attachLive(live);
  void searchService.syncNow();

  // ---- view / theme ----

  // Follow the OS theme until one is pinned (`data-theme` wins). Handlers are
  // named so `destroy()` can remove them.
  const osThemeQuery = window.matchMedia?.("(prefers-color-scheme: dark)");
  const onOsThemeChange = (e: MediaQueryListEvent): void => {
    if (document.documentElement.getAttribute("data-theme")) return;
    // The theme being left is the inverse of the new one.
    repaintForTheme(e.matches ? "light" : "dark");
  };
  osThemeQuery?.addEventListener("change", onOsThemeChange);

  const onWindowResize = (): void => {
    if (st.resizeTimer !== undefined) clearTimeout(st.resizeTimer);
    st.resizeTimer = setTimeout(() => {
      galleryEngine.repaintVisible();
      reader.bumpTheme();
    }, 150);
  };
  window.addEventListener("resize", onWindowResize);

  // The first listing comes from main.ts's route dispatch; listing here would race it.
  void folderCache.prefetch();

  const { currentFolderPath, shellApi } = createLibraryRoutes(st, {
    handled,
    applyQuery,
    toast,
    hideActiveViewer,
    account,
    leaveAccount,
    setReading,
    openHistoryPreview,
    historyScope: () => historyScope,
    api: () => api,
    cancelLoadingPaint: () => cancelLoadingPaint,
    navigate: () => navigate,
    renderGallery: () => renderGallery,
    key: () => key,
    folderCache: () => folderCache,
    rail: () => rail,
    topbar: () => topbar,
    searchInput: () => searchInput,
    pdfThumbs: () => pdfThumbs,
    galleryEngine: () => galleryEngine,
    searchService: () => searchService,
    search: () => search,
    viewers: () => viewers,
    viewerFor: () => viewerFor,
    activate: () => activate,
    root: () => root,
    adminDest: () => adminDest,
    leaveAdmin: () => leaveAdmin,
    openAdmin: () => openAdmin,
    bin: () => bin,
    uploadZone: () => uploadZone,
    unsubscribe: () => unsubscribe,
    detachSearchLive: () => detachSearchLive,
    osThemeQuery: () => osThemeQuery,
    onOsThemeChange: () => onOsThemeChange,
    onWindowResize: () => onWindowResize,
  });
  return shellApi;
}

export function synthesizeSummary(meta: NoteMeta): NoteSummary {
  return {
    kind: "note",
    id: meta.id,
    name: meta.name,
    pageCount: meta.pages.length,
    firstPage: meta.pages[0] ?? skeletonPage(0),
    updatedAt: 0,
    fileType: meta.fileType,
    fileHash: meta.fileHash,
    hasRecognizedText: meta.pages.some((p) => p.textHash !== null),
    thumbAspect: undefined,
    // The meta is the authority on the mark pairing.
    annotationsId: meta.annotationsId,
  };
}
