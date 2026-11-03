// The library shell: rail, topbar and lazily-thumbnailed gallery, with the
// reader overlaying it. A long-lived controller (created once in main.ts) so
// gallery state survives opening a note. The route is the source of truth:
// every entry point only `go()`s a URL, and the `show*` handlers are the only
// writers of the state that URL describes (see `router.ts`).

import { el } from "../ui/dom";
import { brandMark } from "../ui/chrome";
import { closeOpenMenu } from "../ui/menu";
import { currentTheme, setTheme } from "../ui/theme";
import { SORT_KEY, readLocal, writeLocal } from "../ui/storage";
import {
  accountHref,
  binNotePageHref,
  destinationHref,
  folderHref,
  go,
  noteHref,
  notePageHref,
  redirect,
  replaceBinNotePosition,
  replaceNotePosition,
  replaceNoteVersionPosition,
  replaceRoute,
  searchHref,
} from "../router";
import { resolveVersionShort, shortMd5 } from "./versionShort";
import { createFolderCache } from "./folderCache";
import type { Api } from "../api/types";
import type { NoteRenderer } from "../render/types";
import type { RenderCache } from "../cache/types";
import type { PersistentThumbStore } from "../cache/idb";
import type { IndexStatus, LiveChannel } from "../sync/types";
import type { Entry, Folder, Hash, Id, Listing, NoteMeta, NoteSummary, Theme } from "../core/types";
import { skeletonPage } from "../core/noteSkeleton";
import { ApiError, NameTakenError, dispatchApiFailure, type ApiFailureSink } from "../api/client";
import { openRenameDialog } from "../ui/renameDialog";
import { createUploadZone, type UploadDestination, type UploadZone } from "../ui/uploadZone";
import { openConflictDialog } from "../ui/uploadConflict";
import { createExporter, type Exporter } from "../export/exporter";
import { createLazyEngine, renderPage, type LazyEngine } from "../render/lazy";
import {
  createThumbnails,
  createCanvasThumbPainter,
  createFetchThumbNet,
  type Thumbnails,
} from "../render/thumbnails";
import { createPdfThumbs, type PdfThumbs } from "../render/pdfThumb";
import { classify, reconcile } from "../sync/freshness";
import type { ReaderOrigin } from "./reader";
import type { ViewerDeps } from "./viewer";
import { createViewerSet, type ViewerSet } from "./viewerSet";
import { createMasonry, type Masonry } from "./masonry";
import { createNameplate, createQuotaMeter } from "./railFooter";
import { createTopbar, type SortKey, type Topbar, type View } from "./libraryTopbar";
import { createVersionPreviews, type VersionPreviews } from "./versionPreview";
import { createAdminDestination, type AdminDestination } from "./adminDestination";
import { createNoteSearch, MIN_GLOBAL_QUERY_LEN, type SearchState } from "./noteSearch";
import { createSearchService } from "../search/searchService";
import { createDocSearch } from "../search/docSearch";
import { createGalleryCards, type GalleryCards } from "./galleryCards";
import { createCardActions } from "./cardActions";
import { createHistoryScope } from "./historyScope";
import { createHistoryController } from "./historyPanel";
import type { FileVersion } from "../core/types";
import { createGallerySearch, type GallerySearch } from "./gallerySearch";
// The breadcrumb is painted here, but its flattening rule is the rail's.
import { createRail, createRailView, crumbPath, type RailController } from "./rail";
// Paints into `gallery`; `renderGallery()` closes it, so no teardown hook.
import { BIN_KEY, createBin, createBinScope, createBinView, type BinController } from "./bin";
// Static, unlike the console: small, and every user has one.
import { createAccountPage, type AccountHost, type AccountPage } from "./account";

