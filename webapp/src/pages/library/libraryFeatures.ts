// The library's feature wiring: version history, rename, card actions, gallery cards and search rows, uploads, and the account page's host.

import { destinationHref, folderHref, go, todoHref } from "../../router";
import type { Entry } from "../../core/types";
import { NameTakenError } from "../../api/client";
import { openRenameDialog } from "../../ui/renameDialog";
import { createUploadZone, type UploadDestination, type UploadZone } from "../../ui/uploadZone";
import { openConflictDialog } from "../../ui/uploadConflict";
import { createGalleryCards, type GalleryCards } from "../galleryCards";
import { createSearchExcerpts } from "../searchExcerpts";
import { createSearchCoverage } from "../searchCoverage";
import { openTextStore } from "../../cache/textStore";
import { createCardActions } from "../cardActions";
import { createHistoryController, type HistoryController } from "../historyPanel";
import { createGallerySearch, type GallerySearch } from "../gallerySearch";
import { BIN_KEY } from "../bin/bin";
import { todoHits } from "../todo/todoSearch";
import { homeView, viewPath } from "../todo/todoModel";
import { type AccountHost } from "../account/account";
import type { LibraryCtx } from "./libraryContext";

export interface LibraryFeatures {
  historyController: HistoryController;
  galleryCards: GalleryCards;
  gallerySearch: GallerySearch;
  /** Where a drop or Upload lands right now; null where Upload is hidden. */
  uploadDestination(): UploadDestination | null;
  uploadZone: UploadZone;
  /** Everything the account page borrows from the shell. */
  accountHost: AccountHost;
}

