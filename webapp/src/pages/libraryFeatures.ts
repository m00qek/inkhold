// The library's feature wiring: version history, rename, card actions, gallery cards and search rows, uploads, and the account page's host.

import { destinationHref, folderHref, go } from "../router";
import { createFolderCache } from "./folderCache";
import type { Entry, Id } from "../core/types";
import { NameTakenError } from "../api/client";
import { openRenameDialog } from "../ui/renameDialog";
import { createUploadZone, type UploadDestination, type UploadZone } from "../ui/uploadZone";
import { openConflictDialog } from "../ui/uploadConflict";
import { type Exporter } from "../export/exporter";
import { type LazyEngine } from "../render/lazy";
import { type ViewerSet } from "./viewerSet";
import { createQuotaMeter } from "./railFooter";
import { createGalleryCards, type GalleryCards } from "./galleryCards";
import { createCardActions } from "./cardActions";
import { createHistoryController } from "./historyPanel";
import type { FileVersion } from "../core/types";
import { createGallerySearch, type GallerySearch } from "./gallerySearch";
// The breadcrumb is painted here, but its flattening rule is the rail's.
import { type RailController } from "./rail";
// Paints into `gallery`; `renderGallery()` closes it, so no teardown hook.
import { BIN_KEY, type BinController } from "./bin";
// Static, unlike the console: small, and every user has one.
import { type AccountHost, type AccountPage } from "./account";
import type { LibraryState } from "./libraryState";
import { createLibraryRender } from "./libraryRender";
import { createLibraryData } from "./libraryData";
import { createLibraryView } from "./libraryView";
import { type AppDeps } from "./library";

import type { Topbar } from "./libraryTopbar";
import type { Api } from "../api/types";

export interface LibraryFeaturesParts {
  deps: AppDeps;
  sessionDidExpire: () => void;
  handled: (e: unknown) => boolean;
  setDestinationMode: (which: "bin" | "admin" | "account", open: boolean) => void;
  toast: (message: string) => void;
  account: () => AccountPage;
  scheduleSpan: () => void;
  openHistoryPreview: (noteId: Id, version: FileVersion, startPage?: number) => Promise<void>;
  openAnnotationsPreview: (documentId: Id, markId: Id, version: FileVersion) => Promise<void>;
  restoreVersion: (noteId: Id, version: { md5: string; createdAt: number }, _noteName: string, returnTo?: Id) => Promise<boolean>;
  identity: () => AppDeps["identity"];
  api: () => Api;
  setThemeTo: () => ReturnType<typeof createLibraryView>["setThemeTo"];
  refetch: () => ReturnType<typeof createLibraryData>["refetch"];
  renderGallery: () => ReturnType<typeof createLibraryRender>["renderGallery"];
  emptyState: () => ReturnType<typeof createLibraryRender>["emptyState"];
  key: () => (id: Id | null) => string;
  folderCache: () => ReturnType<typeof createFolderCache>;
  rail: () => RailController;
  quota: () => ReturnType<typeof createQuotaMeter>;
  crumbs: () => Topbar["crumbs"];
  sortWrap: () => Topbar["sortWrap"];
  segmented: () => Topbar["segmented"];
  gallery: () => HTMLElementTagNameMap["section"];
  content: () => HTMLElementTagNameMap["div"];
  galleryEngine: () => LazyEngine;
  imgLazy: () => IntersectionObserver | null;
  exporter: () => Exporter;
  viewers: () => ViewerSet;
  root: () => HTMLElement;
  bin: () => BinController;
}

