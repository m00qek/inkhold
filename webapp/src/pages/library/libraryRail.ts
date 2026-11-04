// The library's left rail: folder tree, destinations, nameplate and storage meter.

import { el } from "../../ui/dom";
import { brandMark } from "../../ui/chrome";
import { accountHref, destinationHref, folderHref, go } from "../../router";
import { createFolderCache } from "../folderCache";
import { createNameplate, createQuotaMeter } from "../railFooter";
import { createRail, createRailView } from "../rail";
import { BIN_KEY } from "../bin/bin";
import type { LibraryCtx } from "./libraryContext";
import { ADMIN_KEY } from "./library";

/** Builds the folder cache, the rail, the nameplate and the storage meter onto `ctx`. */
export function installLibraryRail(ctx: LibraryCtx): void {
  const { st } = ctx;
  // `aria-busy` until the walk lands: counts are provisional.
  const nav = el("nav", { class: "nav", "aria-label": "Folders", "aria-busy": "true" });

  /** The shell keeps only where the user is; the tree lives in `folderCache.ts`. */
  ctx.folderCache = createFolderCache({
    api: ctx.api,
    handled: ctx.handled,
    onWalked: (changed) => ctx.rail.treeWalked(changed),
  });

  ctx.rail = createRail({
    view: createRailView(nav),
    tree: ctx.folderCache.tree,
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
    onSelectCategory: () => ctx.data.enterPendingCategory(),
    onOpenDestination: (key) => go(destinationHref(key)),
    destinationCount: (key) => {
      switch (key) {
        // --- BIN COUNT ---
        case BIN_KEY:
          return ctx.bin.count();
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
          return ctx.adminDest.isElevated()
            ? { icon: "unlock", label: "Admin console unlocked" }
            : { icon: "lock", label: "Admin console locked" };
        // The bin has a count, and a row has room for one badge.
        default:
          return null;
      }
    },
    isAdmin: () => ctx.identity.isAdmin,
    onSettled: () => ctx.render.renderGallery({ rail: false }),
    onLabelsSettled: () => ctx.render.relabelFolders(),
  });

  const nameplate = createNameplate(ctx.identity.email, () => go(accountHref()));

  ctx.quota = createQuotaMeter();

  // The storage meter stays under the nameplate: room for the file you're about
  // to drop should be visible at a glance.
  ctx.sidebar = el(
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
    ctx.quota.el,
  );
}