const ADMIN_KEY = "admin";
/**
* Not a `Destination` (no rail row), but written into `destination` so every
* "is a folder listing on screen?" guard treats it like the bin and console.
*/
const ACCOUNT_KEY = "account";

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
  // `folderId`, `destination` and `query` are written only by their `show*`
  // handlers: a cache of the address bar.
  /**
  * `null` = root. Survives a note or destination, so Back or a rail click
  * lands in this folder's cached listing.
  */
  let folderId: Id | null = null;
  /**
  * The rail highlight reads this, not the panels' DOM-derived `isOpen()`, which
  * a sync-bump repaint can change without a route change.
  */
  let destination: string | null = null;
  let listing: Listing | undefined;
  let query = "";
  let sort: SortKey = readStoredSort();
  let view: View = "grid";
  let knownSyncVersion = 0;
  const key = (id: Id | null) => id ?? "\0root";

  // ---- failure routing ----
  /**
  * Expiry arrives in a burst (thumbnails plus the walk); the latch makes one
  * hand-off and blocks re-entry during handling.
  */
  let sessionExpired = false;
  function sessionDidExpire(): void {
    if (sessionExpired) return;
    sessionExpired = true;
    deps.onSessionExpired();
  }

  /**
  * A thumbnail's `?v=` 404'd: refetch the listing (STALE_PAGE). Once per hash,
  * so new hashes that also 404 can't spin.
  */
  const staleHandled = new Set<Hash>();
  function onStaleThumbnail(hash: Hash): void {
    if (sessionExpired || staleHandled.has(hash)) return;
    staleHandled.add(hash);
    void refetch(folderId, folderCache.get(folderId));
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
  // `aria-busy` until the walk lands: counts are provisional.
  const nav = el("nav", { class: "nav", "aria-label": "Folders", "aria-busy": "true" });

  /** The shell keeps only where the user is; the tree lives in `folderCache.ts`. */
  const folderCache = createFolderCache({
    api,
    handled,
    onWalked: (changed) => rail.treeWalked(changed),
  });

  const rail: RailController = createRail({
    view: createRailView(nav),
    tree: folderCache.tree,
    // From the route via `folderId`/`destination`, not panel DOM. A destination
    // reports no folder (one `aria-current` only); the shell's own `folderId` is
    // kept so leaving the bin lands back in that folder.
    place: () =>
      destination !== null
        ? { folderId: null, destination, openPath: null }
        : {
            folderId,
            destination: null,
            openPath: listing ? listing.path : null,
            // See `RailPlace.searching`.
            searching: query.trim() !== "",
          },
    // The rail never navigates; it names a URL.
    onOpenFolder: (id) => go(folderHref(id)),
    onSelectCategory: () => enterPendingCategory(),
    onOpenDestination: (key) => go(destinationHref(key)),
    destinationCount: (key) => {
      switch (key) {
        // --- BIN COUNT ---
        case BIN_KEY:
          return bin.count();
        // --- ADMIN COUNT ---
        // None: a household headcount is an ambient stat about housemates.
        default:
          return 0;
      }
    },
    destinationState: (key) => {
      switch (key) {
        // --- ADMIN STATE ---
        // Read through `isElevated()`, the panel's fact. Locked before the console was
        // ever imported, which is also what the gate will show.
        case ADMIN_KEY:
          return adminDest.isElevated()
            ? { icon: "unlock", label: "Admin console unlocked" }
            : { icon: "lock", label: "Admin console locked" };
        // The bin has a count, and a row has room for one badge.
        default:
          return null;
      }
    },
    isAdmin: () => identity.isAdmin,
    onSettled: () => renderGallery({ rail: false }),
    onLabelsSettled: () => relabelFolders(),
  });

  const nameplate = createNameplate(identity.email, () => go(accountHref()));
  const quota = createQuotaMeter();
  quota.refresh();

  // The storage meter stays under the nameplate: room for the file you're about
  // to drop should be visible at a glance.
  const sidebar = el(
    "aside",
    { class: "rail" },
    el(
      "div",
      { class: "brand" },
      el("span", { class: "brand__mark", html: brandMark() }),
      el("span", { text: "INKHOLD" }),
    ),
    nav,
    nameplate,
    quota.el,
  );

  // ---- DOM: topbar ----
  const topbar: Topbar = createTopbar({
    initialSort: sort,
    folderId: () => folderId,
    applyQuery: (q) => applyQuery(q),
    onSort: (next) => {
      sort = next;
      writeLocal(SORT_KEY, sort);
      renderGallery();
    },
    onView: (next) => setView(next),
    onEmptyBin: () => bin.empty(),
    onLockAdmin: () => adminDest.lock(),
    onFiles: (files) => uploadZone.add(files),
  });
  const { crumbs, searchInput, sortWrap, segmented, uploadBtn, toolsSep, emptyBinBtn, lockAdminBtn } = topbar;

  /** Shared by keystrokes and the `#/search?q=` route; doesn't touch the URL. */
  function applyQuery(next: string): void {
    // The results belong in the gallery, which the console or account page covers.
    leaveAdmin();
    leaveAccount();
    query = next;
    // Names paint on the keystroke from the cached tree; transcripts arrive after
    // the debounce. `rail: false`: typing can't change the tree.
    search.setQuery(query);
    renderGallery({ rail: false });
  }

  // ---- destination mode ----
  // `is-destination` hides the search box (it would search a library not on
  // screen and navigate away). Tracked per destination: `renderGallery()` runs on
  // sync bumps and must not strip another destination's mode.
  const destinationsOpen = { bin: false, admin: false, account: false };
  function setDestinationMode(which: "bin" | "admin" | "account", open: boolean): void {
    // Mutually exclusive: opening one closes the rest, so flags describe one screen.
    if (open) {
      for (const other of ["bin", "admin", "account"] as const) {
        if (other !== which) destinationsOpen[other] = false;
      }
    }
    destinationsOpen[which] = open;
    const anyOpen = destinationsOpen.bin || destinationsOpen.admin || destinationsOpen.account;
    root.classList.toggle("is-destination", anyOpen);

    // Only takes controls away; each destination shows its own action and
    // `renderGallery` brings Upload back.
    if (anyOpen) {
      uploadBtn.hidden = true;
      toolsSep.hidden = true; // never a hairline with nothing after it
    }
    if (!destinationsOpen.bin) emptyBinBtn.hidden = true;
    if (!destinationsOpen.admin) lockAdminBtn.hidden = true;
  }

  function setBinMode(open: boolean, count: number, busy = false): void {
    setDestinationMode("bin", open);
    emptyBinBtn.hidden = !open;
    // Also disabled while its own call is in flight, or a slow-link second press
    // reports failure for a success.
    emptyBinBtn.disabled = count === 0 || busy;
  }

  // ---- DOM: content (gallery + reader) ----
  const gallery = el("section", { class: "gallery", id: "gallery", "aria-label": "Notes" });
  const content = el("div", { class: "content" }, gallery);
  const toastEl = el("div", { class: "toast", role: "status", "aria-live": "polite" });

  // The thumbnail facade: every tile is a WebP blob from one call. PDF page 0
  // uses the viewer's MuPDF wasm, inert until a visible, uncached PDF tile needs
  // it (a persistent `sn-thumbs` hit answers first).
  const pdfThumbs: PdfThumbs = createPdfThumbs();
  const thumbnails: Thumbnails = createThumbnails({
    getTheme: currentTheme,
    net: createFetchThumbNet(),
    painter: createCanvasThumbPainter(),
    renderNote: (noteId, page, theme) => renderPage({ api, renderer, cache, theme }, noteId, page, "thumb"),
    renderPdfPage: pdfThumbs.renderPdfPage,
    persistent: deps.persistentThumbs,
  });
  const galleryEngine: LazyEngine = createLazyEngine({
    api,
    renderer,
    cache,
    getTheme: currentTheme,
    getThumbnail: thumbnails.getThumbnail,
    // Interim floor for a slow produce; see `PLACEHOLDER_AFTER_MS`.
    getGlyph: thumbnails.getGlyph,
    root: content,
    failures,
  });

  // Native image tiles are lazy-loaded by us: Chromium never loads a
  // `loading="lazy"` `<img>` inserted already in the viewport during an SPA
  // re-render. `data-src` is promoted on approach.
  const imgLazy: IntersectionObserver | null =
    typeof IntersectionObserver !== "undefined"
      ? new IntersectionObserver(
          (entries, obs) => {
            for (const e of entries) {
              if (!e.isIntersecting) continue;
              const img = e.target as HTMLImageElement;
              const src = img.dataset.src;
              if (src && !img.src) img.src = src;
              obs.unobserve(img);
            }
          },
          { root: content, rootMargin: "200px" },
        )
      : null;

  // ---- transcript search ----
  // Logic lives in noteSearch.ts. The engine is the browser's own index; no `api`
  // is passed, since there is no library-wide search route.
  let searchState: SearchState = { kind: "idle" };
  const searchService = createSearchService({
    // Stands in for the manifest when this session never synced, so a full local
    // store stays searchable offline. Read fresh: the walk fills it later.
    listing: () =>
      [...folderCache.values()].flatMap((cached) =>
        cached.entries.flatMap((e) =>
          e.kind === "note" && e.fileHash
            // The numeric `fileId` is canonical; `gallerySearch` converts back.
            ? [{ md5: e.fileHash, fileId: Number(e.id), updatedAt: e.updatedAt }]
            : [],
        ),
      ),
  });
  const search = createNoteSearch({
    search: searchService,
    failures,
    view: {
      setState(next) {
        searchState = next;
        // Only engine-arrived states repaint here; `idle`/`searching` callers already render.
        if (next.kind !== "results" && next.kind !== "error") return;
        // One paint per answer: answers are whole. Drawn bitmaps come back off the
        // render cache.
        renderGallery({ rail: false });
      },
    },
  });

  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  function toast(message: string): void {
    toastEl.textContent = message;
    toastEl.classList.add("is-shown");
    if (toastTimer !== undefined) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("is-shown"), 2400);
  }

  const exporter: Exporter = createExporter({ api, renderer });

  // One deps object for every viewer, so Back, Move to bin and position
  // reporting are literally the same closures.
  const viewerDeps: ViewerDeps = {
    api,
    // In-document search: the same wasm FTS5 engine on one document's
    // `text/<md5>`, built once and shared by every viewer. `text/<md5>` is
    // `immutable`, so `index_version` from the manifest rides the query string to
    // bust the cache on re-derivation; read fresh per call.
    docSearch: createDocSearch({ indexVersion: (md5) => searchService.indexVersion(md5) }),
    renderer,
    cache,
    getTheme: currentTheme,
    // Back to where the note was opened from; see `readerBack`.
    onBack: () => go(readerBack),
    toast,
    onSessionExpired: sessionDidExpire,
    // The same `bin.trash` as the card menu (toast, device line), then leave like
    // Back. `kind: "note"` is right for any file type.
    onMoveToBin: (meta) => {
      void bin.trash({ id: meta.id, name: meta.name, kind: "note" });
      go(readerBack);
    },
    // Bin-origin Restore / Delete through the bin controller's by-id methods (the
    // purge confirm included). Navigation waits for the outcome: a cancel or
    // failure leaves the viewer open; success returns to `#/bin`.
    onRestore: (meta) => {
      void bin.restore(meta.id).then((done) => {
        if (done) go(readerBack);
      });
    },
    onPurge: (meta) => {
      void bin.purge(meta.id).then((done) => {
        if (done) go(readerBack);
      });
    },
    // The same `restoreVersion` as the panel. For a PDF's annotations the `.mark`
    // is restored but the document is what reopens.
    onRestoreVersion: (subject, version) =>
      void restoreVersion(subject.id, version, subject.name, subject.annotationsOn ?? subject.id),
    // The same history panel as the card menu; a forward reference, only called on click.
    onVersions: (subject, anchor, viewingMd5) =>
      historyController.open(
        { id: subject.id, name: subject.name, fileType: subject.fileType },
        { anchor, viewingMd5, annotationsOn: subject.annotationsOn },
      ),
    // Rewrites the hash without a history entry. Bin wins first (a trashed version
    // preview is still reached through the bin), then version preview, then live.
    onPosition: (noteId, page, q, versionMd5, bin) =>
      bin
        ? replaceBinNotePosition(noteId, page)
        : versionMd5
          ? replaceNoteVersionPosition(noteId, shortMd5(versionMd5), page)
          : replaceNotePosition(noteId, page, q),
  };

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
    isCurrent: () => destination === ADMIN_KEY,
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
      if (mutated) void refetch(folderId, folderCache.get(folderId));
    },
    handled,
  });
  binScope.attach((id) => bin.isTrashed(id));

  // ---- the extracted features ----
  // Each gets an explicit context; built once every dependency exists. Order
  // matters: cards use `cardActions`' menu, search rows use the card factory.
  const historyController = createHistoryController({
    api,
    host: root,
    toast,
    handled,
    // With `annotationsOn`, `noteId` is a `.mark` and the live document opens
    // with the ink rerouted; without it, the file's past version opens.
    openPreview: (noteId, version, annotationsOn) =>
      void (annotationsOn != null
        ? openAnnotationsPreview(annotationsOn, noteId, version)
        : openHistoryPreview(noteId, version)),
    restore: (noteId, version, noteName) => restoreVersion(noteId, version, noteName),
  });
  /**
  * `entry` is the object the cached listing holds, so one field write plus a
  * repaint updates it; the SSE bump reconciles. `NameTakenError` is rethrown to
  * keep the dialog open.
  */
  async function onRename(entry: Entry): Promise<void> {
    await openRenameDialog({
      host: root,
      entry: {
        name: entry.name,
        fileType: entry.kind === "note" ? entry.fileType : "",
        isFolder: entry.kind === "folder",
      },
      submit: async (fullName) => {
        let updated: Entry;
        try {
          updated = await api.rename(entry.id, fullName);
        } catch (e) {
          if (e instanceof NameTakenError) throw e; // the dialog keeps itself open
          if (handled(e)) return; // a dead session etc. — routed, dialog closes
          toast("Couldn't rename that. Try again.");
          return;
        }
        entry.name = updated.name;
        renderGallery();
        toast(`Renamed to '${updated.name}'.`);
      },
    });
  }

  const cardActions = createCardActions({
    api,
    exporter,
    toast,
    handled,
    sessionDidExpire,
    onTrash: (entry) => void bin.trash(entry),
    onRename: (entry) => void onRename(entry),
    isCategoryRoot: (entry) => entry.kind === "folder" && rail.categoryIconFor(entry) !== null,
    onHistory: (noteSummary, anchor) =>
      historyController.open(
        { id: noteSummary.id, name: noteSummary.name, fileType: noteSummary.fileType },
        { anchor },
      ),
    onAnnotationHistory: (doc, annotationsId, anchor) =>
      historyController.open(
        { id: annotationsId, name: doc.name, fileType: "mark" },
        { anchor, annotationsOn: doc.id },
      ),
  });
  const galleryCards: GalleryCards = createGalleryCards({
    galleryEngine,
    imgLazy,
    getView: () => view,
    labelFor: (folder) => rail.labelFor(folder),
    categoryIconFor: (folder) => rail.categoryIconFor(folder),
    pendingCategoryOf: (folder) => rail.pendingCategoryOf(folder),
    // `selectCategory` already fires `onSelectCategory`; don't call it again.
    onSelectCategory: (cat) => rail.selectCategory(cat),
    scheduleSpan,
    cardMenu: cardActions.cardMenu,
  });
  const gallerySearch: GallerySearch = createGallerySearch({
    gallery,
    getSearchState: () => searchState,
    folders: folderCache,
    treeLoaded: () => rail.loaded(),
    labelFor: (folder) => rail.labelFor(folder),
    resultCard: galleryCards.resultCard,
    emptyState,
    indexPending: () => indexPending,
  });

  /**
  * Read per event, so a drag that ends after a navigation can't upload into
  * the folder left. Null over a destination, results, a pending category or an
  * open viewer: the same places Upload is hidden. `templates` comes from the
  * rail's identity resolution.
  */
  function uploadDestination(): UploadDestination | null {
    if (destination !== null || viewers.active() !== null) return null;
    if (query.trim() !== "" || rail.pending() !== null) return null;
    return {
      id: folderId,
      templates: folderId !== null && rail.categoryFor({ id: folderId })?.templates === true,
    };
  }

  /** The zone owns feedback, pre-flight, progress and toasts; the shell owns the rest. */
  const uploadZone: UploadZone = createUploadZone({
    target: gallery,
    // Over the scroll container, not the gallery, so a short listing's empty space
    // is still a target.
    overlayHost: content,
    listHost: root,
    destination: uploadDestination,
    // Unknown never blocks; the server's 413 is the authority.
    remainingBytes: () => quota.remainingBytes(),
    // File names only: an upload never replaces a folder. Null means unknown, so
    // the zone doesn't ask.
    existingNames: (id) => {
      const cached = folderCache.get(id);
      return cached ? cached.entries.filter((e) => e.kind === "note").map((e) => e.name) : null;
    },
    confirmConflict: (req) => openConflictDialog({ host: root, ...req }),
    upload: (folderIdArg, file, onProgress, signal, onConflict) =>
      api.upload(folderIdArg, file, onProgress, signal, onConflict),
    onUploaded: (entry, dest) => {
      // Optimistic splice, then `refetch` corrects auto-renames.
      const cached = folderCache.get(dest.id);
      if (cached) {
        // A replace keeps its id, so it swaps in place.
        const at = cached.entries.findIndex((e) => e.id === entry.id);
        cached.entries =
          at >= 0 ? cached.entries.map((e, i) => (i === at ? entry : e)) : [...cached.entries, entry];
        if (listing === cached || key(folderId) === key(dest.id)) {
          listing = cached;
          renderGallery();
        }
      }
      quota.refresh();
      void refetch(folderId, folderCache.get(folderId));
      void folderCache.prefetch(true);
    },
    toast,
    handled,
  });

  /** Everything is the shell's; the page owns only where buttons sit. */
  const ACCOUNT_HOST: AccountHost = {
    api,
    account: identity.email,
    content,
    gallery,
    crumbs,
    sortWrap,
    segmented,
    setMode: (open) => setDestinationMode("account", open),
    toast,
root,
    onLeave: () => go(folderHref(null)),
    onOpenBin: () => go(destinationHref(BIN_KEY)),
    onSignOut: () => deps.onSignOut(),
    onSessionExpired: sessionDidExpire,
    onSetTheme: (next) => setThemeTo(next),
  };
  /**
  * Built on first entry, not with the shell: its DOM on the boot path lost the
  * 150 ms `LOADING_PAINT_DELAY_MS` race and broke `slowLink`/`find` e2e tests.
  */
  let accountPage: AccountPage | null = null;
  function account(): AccountPage {
    accountPage ??= createAccountPage(ACCOUNT_HOST);
    return accountPage;
  }

  function leaveAccount(): void {
    accountPage?.close();
  }

  // ---- rendering ----
  function buildCrumbs(): void {
    const parts: (Node | string)[] = [];
    const home = el("button", { type: "button", text: "Library" });
    home.addEventListener("click", () => go(folderHref(null)));
    if (query.trim()) {
      // Just "Search": results span the library, so a folder crumb would lie.
      crumbs.replaceChildren(el("span", { class: "crumbs__here", text: "Search" }));
      return;
    }
    const pending = rail.pending();
    if (pending) {
      // "Library" would contradict the highlighted rail row.
      parts.push(home, el("span", { class: "crumbs__sep", text: "/" }), el("span", { class: "crumbs__here", text: pending.label }));
      crumbs.replaceChildren(...parts);
      return;
    }
    if (!listing || (listing.folderId === null && listing.path.length === 0)) {
      parts.push(el("span", { class: "crumbs__here", text: "Library" }));
    } else {
      parts.push(home);
      const trail = crumbPath(listing.path);
      trail.forEach((folder, i) => {
        parts.push(el("span", { class: "crumbs__sep", text: "/" }));
        // The rail's label, so the crumb can't read `EXPORT` beside `Export`.
        const label = rail.labelFor(folder);
        if (i === trail.length - 1) {
          parts.push(el("span", { class: "crumbs__here", text: label }));
        } else {
          const crumb = el("button", { type: "button", text: label });
          crumb.addEventListener("click", () => go(folderHref(folder.id)));
          parts.push(crumb);
        }
      });
    }
    crumbs.replaceChildren(...parts);
  }

  /**
  * The narrow repaint the walk owes a folder listing: crumbs and folder cards
  * only, without resetting the render engine. Folder cards precede note cards,
  * so they line up by position; a length mismatch touches nothing.
  */
  function relabelFolders(): void {
    if (!galleryIsOnScreen()) return;
    buildCrumbs();
    if (query.trim() !== "" || !listing) return;
    const folders = visibleEntries().filter((e): e is Folder => e.kind === "folder");
    if (folders.length === 0) return;
    const cards = gallery.querySelectorAll<HTMLElement>(".card--folder");
    if (cards.length !== folders.length) return;

    // Only cards whose label or category status moved: a replaced node is
    // detached from under the user's hover or focus, and this runs on every sync.
    const stale = folders.filter((folder, i) => {
      const card = cards[i]!;
      const labelMoved = card.querySelector(".card__title")?.textContent !== rail.labelFor(folder);
      const categoryMoved = card.classList.contains("card--category") !== (rail.categoryIconFor(folder) !== null);
      return labelMoved || categoryMoved;
    });
    if (stale.length === 0) return;

    closeOpenMenu(); // a folder row's menu is about to be replaced
    folders.forEach((folder, i) => {
      if (!stale.includes(folder)) return;
      cards[i]!.replaceWith(galleryCards.folderCard(folder));
    });
    scheduleSpan();
  }

  function visibleEntries(): Entry[] {
    if (!listing) return [];
    // Only the root is rewritten (containers out). No query filter: a query
    // replaces the gallery with library-wide results.
    const entries = folderId === null ? rail.rootEntries(listing.entries) : listing.entries;
    const folders = entries.filter((e): e is Folder => e.kind === "folder");
    const notes = entries.filter((e): e is NoteSummary => e.kind === "note");
    notes.sort((a, b) => {
      if (sort === "title") return a.name.localeCompare(b.name);
      if (sort === "pages") return b.pageCount - a.pageCount;
      return b.updatedAt - a.updatedAt;
    });
    return [...folders, ...notes];
  }

  interface RenderOpts {
    /** False on the typing path: typing can't change the tree. */
    rail?: boolean;
  }

  const masonry: Masonry = createMasonry(gallery, () => view === "grid" && query.trim() === "");
  function scheduleSpan(): void {
    masonry.schedule();
  }

  function renderGallery(opts: RenderOpts = {}): void {
    // A destination owns the surface: ambient repaints (walk settling, sync bumps,
    // late search answers) must not paint over it. Route exits reassign
    // `destination` before repainting, so they pass.
    if (destination !== null) return;
    if (opts.rail !== false) rail.build();
    buildCrumbs();
    const searching = query.trim() !== "";
    sortWrap.hidden = searching;
    segmented.hidden = searching;
    // `uploadDestination()` decides, so the button and drop target agree.
    uploadBtn.hidden = uploadDestination() === null;
    toolsSep.hidden = uploadBtn.hidden;
    // This repaint is how the bin closes, so it also ends bin mode.
    setBinMode(false, 0);
    // Results are always a list: only a row has room for path, date and page count.
    gallery.className = `gallery${searching || view === "list" ? " is-list" : ""}`;
    galleryEngine.reset();
    imgLazy?.disconnect(); // drop the previous repaint's native-image observations
    closeOpenMenu(); // a card/row menu's DOM is about to be replaced
    gallery.replaceChildren();
    // Scheduled before appending; `spanTiles` knows which layouts span.
    scheduleSpan();

    if (searching) {
      const q = query.trim();
      // Below the floor: a quiet hint, no search. In-doc find is unaffected.
      if (q.length < MIN_GLOBAL_QUERY_LEN) {
        gallery.append(
          emptyState("Keep typing", `Type at least ${MIN_GLOBAL_QUERY_LEN} characters to search your library.`),
        );
        return;
      }
      gallerySearch.renderSearch(q);
      return;
    }

    const pending = rail.pending();
    if (pending) {
      gallery.append(
        rail.loaded()
          ? // Nothing to list and no id to list it with: a destination, not a
            // load and not a failure.
            emptyState(`${pending.label} is empty`, pending.pending)
          : emptyState("Loading…", "Fetching your notebooks."),
      );
      return;
    }

    if (!listing) {
      gallery.append(emptyState("Loading…", "Fetching your notebooks."));
      return;
    }
    const entries = visibleEntries();
    if (entries.length === 0) {
      // The empty state names the thing to do; a cloud file reaches the device on
      // the next sync.
      gallery.append(
        emptyState(
          "This folder is empty",
          "Drop a PDF here to read it on your Nomad — or it'll fill up as your Supernote syncs.",
        ),
      );
      return;
    }

    gallery.append(el("div", { class: "section-head" }, el("span", { text: listingSummary(entries) })));

    for (const [i, entry] of entries.entries()) {
      gallery.append(entry.kind === "folder" ? galleryCards.folderCard(entry) : galleryCards.noteCard(entry, i));
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
      el("div", { class: "empty__mark", text: rail.pending()?.label ?? (folderId ? "Folder" : "Library") }),
      el("h3", { text: title }),
      el("p", { text: body }),
    );
  }

  // ---- where the reader was opened from ----
  /**
  * The note's folder path from the whole-tree cache (search results carry no
  * folder), flattened like the breadcrumb. Null when unknown; the reader then
  * omits it rather than guessing.
  */
  function folderPathOf(noteId: Id): string | null {
    for (const cached of folderCache.values()) {
      if (!cached.entries.some((e) => e.kind === "note" && e.id === noteId)) continue;
      const names = crumbPath(cached.path).map((f) => rail.labelFor(f));
      return names.length === 0 ? null : names.join(" / ");
    }
    return null;
  }

  /** Null at the root. Names via `rail.labelFor`, never `folder.name`. */
  function currentFolderPath(): string | null {
    const pending = rail.pending();
    if (pending) return pending.label;
    if (!listing) return null;
    const names = crumbPath(listing.path).map((f) => rail.labelFor(f));
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
    if (bin.isTrashed(noteId)) {
      // So the viewer paints the same countdown as the bin row.
      return {
        origin: { kind: "bin", folderPath: bin.pathOf(noteId), retention: bin.retentionOf(noteId) },
        href: destinationHref(BIN_KEY),
      };
    }
    // The shell's `query`, never the route's `?q=`, which is in-note find.
    const q = query.trim();
    if (q) return { origin: { kind: "search", folderPath: folderPathOf(noteId) }, href: searchHref(q) };
    return { origin: { kind: "folder", folderPath: currentFolderPath() }, href: folderHref(folderId) };
  }

  /**
  * Back pushes this URL rather than `history.back()`: a note opened from a
  * shared link has no app entry beneath it, and the origin is still needed to
  * name the button.
  */
  let readerBack = folderHref(null);

  /** Reading hides the topbar; toggled only in `openNote` and `enterPlace`. */
  function setReading(reading: boolean): void {
    root.classList.toggle("is-reading", reading);
  }

  const previews: VersionPreviews = createVersionPreviews({
    api,
    viewers,
    historyScope,
    host: root,
    isTrashed: (id) => bin.isTrashed(id),
    currentFolderPath,
    folderHref: () => folderHref(folderId),
    setReaderBack: (href) => {
      readerBack = href;
    },
    setReading,
    nextRoute: () => ++routeToken,
    isRoute: (token) => token === routeToken,
    synthesizeSummary,
    onRestored: (returnTo) => {
      void refetch(folderId, folderCache.get(folderId));
      rail.build();
      go(noteHref(returnTo));
    },
    toast,
    handled,
  });
  function openHistoryPreview(noteId: Id, version: FileVersion, startPage = 0): Promise<void> {
    return previews.openHistory(noteId, version, startPage);
  }
  function openAnnotationsPreview(documentId: Id, markId: Id, version: FileVersion): Promise<void> {
    return previews.openAnnotations(documentId, markId, version);
  }
  function restoreVersion(
    noteId: Id,
    version: { md5: string; createdAt: number },
    _noteName: string,
    returnTo: Id = noteId,
  ): Promise<boolean> {
    return previews.restore(noteId, version, returnTo);
  }

  /**
  * Bumped per library/note transition, so a late `getNoteMeta` can't reopen the
  * reader (and hide the topbar) over a folder route.
  */
  let routeToken = 0;

  // ---- data / freshness ----
  /**
  * A category with no device folder yet: not a root navigation, no request.
  * The one unaddressable place (no id); the URL is replaced with the root so it
  * doesn't lie, via `replaceRoute` so the pending state survives.
  */
  function enterPendingCategory(): void {
    hideActiveViewer();
    setReading(false);
    leaveAdmin();
    leaveAccount();
    destination = null;
    folderId = null;
    listing = undefined;
    query = "";
    searchInput.value = "";
    search.reset();
    replaceRoute(folderHref(null));
    renderGallery();
  }

  // ---- the delayed loading paint ----
  // Loading, known-empty and "still the last folder" are different states. The
  // "Loading…" paint is delayed so a fast response shows none at all.

  /** The usual "no longer instantaneous" threshold. */
  const LOADING_PAINT_DELAY_MS = 150;

  let loadingPaintTimer: ReturnType<typeof setTimeout> | undefined;

  function cancelLoadingPaint(): void {
    if (loadingPaintTimer === undefined) return;
    clearTimeout(loadingPaintTimer);
    loadingPaintTimer = undefined;
  }

  /**
  * Paints only the place it was armed for: re-reads `folderId`, `query` and
  * `destination` and drops itself if any moved.
  */
  function scheduleLoadingPaint(id: Id | null): void {
    cancelLoadingPaint();
    loadingPaintTimer = setTimeout(() => {
      loadingPaintTimer = undefined;
      if (folderId !== id || destination !== null || query.trim() !== "") return;
      if (listing !== undefined) return; // a listing arrived by another path
      // The walk may have cached it meanwhile.
      const cached = folderCache.get(id);
      if (cached) listing = cached;
      renderGallery();
    }, LOADING_PAINT_DELAY_MS);
  }

  /**
  * The `#/folder/:id` route body. A container is rendered normally (it really
  * holds those folders). A deep link doesn't wait for the walk; only the rail
  * highlight is provisional until `rail.treeWalked()`.
  */
  async function navigate(id: Id | null): Promise<void> {
    // Overlapping navigations: the token keeps a slow one from cancelling the
    // newer one's loading paint.
    const mine = routeToken;
    cancelLoadingPaint();
    rail.clearPending();
    folderId = id;
    query = "";
    searchInput.value = "";
    // Clears transcript hits too.
    search.reset();
    const cached = folderCache.get(id);
    if (cached) {
      listing = cached;
      renderGallery(); // stale-while-revalidate: paint immediately
    } else {
      // Cache miss: drop `listing` now (it describes the old folder, and any repaint
      // meanwhile would mix the two); only the paint waits.
      listing = undefined;
      scheduleLoadingPaint(id);
    }
    await refetch(id, cached);
    if (mine === routeToken) cancelLoadingPaint();
  }

  /**
  * A 404, or an empty `path` for a non-null id, both mean the folder is gone.
  * `redirect`, not `go`, so Back can't climb onto it; the toast explains.
  */
  function missingFolder(): void {
    toast("That folder isn't there any more.");
    redirect(folderHref(null));
  }

  /**
  * Late answers about a place the user has left are dropped, so a stale folder
  * failure can't replace an open bin or redirect out of it.
  */
  function galleryIsOnScreen(): boolean {
    return destination === null && !bin.isOpen();
  }

  async function refetch(id: Id | null, prev: Listing | undefined): Promise<void> {
    let fresh: Listing;
    try {
      // Through the cache, so boot's root listing and walk share one request.
      fresh = await folderCache.listFolder(id);
    } catch (e) {
      // A dead session isn't "couldn't load".
      if (handled(e)) return;
      if (id !== folderId) return; // navigated away while failing
      if (!galleryIsOnScreen()) return;
      // A 404 won't improve on retry; other failures keep the retry state.
      if (id !== null && e instanceof ApiError && e.status === 404) {
        missingFolder();
        return;
      }
      if (!prev) {
        listing = undefined;
        gallery.replaceChildren(emptyState("Couldn't load", "Check your connection and try again."));
      }
      return;
    }
    if (id !== folderId) return; // navigated away while fetching
    // The root legitimately has an empty path.
    if (id !== null && fresh.path.length === 0) {
      if (galleryIsOnScreen()) missingFolder();
      return;
    }
    knownSyncVersion = Math.max(knownSyncVersion, fresh.syncVersion);

    const result = reconcile(prev, fresh);
    // `result.listing` keeps unchanged entry objects, so identity-keyed work stays put.
    folderCache.put(id, result.listing);
    if (result.changed || listing !== result.listing) {
      listing = result.listing;
      // Not while the bin is open: a restore triggers this refetch and repainting
      // would close the bin.
      if (!bin.isOpen()) renderGallery();
    }
  }

  /**
  * Documents still being derived, or `null` if the server never said (old
  * server, polling fallback). Null means "say nothing", not zero.
  */
  let indexPending: number | null = null;

  function onBump(version: number): void {
    knownSyncVersion = Math.max(knownSyncVersion, version);
    if (classify(folderCache.get(folderId), knownSyncVersion) === "stale") {
      void refetch(folderId, folderCache.get(folderId));
      void folderCache.prefetch(true);
    }
  }
  /** Repaints only the search, and only when the number moved. */
  function onIndex(status: IndexStatus): void {
    if (status.pending === indexPending) return;
    indexPending = status.pending;
    if (query.trim() !== "" && destination === null && viewers.active() === null) renderGallery();
  }
  const unsubscribe = live.subscribe(onBump, onIndex);

  // The index's lifecycle on the same socket: derive-complete and sync frames
  // coalesce in `attachLive`, so a big sync is a few manifest requests. Nothing
  // here instantiates the engine; only `search()` does.
  const detachSearchLive = searchService.attachLive(live);
  void searchService.syncNow();

  // ---- view / theme ----
  function setView(next: View): void {
    view = next;
    topbar.setView(next);
    renderGallery();
  }

  /** Drop off-theme bitmaps and repaint what's on screen; the rest re-lazy. */
  function repaintForTheme(previous: Theme): void {
    void cache.evictTheme?.(previous);
    thumbnails.evictTheme(previous);
    // The Appearance control claims a theme, including on the OS-flip path.
    accountPage?.themeChanged();
    galleryEngine.bumpTheme();
    reader.bumpTheme();
  }

  /**
  * A no-op if already in force. The first press of the followed theme still
  * pins it, which stops following the OS.
  */
  function setThemeTo(next: Theme): void {
    const previous = currentTheme();
    setTheme(next);
    if (previous === next) {
      accountPage?.themeChanged();
      return;
    }
    repaintForTheme(previous);
  }

  // Follow the OS theme until one is pinned (`data-theme` wins). Handlers are
  // named so `destroy()` can remove them.
  const osThemeQuery = window.matchMedia?.("(prefers-color-scheme: dark)");
  const onOsThemeChange = (e: MediaQueryListEvent): void => {
    if (document.documentElement.getAttribute("data-theme")) return;
    // The theme being left is the inverse of the new one.
    repaintForTheme(e.matches ? "light" : "dark");
  };
  osThemeQuery?.addEventListener("change", onOsThemeChange);

  let resizeTimer: ReturnType<typeof setTimeout> | undefined;
  const onWindowResize = (): void => {
    if (resizeTimer !== undefined) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      galleryEngine.repaintVisible();
      reader.bumpTheme();
    }, 150);
  };
  window.addEventListener("resize", onWindowResize);

  /** The shell-level reset every route into a place performs. */
  function enterPlace(): void {
    routeToken++;
    hideActiveViewer();
    setReading(false);
    rail.clearPending();
  }

  // The first listing comes from main.ts's route dispatch; listing here would race it.
  void folderCache.prefetch();

  return {
    el: root,

    showFolder(id: Id | null): void {
      enterPlace();
      leaveAdmin();
      leaveAccount();
      destination = null;
      void navigate(id);
      requestAnimationFrame(() => galleryEngine.repaintVisible());
    },

    showSearch(q: string): void {
      // An empty `#/search` is corrected, not rendered.
      if (q.trim() === "") {
        redirect(folderHref(folderId));
        return;
      }
      enterPlace();
      destination = null;
      // The box agrees with the URL on reload or shared link.
      if (searchInput.value !== q) searchInput.value = q;
      applyQuery(q);
      // After the arriving-keystroke navigation's blur; a no-op otherwise.
      topbar.restoreSearchFocus();
    },

    showDestination(key: string): void {
      enterPlace();
      leaveAccount();
      query = "";
      searchInput.value = "";
      search.reset();
      // Assigned per arm: the admin arm must first repaint over a mounted bin, which
      // `renderGallery` refuses while `destination` names one.
      destination = null;
      switch (key) {
        // --- BIN ROUTE ---
        case BIN_KEY:
          leaveAdmin(); // one destination at a time
          destination = key;
          bin.open();
          rail.build(); // the bin is open now; repaint the highlight
          return;
        // --- ADMIN ROUTE ---
        case ADMIN_KEY:
          // The bin closes by being repainted over; do it while `destination` is null so
          // the guard lets it through.
          if (bin.isOpen()) renderGallery({ rail: false });
          destination = key;
          openAdmin();
          return;
        default:
          // Unreachable via the router; a removed destination's URL still lands somewhere.
          redirect(folderHref(folderId));
          return;
      }
    },

    showAccount(): void {
      enterPlace();
      // Same as the admin arm.
      if (bin.isOpen()) renderGallery({ rail: false });
      leaveAdmin();
      query = "";
      searchInput.value = "";
      search.reset();
      destination = ACCOUNT_KEY;
      account().open();
      // No rail row matches, so the highlight goes off.
      rail.build();
    },

    async openNote(id: Id, page = 0, q = ""): Promise<void> {
      const mine = ++routeToken;
      historyScope.clear();
      try {
        const { origin, href } = readerReturn(id);
        
        let summary: NoteSummary | undefined;
        if (listing) {
          summary = listing.entries.find((e): e is NoteSummary => e.kind === "note" && e.id === id);
        }
        
        let metaPromise: Promise<NoteMeta>;
        if (summary) {
          metaPromise = api.getNoteMeta(id);
        } else {
          const meta = await api.getNoteMeta(id);
          if (mine !== routeToken) return;
          summary = synthesizeSummary(meta);
          metaPromise = Promise.resolve(meta);
        }
        
        readerBack = href;
        const v = viewerFor(summary.fileType);
        activate(v);
        v.open(summary, metaPromise, page, origin, q);
        setReading(true);
      } catch (e) {
        if (handled(e)) return;
        toast("That note couldn't be opened.");
        // `redirect`, not `go`: a gone note never named a place.
        redirect(folderHref(folderId));
      }
    },

    async openNoteVersion(id: Id, short: string, page = 0): Promise<void> {
      const mine = ++routeToken;
      // Resolved against the panel's list; a non-session failure degrades to the live note.
      let history: Awaited<ReturnType<typeof api.noteHistory>>;
      try {
        history = await api.noteHistory(id);
      } catch (e) {
        if (mine !== routeToken) return;
        if (handled(e)) return;
        redirect(notePageHref(id, page));
        return;
      }
      if (mine !== routeToken) return; // routed away while fetching
      const match = resolveVersionShort(history.versions, short);
      if (match.kind === "past") {
        await openHistoryPreview(id, match.version, page);
        return;
      }
      // Current or none: the live note at its canonical URL (`redirect` replaces).
      // Current must not 404 after a restore; none gets a notice.
      if (match.kind === "none") toast("That version is no longer available.");
      redirect(notePageHref(id, page));
    },

    async openBinNote(id: Id, page = 0): Promise<void> {
      const mine = ++routeToken;
      // A bin open is never a version preview.
      historyScope.clear();
      // On a cold `#/bin/note/:id` this awaits the boot listing.
      try {
        await bin.ensureLoaded();
      } catch (e) {
        if (mine !== routeToken) return;
        if (handled(e)) return;
        // The bin will show its own load error.
        redirect(destinationHref(BIN_KEY));
        return;
      }
      if (mine !== routeToken) return; // routed away while the listing loaded
      // Not in the bin (purged, restored, never trashed): the listing plus a notice.
      if (!bin.isTrashed(id)) {
        toast("That file is no longer in the recycle bin.");
        redirect(destinationHref(BIN_KEY));
        return;
      }
      try {
        // The same origin a row click produces; meta comes via `binScope`.
        const { origin, href } = readerReturn(id);
        const meta = await api.getNoteMeta(id);
        if (mine !== routeToken) return; // routed away while fetching
        readerBack = href;
        const v = viewerFor(meta.fileType);
        activate(v);
        v.open(synthesizeSummary(meta), Promise.resolve(meta), page, origin, "");
        setReading(true);
      } catch (e) {
        if (handled(e)) return;
        toast("That file couldn't be opened.");
        redirect(destinationHref(BIN_KEY));
      }
    },

    destroy(): void {
      unsubscribe();
      // Otherwise one coalescing window and engine memory leak per sign-in cycle.
      detachSearchLive();
      searchService.dispose();
      // Otherwise these accumulate per sign-in cycle, each holding the shell alive.
      osThemeQuery?.removeEventListener("change", onOsThemeChange);
      window.removeEventListener("resize", onWindowResize);
      if (resizeTimer !== undefined) clearTimeout(resizeTimer);
      cancelLoadingPaint();
      // Kills the debounce timer and orphans in-flight queries.
      search.reset();
      bin.destroy();
      viewers.destroy();
      adminDest.destroy();
      accountPage?.destroy();
      // Aborts uploads and drops the document-level drag swallowers.
      uploadZone.destroy();
      galleryEngine.destroy();
      // Release the ~5 MB MuPDF worker now, not after its idle window.
      pdfThumbs.destroy();
    },
  };
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
