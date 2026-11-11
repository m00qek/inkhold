// Destination modes in the library shell: which tools a bin, console, account page or app leaves on the topbar, and applying a query.

import type { LibraryCtx } from "./libraryContext";

/** The places that cover the gallery, one at a time. */
export type DestinationMode = "bin" | "admin" | "account" | "todo" | "digest";
const MODES: readonly DestinationMode[] = ["bin", "admin", "account", "todo", "digest"];

export interface LibraryModes {
  /** Shared by keystrokes and the `#/search?q=` route; doesn't touch the URL. */
  applyQuery(next: string): void;
  setDestinationMode(which: DestinationMode, open: boolean): void;
  setBinMode(open: boolean, count: number, busy?: boolean): void;
}

export function createLibraryModes(ctx: LibraryCtx): LibraryModes {
  const { st } = ctx;
  /** Shared by keystrokes and the `#/search?q=` route; doesn't touch the URL. */
  function applyQuery(next: string): void {
    // The results belong in the gallery, which the console or account page covers.
    ctx.leaveDestinations();
    st.query = next;
    // Names and transcripts both arrive after the debounce, from the index;
    // its names are read again first. `rail: false`: typing can't change the tree.
    ctx.searchItems.refreshNames();
    ctx.search.setQuery(st.query);
    ctx.render.renderGallery({ rail: false });
  }

  function setDestinationMode(which: DestinationMode, open: boolean): void {
    // Mutually exclusive: opening one closes the rest, so flags describe one screen.
    if (open) {
      for (const other of MODES) {
        if (other !== which) ctx.destinationsOpen[other] = false;
      }
    }
    ctx.destinationsOpen[which] = open;
    const anyOpen = MODES.some((m) => ctx.destinationsOpen[m]);
    ctx.root.classList.toggle("is-destination", anyOpen);
    if (!ctx.destinationsOpen.todo) ctx.root.classList.remove("is-todo-browse");

    // Only takes controls away; each destination shows its own action and
    // `renderGallery` brings Upload back.
    if (anyOpen) {
      ctx.topbar.uploadBtn.hidden = true;
      ctx.topbar.toolsSep.hidden = true; // never a hairline with nothing after it
    }
    if (!ctx.destinationsOpen.bin) ctx.topbar.emptyBinBtn.hidden = true;
    if (!ctx.destinationsOpen.admin) ctx.topbar.lockAdminBtn.hidden = true;
    if (!ctx.destinationsOpen.todo) {
      ctx.topbar.todoStatus.hidden = true;
      ctx.topbar.todoListBtn.hidden = true;
      ctx.topbar.todoDownloadBtn.hidden = true;
      ctx.topbar.todoNewListBtn.hidden = true;
    }
  }

  function setBinMode(open: boolean, count: number, busy = false): void {
    setDestinationMode("bin", open);
    ctx.topbar.emptyBinBtn.hidden = !open;
    // Also disabled while its own call is in flight, or a slow-link second press
    // reports failure for a success.
    ctx.topbar.emptyBinBtn.disabled = count === 0 || busy;
  }

  return { applyQuery, setDestinationMode, setBinMode };
}