export function createLibraryFeatures(st: LibraryState, p: LibraryFeaturesParts) {
  // Each gets an explicit context; built once every dependency exists. Order
  // matters: cards use `cardActions`' menu, search rows use the card factory.
  const historyController = createHistoryController({
    api: p.api(),
    host: p.root(),
    toast: p.toast,
    handled: p.handled,
    // With `annotationsOn`, `noteId` is a `.mark` and the live document opens
    // with the ink rerouted; without it, the file's past version opens.
    openPreview: (noteId, version, annotationsOn) =>
      void (annotationsOn != null
        ? p.openAnnotationsPreview(annotationsOn, noteId, version)
        : p.openHistoryPreview(noteId, version)),
    restore: (noteId, version, noteName) => p.restoreVersion(noteId, version, noteName),
  });

  /**
  * `entry` is the object the cached listing holds, so one field write plus a
  * repaint updates it; the SSE bump reconciles. `NameTakenError` is rethrown to
  * keep the dialog open.
  */
  async function onRename(entry: Entry): Promise<void> {
    await openRenameDialog({
      host: p.root(),
      entry: {
        name: entry.name,
        fileType: entry.kind === "note" ? entry.fileType : "",
        isFolder: entry.kind === "folder",
      },
      submit: async (fullName) => {
        let updated: Entry;
        try {
          updated = await p.api().rename(entry.id, fullName);
        } catch (e) {
          if (e instanceof NameTakenError) throw e; // the dialog keeps itself open
          if (p.handled(e)) return; // a dead session etc. — routed, dialog closes
          p.toast("Couldn't rename that. Try again.");
          return;
        }
        entry.name = updated.name;
        p.renderGallery()();
        p.toast(`Renamed to '${updated.name}'.`);
      },
    });
  }

  const cardActions = createCardActions({
    api: p.api(),
    exporter: p.exporter(),
    toast: p.toast,
    handled: p.handled,
    sessionDidExpire: p.sessionDidExpire,
    onTrash: (entry) => void p.bin().trash(entry),
    onRename: (entry) => void onRename(entry),
    isCategoryRoot: (entry) => entry.kind === "folder" && p.rail().categoryIconFor(entry) !== null,
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
    galleryEngine: p.galleryEngine(),
    imgLazy: p.imgLazy(),
    getView: () => st.view,
    labelFor: (folder) => p.rail().labelFor(folder),
    categoryIconFor: (folder) => p.rail().categoryIconFor(folder),
    pendingCategoryOf: (folder) => p.rail().pendingCategoryOf(folder),
    // `selectCategory` already fires `onSelectCategory`; don't call it again.
    onSelectCategory: (cat) => p.rail().selectCategory(cat),
    scheduleSpan: p.scheduleSpan,
    cardMenu: cardActions.cardMenu,
  });

  const gallerySearch: GallerySearch = createGallerySearch({
    gallery: p.gallery(),
    getSearchState: () => st.searchState,
    folders: p.folderCache(),
    treeLoaded: () => p.rail().loaded(),
    labelFor: (folder) => p.rail().labelFor(folder),
    resultCard: galleryCards.resultCard,
    emptyState: p.emptyState(),
    indexPending: () => st.indexPending,
  });

  /**
  * Read per event, so a drag that ends after a navigation can't upload into
  * the folder left. Null over a destination, results, a pending category or an
  * open viewer: the same places Upload is hidden. `templates` comes from the
  * rail's identity resolution.
  */
  function uploadDestination(): UploadDestination | null {
    if (st.destination !== null || p.viewers().active() !== null) return null;
    if (st.query.trim() !== "" || p.rail().pending() !== null) return null;
    return {
      id: st.folderId,
      templates: st.folderId !== null && p.rail().categoryFor({ id: st.folderId })?.templates === true,
    };
  }

  /** The zone owns feedback, pre-flight, progress and toasts; the shell owns the rest. */
  const uploadZone: UploadZone = createUploadZone({
    target: p.gallery(),
    // Over the scroll container, not the gallery, so a short listing's empty space
    // is still a target.
    overlayHost: p.content(),
    listHost: p.root(),
    destination: uploadDestination,
    // Unknown never blocks; the server's 413 is the authority.
    remainingBytes: () => p.quota().remainingBytes(),
    // File names only: an upload never replaces a folder. Null means unknown, so
    // the zone doesn't ask.
    existingNames: (id) => {
      const cached = p.folderCache().get(id);
      return cached ? cached.entries.filter((e) => e.kind === "note").map((e) => e.name) : null;
    },
    confirmConflict: (req) => openConflictDialog({ host: p.root(), ...req }),
    upload: (folderIdArg, file, onProgress, signal, onConflict) =>
      p.api().upload(folderIdArg, file, onProgress, signal, onConflict),
    onUploaded: (entry, dest) => {
      // Optimistic splice, then `refetch` corrects auto-renames.
      const cached = p.folderCache().get(dest.id);
      if (cached) {
        // A replace keeps its id, so it swaps in place.
        const at = cached.entries.findIndex((e) => e.id === entry.id);
        cached.entries =
          at >= 0 ? cached.entries.map((e, i) => (i === at ? entry : e)) : [...cached.entries, entry];
        if (st.listing === cached || p.key()(st.folderId) === p.key()(dest.id)) {
          st.listing = cached;
          p.renderGallery()();
        }
      }
      p.quota().refresh();
      void p.refetch()(st.folderId, p.folderCache().get(st.folderId));
      void p.folderCache().prefetch(true);
    },
    toast: p.toast,
    handled: p.handled,
  });

  /** Everything is the shell's; the page owns only where buttons sit. */
  const ACCOUNT_HOST: AccountHost = {
    api: p.api(),
    account: p.identity().email,
    content: p.content(),
    gallery: p.gallery(),
    crumbs: p.crumbs(),
    sortWrap: p.sortWrap(),
    segmented: p.segmented(),
    setMode: (open) => p.setDestinationMode("account", open),
    toast: p.toast,
  root: p.root(),
    onLeave: () => go(folderHref(null)),
    onOpenBin: () => go(destinationHref(BIN_KEY)),
    onSignOut: () => p.deps.onSignOut(),
    onSessionExpired: p.sessionDidExpire,
    onSetTheme: (next) => p.setThemeTo()(next),
  };

  return { historyController, onRename, cardActions, galleryCards, gallerySearch, uploadDestination, uploadZone, ACCOUNT_HOST };
}