export function createLibraryFeatures(ctx: LibraryCtx): LibraryFeatures {
  const { st } = ctx;
  // Each gets an explicit context; built once every dependency exists. Order
  // matters: cards use `cardActions`' menu, search rows use the card factory.
  const historyController = createHistoryController({
    api: ctx.api,
    host: ctx.root,
    toast: ctx.toast,
    handled: ctx.handled,
    // With `annotationsOn`, `noteId` is a `.mark` and the live document opens
    // with the ink rerouted; without it, the file's past version opens.
    openPreview: (noteId, version, annotationsOn) =>
      void (annotationsOn != null
        ? ctx.previews.openAnnotationsPreview(annotationsOn, noteId, version)
        : ctx.previews.openHistoryPreview(noteId, version)),
    restore: (noteId, version, noteName) => ctx.previews.restoreVersion(noteId, version, noteName),
  });

  /**
  * `entry` is the object the cached listing holds, so one field write plus a
  * repaint updates it; the SSE bump reconciles. `NameTakenError` is rethrown to
  * keep the dialog open.
  */
  async function onRename(entry: Entry): Promise<void> {
    await openRenameDialog({
      host: ctx.root,
      entry: {
        name: entry.name,
        fileType: entry.kind === "note" ? entry.fileType : "",
        isFolder: entry.kind === "folder",
      },
      submit: async (fullName) => {
        let updated: Entry;
        try {
          updated = await ctx.api.rename(entry.id, fullName);
        } catch (e) {
          if (e instanceof NameTakenError) throw e; // the dialog keeps itself open
          if (ctx.handled(e)) return; // a dead session etc. — routed, dialog closes
          ctx.toast("Couldn't rename that. Try again.");
          return;
        }
        entry.name = updated.name;
        ctx.render.renderGallery();
        ctx.toast(`Renamed to '${updated.name}'.`);
      },
    });
  }

  const cardActions = createCardActions({
    api: ctx.api,
    exporter: ctx.exporter,
    toast: ctx.toast,
    handled: ctx.handled,
    sessionDidExpire: ctx.sessionDidExpire,
    onTrash: (entry) => void ctx.bin.trash(entry),
    onRename: (entry) => void onRename(entry),
    isCategoryRoot: (entry) => entry.kind === "folder" && ctx.rail.categoryIconFor(entry) !== null,
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

  // The line under each search result, from text the browser already holds.
  const excerpts = createSearchExcerpts({ store: openTextStore(), indexVersion: (md5) => ctx.searchService.indexVersion(md5) });
  const galleryCards: GalleryCards = createGalleryCards({
    galleryEngine: ctx.galleryEngine,
    imgLazy: ctx.imgLazy,
    excerpts,
    getView: () => st.view,
    labelFor: (folder) => ctx.rail.labelFor(folder),
    categoryIconFor: (folder) => ctx.rail.categoryIconFor(folder),
    pendingCategoryOf: (folder) => ctx.rail.pendingCategoryOf(folder),
    // `selectCategory` already fires `onSelectCategory`; don't call it again.
    onSelectCategory: (cat) => ctx.rail.selectCategory(cat),
    scheduleSpan: ctx.scheduleSpan,
    cardMenu: cardActions.cardMenu,
  });

  const gallerySearch: GallerySearch = createGallerySearch({
    gallery: ctx.gallery,
    getSearchState: () => st.searchState,
    folders: ctx.folderCache,
    treeLoaded: () => ctx.rail.loaded(),
    labelFor: (folder) => ctx.rail.labelFor(folder),
    resultCard: galleryCards.resultCard,
    folderCard: galleryCards.folderCard,
    emptyState: ctx.render.emptyState,
    indexPending: () => st.indexPending,
    // Repaints only an open search, as the index frame does.
    coverage: createSearchCoverage(ctx.api, () => {
      if (st.query.trim() !== "" && st.destination === null && ctx.viewers.active() === null) ctx.render.renderGallery();
    }),
    moreResults: (q) =>
      todoHits(
        ctx.todo?.snapshot() ?? null,
        q,
        Date.now(),
        (t) => {
          ctx.todo.reveal(t.id);
          go(todoHref(viewPath(homeView(t))));
        },
        (t) => ctx.todoInk.chip(t),
      ),
  });

  /**
  * Read per event, so a drag that ends after a navigation can't upload into
  * the folder left. Null over a destination, results, a pending category or an
  * open viewer: the same places Upload is hidden. `templates` comes from the
  * rail's identity resolution.
  */
  function uploadDestination(): UploadDestination | null {
    if (st.destination !== null || ctx.viewers.active() !== null) return null;
    if (st.query.trim() !== "" || ctx.rail.pending() !== null) return null;
    return {
      id: st.folderId,
      templates: st.folderId !== null && ctx.rail.categoryFor({ id: st.folderId })?.templates === true,
    };
  }

  /** The zone owns feedback, pre-flight, progress and toasts; the shell owns the rest. */
  const uploadZone: UploadZone = createUploadZone({
    target: ctx.gallery,
    // Over the scroll container, not the gallery, so a short listing's empty space
    // is still a target.
    overlayHost: ctx.content,
    listHost: ctx.root,
    destination: uploadDestination,
    // Unknown never blocks; the server's 413 is the authority.
    remainingBytes: () => ctx.quota.remainingBytes(),
    // File names only: an upload never replaces a folder. Null means unknown, so
    // the zone doesn't ask.
    existingNames: (id) => {
      const cached = ctx.folderCache.get(id);
      return cached ? cached.entries.filter((e) => e.kind === "note").map((e) => e.name) : null;
    },
    confirmConflict: (req) => openConflictDialog({ host: ctx.root, ...req }),
    upload: (folderIdArg, file, onProgress, signal, onConflict) =>
      ctx.api.upload(folderIdArg, file, onProgress, signal, onConflict),
    onUploaded: (entry, dest) => {
      // Optimistic splice, then `refetch` corrects auto-renames.
      const cached = ctx.folderCache.get(dest.id);
      if (cached) {
        // A replace keeps its id, so it swaps in place.
        const at = cached.entries.findIndex((e) => e.id === entry.id);
        cached.entries =
          at >= 0 ? cached.entries.map((e, i) => (i === at ? entry : e)) : [...cached.entries, entry];
        if (st.listing === cached || ctx.key(st.folderId) === ctx.key(dest.id)) {
          st.listing = cached;
          ctx.render.renderGallery();
        }
      }
      ctx.quota.refresh();
      void ctx.data.refetch(st.folderId, ctx.folderCache.get(st.folderId));
      void ctx.folderCache.prefetch(true);
    },
    toast: ctx.toast,
    handled: ctx.handled,
  });

  /** Everything is the shell's; the page owns only where buttons sit. */
  const accountHost: AccountHost = {
    api: ctx.api,
    account: ctx.identity.email,
    content: ctx.content,
    gallery: ctx.gallery,
    crumbs: ctx.topbar.crumbs,
    sortWrap: ctx.topbar.sortWrap,
    segmented: ctx.topbar.segmented,
    setMode: (open) => ctx.modes.setDestinationMode("account", open),
    toast: ctx.toast,
  root: ctx.root,
    onLeave: () => go(folderHref(null)),
    onOpenBin: () => go(destinationHref(BIN_KEY)),
    onSignOut: () => ctx.deps.onSignOut(),
    onSessionExpired: ctx.sessionDidExpire,
    onSetTheme: (next) => ctx.view.setThemeTo(next),
  };

  return { historyController, galleryCards, gallerySearch, uploadDestination, uploadZone, accountHost };
}
