// The library's data path: navigating to a folder, refetching it, the delayed loading paint and live sync bumps.

import { folderHref, redirect, replaceRoute } from "../../router";
import { createFolderCache } from "../folderCache";
import type { IndexStatus } from "../../sync/types";
import type { Id, Listing } from "../../core/types";
import { ApiError } from "../../api/client";
import { classify, reconcile } from "../../sync/freshness";
import { type ViewerSet } from "../viewer/viewerSet";
import { createNoteSearch } from "../noteSearch";
// The breadcrumb is painted here, but its flattening rule is the rail's.
import { type RailController } from "../rail";
// Paints into `gallery`; `renderGallery()` closes it, so no teardown hook.
import { type BinController } from "../bin/bin";
// Static, unlike the console: small, and every user has one.
import type { LibraryState } from "./libraryState";
import { createLibraryRender } from "./libraryRender";

import type { Topbar } from "./libraryTopbar";

export interface LibraryDataParts {
  handled: (e: unknown) => boolean;
  toast: (message: string) => void;
  hideActiveViewer: () => void;
  leaveAccount: () => void;
  setReading: (reading: boolean) => void;
  renderGallery: () => ReturnType<typeof createLibraryRender>["renderGallery"];
  emptyState: () => ReturnType<typeof createLibraryRender>["emptyState"];
  folderCache: () => ReturnType<typeof createFolderCache>;
  rail: () => RailController;
  searchInput: () => Topbar["searchInput"];
  gallery: () => HTMLElementTagNameMap["section"];
  search: () => ReturnType<typeof createNoteSearch>;
  viewers: () => ViewerSet;
  leaveAdmin: () => () => void;
  bin: () => BinController;
}

export function createLibraryData(st: LibraryState, p: LibraryDataParts) {
  /**
  * A category with no device folder yet: not a root navigation, no request.
  * The one unaddressable place (no id); the URL is replaced with the root so it
  * doesn't lie, via `replaceRoute` so the pending state survives.
  */
  function enterPendingCategory(): void {
    p.hideActiveViewer();
    p.setReading(false);
    p.leaveAdmin()();
    p.leaveAccount();
    st.destination = null;
    st.folderId = null;
    st.listing = undefined;
    st.query = "";
    p.searchInput().value = "";
    p.search().reset();
    replaceRoute(folderHref(null));
    p.renderGallery()();
  }

  /** The usual "no longer instantaneous" threshold. */
  const LOADING_PAINT_DELAY_MS = 150;

  function cancelLoadingPaint(): void {
    if (st.loadingPaintTimer === undefined) return;
    clearTimeout(st.loadingPaintTimer);
    st.loadingPaintTimer = undefined;
  }

  /**
  * Paints only the place it was armed for: re-reads `folderId`, `query` and
  * `destination` and drops itself if any moved.
  */
  function scheduleLoadingPaint(id: Id | null): void {
    cancelLoadingPaint();
    st.loadingPaintTimer = setTimeout(() => {
      st.loadingPaintTimer = undefined;
      if (st.folderId !== id || st.destination !== null || st.query.trim() !== "") return;
      if (st.listing !== undefined) return; // a st.listing arrived by another path
      // The walk may have cached it meanwhile.
      const cached = p.folderCache().get(id);
      if (cached) st.listing = cached;
      p.renderGallery()();
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
    const mine = st.routeToken;
    cancelLoadingPaint();
    p.rail().clearPending();
    st.folderId = id;
    st.query = "";
    p.searchInput().value = "";
    // Clears transcript hits too.
    p.search().reset();
    const cached = p.folderCache().get(id);
    if (cached) {
      st.listing = cached;
      p.renderGallery()(); // stale-while-revalidate: paint immediately
    } else {
      // Cache miss: drop `listing` now (it describes the old folder, and any repaint
      // meanwhile would mix the two); only the paint waits.
      st.listing = undefined;
      scheduleLoadingPaint(id);
    }
    await refetch(id, cached);
    if (mine === st.routeToken) cancelLoadingPaint();
  }

  /**
  * A 404, or an empty `path` for a non-null id, both mean the folder is gone.
  * `redirect`, not `go`, so Back can't climb onto it; the toast explains.
  */
  function missingFolder(): void {
    p.toast("That folder isn't there any more.");
    redirect(folderHref(null));
  }

  /**
  * Late answers about a place the user has left are dropped, so a stale folder
  * failure can't replace an open bin or redirect out of it.
  */
  function galleryIsOnScreen(): boolean {
    return st.destination === null && !p.bin().isOpen();
  }

  async function refetch(id: Id | null, prev: Listing | undefined): Promise<void> {
    let fresh: Listing;
    try {
      // Through the cache, so boot's root listing and walk share one request.
      fresh = await p.folderCache().listFolder(id);
    } catch (e) {
      // A dead session isn't "couldn't load".
      if (p.handled(e)) return;
      if (id !== st.folderId) return; // navigated away while failing
      if (!galleryIsOnScreen()) return;
      // A 404 won't improve on retry; other failures keep the retry state.
      if (id !== null && e instanceof ApiError && e.status === 404) {
        missingFolder();
        return;
      }
      if (!prev) {
        st.listing = undefined;
        p.gallery().replaceChildren(p.emptyState()("Couldn't load", "Check your connection and try again."));
      }
      return;
    }
    if (id !== st.folderId) return; // navigated away while fetching
    // The root legitimately has an empty path.
    if (id !== null && fresh.path.length === 0) {
      if (galleryIsOnScreen()) missingFolder();
      return;
    }
    st.knownSyncVersion = Math.max(st.knownSyncVersion, fresh.syncVersion);

    const result = reconcile(prev, fresh);
    // `result.listing` keeps unchanged entry objects, so identity-keyed work stays put.
    p.folderCache().put(id, result.listing);
    if (result.changed || st.listing !== result.listing) {
      st.listing = result.listing;
      // Not while the bin is open: a restore triggers this refetch and repainting
      // would close the bin.
      if (!p.bin().isOpen()) p.renderGallery()();
    }
  }

  function onBump(version: number): void {
    st.knownSyncVersion = Math.max(st.knownSyncVersion, version);
    if (classify(p.folderCache().get(st.folderId), st.knownSyncVersion) === "stale") {
      void refetch(st.folderId, p.folderCache().get(st.folderId));
      void p.folderCache().prefetch(true);
    }
  }

  /** Repaints only the search, and only when the number moved. */
  function onIndex(status: IndexStatus): void {
    if (status.pending === st.indexPending) return;
    st.indexPending = status.pending;
    if (st.query.trim() !== "" && st.destination === null && p.viewers().active() === null) p.renderGallery()();
  }

  return { enterPendingCategory, LOADING_PAINT_DELAY_MS, cancelLoadingPaint, scheduleLoadingPaint, navigate, missingFolder, galleryIsOnScreen, refetch, onBump, onIndex };
}
