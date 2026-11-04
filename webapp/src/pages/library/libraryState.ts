// The library shell's mutable state, one object so its pieces can share it.

import type { Id, Listing } from "../../core/types";
import type { SortKey, View } from "./libraryTopbar";
import type { SearchState } from "../noteSearch";
import type { AccountPage } from "../account/account";

export interface LibraryState {
  // `folderId`, `destination` and `query` are written only by their `show*`
  // handlers: a cache of the address bar.
  /**
  * `null` = root. Survives a note or destination, so Back or a rail click
  * lands in this folder's cached listing.
  */
  folderId: Id | null;
  /**
  * The rail highlight reads this, not the panels' DOM-derived `isOpen()`, which
  * a sync-bump repaint can change without a route change.
  */
  destination: string | null;
  listing: Listing | undefined;
  query: string;
  sort: SortKey;
  view: View;
  knownSyncVersion: number;
  /**
  * Expiry arrives in a burst (thumbnails plus the walk); the latch makes one
  * hand-off and blocks re-entry during handling.
  */
  sessionExpired: boolean;
  // Logic lives in noteSearch.ts. The engine is the browser's own index; no `api`
  // is passed, since there is no library-wide search route.
  searchState: SearchState;
  toastTimer: ReturnType<typeof setTimeout> | undefined;
  /**
  * Built on first entry, not with the shell: its DOM on the boot path lost the
  * 150 ms `LOADING_PAINT_DELAY_MS` race and broke `slowLink`/`find` e2e tests.
  */
  accountPage: AccountPage | null;
  /**
  * Back pushes this URL rather than `history.back()`: a note opened from a
  * shared link has no app entry beneath it, and the origin is still needed to
  * name the button.
  */
  readerBack: string;
  /**
  * Bumped per library/note transition, so a late `getNoteMeta` can't reopen the
  * reader (and hide the topbar) over a folder route.
  */
  routeToken: number;
  loadingPaintTimer: ReturnType<typeof setTimeout> | undefined;
  /**
  * Documents still being derived, or `null` if the server never said (old
  * server, polling fallback). Null means "say nothing", not zero.
  */
  indexPending: number | null;
  resizeTimer: ReturnType<typeof setTimeout> | undefined;
}
