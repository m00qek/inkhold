// The library's left rail: folder tree, destinations, nameplate and storage meter.

import { el } from "../../ui/dom";
import { brandMark } from "../../ui/chrome";
import { accountHref, destinationHref, folderHref, go } from "../../router";
import { createFolderCache } from "../folderCache";
import type { Api } from "../../api/types";
import { createNameplate, createQuotaMeter } from "../railFooter";
import { type AdminDestination } from "../admin/adminDestination";
// The breadcrumb is painted here, but its flattening rule is the rail's.
import { createRail, createRailView, type RailController } from "../rail";
// Paints into `gallery`; `renderGallery()` closes it, so no teardown hook.
import { BIN_KEY, type BinController } from "../bin/bin";
// Static, unlike the console: small, and every user has one.
import type { LibraryState } from "./libraryState";
import { createLibraryRender } from "./libraryRender";
import { createLibraryData } from "./libraryData";
import { type AppDeps, ADMIN_KEY } from "./library";

export interface LibraryRailParts {
  handled: (e: unknown) => boolean;
  identity: () => AppDeps["identity"];
  api: () => Api;
  enterPendingCategory: () => ReturnType<typeof createLibraryData>["enterPendingCategory"];
  relabelFolders: () => ReturnType<typeof createLibraryRender>["relabelFolders"];
  renderGallery: () => ReturnType<typeof createLibraryRender>["renderGallery"];
  adminDest: () => AdminDestination;
  bin: () => BinController;
}

export function createLibraryRail(st: LibraryState, p: LibraryRailParts) {
  // `aria-busy` until the walk lands: counts are provisional.
  const nav = el("nav", { class: "nav", "aria-label": "Folders", "aria-busy": "true" });

  /** The shell keeps only where the user is; the tree lives in `folderCache.ts`. */
  const folderCache = createFolderCache({
    api: p.api(),
    handled: p.handled,
    onWalked: (changed) => rail.treeWalked(changed),
  });

  const rail: RailController = createRail({
    view: createRailView(nav),
    tree: folderCache.tree,
    // From the route via `folderId`/`destination`, not panel DOM. A destination
    // reports no folder (one `aria-current` only); the shell's own `folderId` is
    // kept so leaving the bin lands back in that folder.
    place: () =>
      st.destination !== null
        ? { folderId: null, destination: st.destination, openPath: null }
        : {
            folderId: st.folderId,
            destination: null,
            openPath: st.listing ? st.listing.path : null,
            // See `RailPlace.searching`.
            searching: st.query.trim() !== "",
          },
    // The rail never navigates; it names a URL.
    onOpenFolder: (id) => go(folderHref(id)),
    onSelectCategory: () => p.enterPendingCategory()(),
    onOpenDestination: (key) => go(destinationHref(key)),
    destinationCount: (key) => {
      switch (key) {
        // --- BIN COUNT ---
        case BIN_KEY:
          return p.bin().count();
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
          return p.adminDest().isElevated()
            ? { icon: "unlock", label: "Admin console unlocked" }
            : { icon: "lock", label: "Admin console locked" };
        // The bin has a count, and a row has room for one badge.
        default:
          return null;
      }
    },
    isAdmin: () => p.identity().isAdmin,
    onSettled: () => p.renderGallery()({ rail: false }),
    onLabelsSettled: () => p.relabelFolders()(),
  });

  const nameplate = createNameplate(p.identity().email, () => go(accountHref()));

  const quota = createQuotaMeter();

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

  return { nav, folderCache, rail, nameplate, quota, sidebar };
}
