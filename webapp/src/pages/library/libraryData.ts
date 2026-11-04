// The library's data path: navigating to a folder, refetching it, the delayed loading paint and live sync bumps.

import { folderHref, redirect, replaceRoute } from "../../router";
import type { IndexStatus } from "../../sync/types";
import type { Id, Listing } from "../../core/types";
import { ApiError } from "../../api/client";
import { classify, reconcile } from "../../sync/freshness";
import type { LibraryCtx } from "./libraryContext";

export interface LibraryData {
  /** A category with no device folder yet: not a navigation, no request. */
  enterPendingCategory(): void;
  cancelLoadingPaint(): void;
  /** The `#/folder/:id` route body. */
  navigate(id: Id | null): Promise<void>;
  /** False over a destination or the bin, where a late answer must be dropped. */
  galleryIsOnScreen(): boolean;
  refetch(id: Id | null, prev: Listing | undefined): Promise<void>;
  onBump(version: number): void;
  onIndex(status: IndexStatus): void;
}

export function createLibraryData(ctx: LibraryCtx): LibraryData {
  const { st } = ctx;
  /**
  * A category with no device folder yet: not a root navigation, no request.
  * The one unaddressable place (no id); the URL is replaced with the root so it
  * doesn't lie, via `replaceRoute` so the pending state survives.
  */
  function enterPendingCategory(): void {
    ctx.hideActiveViewer();
    ctx.setReading(false);
    ctx.leaveAdmin();
    ctx.leaveAccount();
    st.destination = null;
    st.folderId = null;
    st.listing = undefined;
    st.query = "";
    ctx.topbar.searchInput.value = "";
    ctx.search.reset();
    replaceRoute(folderHref(null));
    ctx.render.renderGallery();
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
      const cached = ctx.folderCache.get(id);
      if (cached) st.listing = cached;
      ctx.render.renderGallery();
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
    ctx.rail.clearPending();
    st.folderId = id;
    st.query = "";
    ctx.topbar.searchInput.value = "";
    // Clears transcript hits too.
    ctx.search.reset();
    const cached = ctx.folderCache.get(id);
    if (cached) {
      st.listing = cached;
      ctx.render.renderGallery(); // stale-while-revalidate: paint immediately
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
    ctx.toast("That folder isn't there any more.");
    redirect(folderHref(null));
  }

  /**
  * Late answers about a place the user has left are dropped, so a stale folder
  * failure can't replace an open bin or redirect out of it.
  */
  function galleryIsOnScreen(): boolean {
    return st.destination === null && !ctx.bin.isOpen();
  }

  async function refetch(id: Id | null, prev: Listing | undefined): Promise<void> {
    let fresh: Listing;
    try {
      // Through the cache, so boot's root listing and walk share one request.
      fresh = await ctx.folderCache.listFolder(id);
    } catch (e) {
      // A dead session isn't "couldn't load".
      if (ctx.handled(e)) return;
      if (id !== st.folderId) return; // navigated away while failing
      if (!galleryIsOnScreen()) return;
      // A 404 won't improve on retry; other failures keep the retry state.
      if (id !== null && e instanceof ApiError && e.status === 404) {
        missingFolder();
        return;
      }
      if (!prev) {
        st.listing = undefined;
        ctx.gallery.replaceChildren(ctx.render.emptyState("Couldn't load", "Check your connection and try again."));
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
    ctx.folderCache.put(id, result.listing);
    if (result.changed || st.listing !== result.listing) {
      st.listing = result.listing;
      // Not while the bin is open: a restore triggers this refetch and repainting
      // would close the bin.
      if (!ctx.bin.isOpen()) ctx.render.renderGallery();
    }
  }

  function onBump(version: number): void {
    st.knownSyncVersion = Math.max(st.knownSyncVersion, version);
    if (classify(ctx.folderCache.get(st.folderId), st.knownSyncVersion) === "stale") {
      void refetch(st.folderId, ctx.folderCache.get(st.folderId));
      void ctx.folderCache.prefetch(true);
    }
  }

  /** Repaints only the search, and only when the number moved. */
  function onIndex(status: IndexStatus): void {
    if (status.pending === st.indexPending) return;
    st.indexPending = status.pending;
    if (st.query.trim() !== "" && st.destination === null && ctx.viewers.active() === null) ctx.render.renderGallery();
  }

  return { enterPendingCategory, cancelLoadingPaint, navigate, galleryIsOnScreen, refetch, onBump, onIndex };
}
