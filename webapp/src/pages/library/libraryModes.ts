// Destination modes in the library shell: which tools a bin, console or account page leaves on the topbar, and applying a query.

import type { LibraryCtx } from "./libraryContext";

export interface LibraryModes {
  /** Shared by keystrokes and the `#/search?q=` route; doesn't touch the URL. */
  applyQuery(next: string): void;
  setDestinationMode(which: "bin" | "admin" | "account" | "todo", open: boolean): void;
  setBinMode(open: boolean, count: number, busy?: boolean): void;
}

export function createLibraryModes(ctx: LibraryCtx): LibraryModes {
  const { st } = ctx;
  /** Shared by keystrokes and the `#/search?q=` route; doesn't touch the URL. */
  function applyQuery(next: string): void {
    // The results belong in the gallery, which the console or account page covers.
    ctx.leaveAdmin();
    ctx.leaveAccount();
    ctx.leaveTodo();
    st.query = next;
    // Names paint on the keystroke from the cached tree; transcripts arrive after
    // the debounce. `rail: false`: typing can't change the tree.
    ctx.search.setQuery(st.query);
    ctx.render.renderGallery({ rail: false });
  }

  function setDestinationMode(which: "bin" | "admin" | "account" | "todo", open: boolean): void {
    // Mutually exclusive: opening one closes the rest, so flags describe one screen.
    if (open) {
      for (const other of ["bin", "admin", "account", "todo"] as const) {
        if (other !== which) ctx.destinationsOpen[other] = false;
      }
    }
    ctx.destinationsOpen[which] = open;
    const anyOpen = ctx.destinationsOpen.bin || ctx.destinationsOpen.admin || ctx.destinationsOpen.account || ctx.destinationsOpen.todo;
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
