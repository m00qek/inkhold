// Destination modes in the library shell: which tools a bin, console or account page leaves on the topbar, and applying a query.

import { type Topbar } from "./libraryTopbar";
import { createNoteSearch } from "./noteSearch";
// The breadcrumb is painted here, but its flattening rule is the rail's.
import { type RailController } from "./rail";
// Paints into `gallery`; `renderGallery()` closes it, so no teardown hook.
// Static, unlike the console: small, and every user has one.
import type { LibraryState } from "./libraryState";
import { createLibraryRender } from "./libraryRender";

export interface LibraryModesParts {
  leaveAccount: () => void;
  renderGallery: () => ReturnType<typeof createLibraryRender>["renderGallery"];
  rail: () => RailController;
  uploadBtn: () => Topbar["uploadBtn"];
  toolsSep: () => Topbar["toolsSep"];
  emptyBinBtn: () => Topbar["emptyBinBtn"];
  lockAdminBtn: () => Topbar["lockAdminBtn"];
  destinationsOpen: () => { bin: boolean; admin: boolean; account: boolean };
  search: () => ReturnType<typeof createNoteSearch>;
  root: () => HTMLElement;
  leaveAdmin: () => () => void;
}

export function createLibraryModes(st: LibraryState, p: LibraryModesParts) {
  /** Shared by keystrokes and the `#/search?q=` route; doesn't touch the URL. */
  function applyQuery(next: string): void {
    // The results belong in the gallery, which the console or account page covers.
    p.leaveAdmin()();
    p.leaveAccount();
    st.query = next;
    // Names paint on the keystroke from the cached tree; transcripts arrive after
    // the debounce. `rail: false`: typing can't change the tree.
    p.search().setQuery(st.query);
    p.renderGallery()({ rail: false });
  }

  function setDestinationMode(which: "bin" | "admin" | "account", open: boolean): void {
    // Mutually exclusive: opening one closes the rest, so flags describe one screen.
    if (open) {
      for (const other of ["bin", "admin", "account"] as const) {
        if (other !== which) p.destinationsOpen()[other] = false;
      }
    }
    p.destinationsOpen()[which] = open;
    const anyOpen = p.destinationsOpen().bin || p.destinationsOpen().admin || p.destinationsOpen().account;
    p.root().classList.toggle("is-destination", anyOpen);

    // Only takes controls away; each destination shows its own action and
    // `renderGallery` brings Upload back.
    if (anyOpen) {
      p.uploadBtn().hidden = true;
      p.toolsSep().hidden = true; // never a hairline with nothing after it
    }
    if (!p.destinationsOpen().bin) p.emptyBinBtn().hidden = true;
    if (!p.destinationsOpen().admin) p.lockAdminBtn().hidden = true;
  }

  function setBinMode(open: boolean, count: number, busy = false): void {
    setDestinationMode("bin", open);
    p.emptyBinBtn().hidden = !open;
    // Also disabled while its own call is in flight, or a slow-link second press
    // reports failure for a success.
    p.emptyBinBtn().disabled = count === 0 || busy;
  }

  return { applyQuery, setDestinationMode, setBinMode };
}
