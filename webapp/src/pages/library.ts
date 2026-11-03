// The library shell: rail, topbar and lazily-thumbnailed gallery, with the
// reader overlaying it. A long-lived controller (created once in main.ts) so
// gallery state survives opening a note. The route is the source of truth:
// every entry point only `go()`s a URL, and the `show*` handlers are the only
// writers of the state that URL describes (see `router.ts`).

import { el } from "../ui/dom";
import { ICONS, svg, type IconName } from "../ui/icons";
import { brandMark } from "../ui/chrome";
import { closeOpenMenu } from "../ui/menu";
import { currentTheme, setTheme } from "../ui/theme";
import { formatBytes, fileKind, UPLOAD_ACCEPT_ATTR } from "../core/fileKind";
import { api as authApi } from "../api/client";
import { SORT_KEY, readLocal, writeLocal } from "../ui/storage";
import {
  current,
  accountHref,
  binNotePageHref,
  destinationHref,
  folderHref,
  go,
  noteHref,
  notePageHref,
  noteVersionHref,
  redirect,
  replaceBinNotePosition,
  replaceNotePosition,
  replaceNoteVersionPosition,
  replaceRoute,
  searchHref,
} from "../router";
import { resolveVersionShort, shortMd5 } from "./versionShort";
import { createFolderCache } from "./folderCache";
import type { Api } from "../api/types";
import type { NoteRenderer } from "../render/types";
import type { RenderCache } from "../cache/types";
import type { PersistentThumbStore } from "../cache/idb";
import type { IndexStatus, LiveChannel } from "../sync/types";
import type { Entry, Folder, Hash, Id, Listing, NoteMeta, NoteSummary, Theme } from "../core/types";
import { skeletonPage } from "../core/noteSkeleton";
import { ApiError, NameTakenError, dispatchApiFailure, type ApiFailureSink } from "../api/client";
import { openRenameDialog } from "../ui/renameDialog";
import { createUploadZone, type UploadDestination, type UploadZone } from "../ui/uploadZone";
import { openConflictDialog } from "../ui/uploadConflict";
import { createExporter, type Exporter } from "../export/exporter";
import { createLazyEngine, renderPage, type LazyEngine } from "../render/lazy";
import {
  createThumbnails,
  createCanvasThumbPainter,
  createFetchThumbNet,
  type Thumbnails,
} from "../render/thumbnails";
import { createPdfThumbs, type PdfThumbs } from "../render/pdfThumb";
import { classify, reconcile } from "../sync/freshness";
import { createReader, type Reader, type ReaderOrigin } from "./reader";
// A file's type picks a `Viewer` (`pages/viewer.ts`) in `viewerFor`.
import { createSpdViewer } from "./spdViewer";
import { createTxtViewer } from "./txtViewer";
import { createPdfViewer } from "./pdfViewer";
import type { Viewer, ViewerDeps } from "./viewer";
import { createNoteSearch, MIN_GLOBAL_QUERY_LEN, type SearchState } from "./noteSearch";
import { createSearchService } from "../search/searchService";
import { createDocSearch } from "../search/docSearch";
import { createGalleryCards, type GalleryCards } from "./galleryCards";
import { createCardActions } from "./cardActions";
import { createHistoryScope, versionMeta, rawVersionMeta } from "./historyScope";
import { createHistoryController, runRestore, confirmRestore } from "./historyPanel";
import type { FileVersion } from "../core/types";
import { createGallerySearch, type GallerySearch } from "./gallerySearch";
// The breadcrumb is painted here, but its flattening rule is the rail's.
import { createRail, createRailView, crumbPath, type RailController } from "./rail";
// Paints into `gallery`; `renderGallery()` closes it, so no teardown hook.
import { BIN_KEY, createBin, createBinScope, createBinView, type BinController } from "./bin";
// Type only, so the console stays a separate chunk loaded by `import("./admin")`.
import type { AdminPanel } from "./admin";
// Static, unlike the console: small, and every user has one.
import { createAccountPage, type AccountHost, type AccountPage } from "./account";

const ADMIN_KEY = "admin";
/**
* Not a `Destination` (no rail row), but written into `destination` so every
* "is a folder listing on screen?" guard treats it like the bin and console.
*/
const ACCOUNT_KEY = "account";

export interface AppDeps {
  api: Api;
  renderer: NoteRenderer;
  cache: RenderCache;
  /** The same `sn-thumbs` instance as the render cache: one store, one budget. */
  persistentThumbs?: PersistentThumbStore | null;
  live: LiveChannel;
  /** `isAdmin` hides admin-only rail rows; the server is the access check. */
  identity: { email: string; isAdmin: boolean };
  onSignOut: () => void;
  /** Fired at most once per shell; main.ts owns navigation. */
  onSessionExpired: () => void;
}

/**
* The route handlers, called only by main.ts. Each is idempotent (a route can
* dispatch twice) and closes the reader, console and pending category.
*/
export interface AppShell {
  el: HTMLElement;
  /** The device's folder ids are stable, so a folder link outlives a sync. */
  showFolder(id: Id | null): void;
  /** A blank query redirects to the current folder. */
  showSearch(q: string): void;
  /** `#/admin` always lands on the elevation gate: addressable is not accessible. */
  showDestination(key: string): void;
  /** Not a `Destination`; open to any signed-in user. */
  showAccount(): void;
  /**
  * `page` is 0-based; the router converts from the URL's 1-based pages. `q`
  * primes find-in-note. All from the route, so reloads and links land exactly.
  */
  openNote(id: Id, page?: number, q?: string): Promise<void>;
  /**
  * `short` is a 7-hex md5 prefix resolved against `noteHistory`: a past version
  * opens the preview, the current md5 opens the live note with a canonical URL
  * (a restore makes this case common), and no match opens the live note with a
  * notice.
  */
  openNoteVersion(id: Id, short: string, page?: number): Promise<void>;
  /**
  * A trashed file in its viewer via the same path as a bin-row click (waiting
  * for the bin listing on a cold load). A file no longer in the bin falls back
  * to `#/bin` with a notice.
  */
  openBinNote(id: Id, page?: number): Promise<void>;
  destroy(): void;

  // ---- destination views ----
  // A destination is a line in `DESTINATIONS` plus an arm in `showDestination`.
}

type SortKey = "recent" | "title" | "pages";

/** Validated, not cast: localStorage may hold a stale or hand-edited key. */
function readStoredSort(): SortKey {
  const raw = readLocal(SORT_KEY);
  return raw === "title" || raw === "pages" || raw === "recent" ? raw : "recent";
}
type View = "grid" | "list";

function initials(email: string): string {
  const name = (email || "").split("@")[0] ?? "";
  const parts = name.split(/[.\-_]+/).filter(Boolean);
  const a = parts[0]?.[0] ?? "?";
  const b = parts[1]?.[0] ?? parts[0]?.[1] ?? "";
  return (a + b).toUpperCase();
}

export function createAppShell(deps: AppDeps): AppShell {
  const { renderer, cache, live, identity } = deps;

  /**
  * Wrapped once here so the reader, lazy engine, exporter and `openNote` never
  * learn the bin exists. `attach` comes later; until then nothing is trashed.
  */
  const binScope = createBinScope();

  /** Created on first entry (dynamic import) and kept for the shell's life. */
  let admin: AdminPanel | null = null;

  /**
  * Called on user-driven navigation only, not from `renderGallery`, which also
  * runs on a live sync bump and must not eject an admin mid-confirmation.
  */
  function leaveAdmin(): void {
    // Also drop the import stand-in, or it would sit over the requested folder.
    hideAdminBooting(false);
    admin?.close();
  }

  /**
  * Stand-in painted over the `import("./admin")` round trip, so the old gallery
  * doesn't linger under the Admin highlight. Reuses `.admin-notice` so the swap
  * is a change of words. Built lazily, once.
  */
  let adminBooting: HTMLElement | null = null;

  function adminNotice(title: string, text: string): HTMLElement {
    return el(
      "section",
      { class: "admin-notice" },
      el("h2", { class: "admin-notice__title", text: title }),
      el("p", { class: "admin-notice__text", text }),
    );
  }

  function showAdminBooting(): void {
    if (!adminBooting) {
      adminBooting = el("section", { class: "admin-booting" });
      content.append(adminBooting);
    }
    adminBooting.replaceChildren(adminNotice("Loading…", "Opening the admin console."));
    adminBooting.hidden = false;
    // Same as `AdminPanel.chrome(true)`; `lockBtn` stays hidden.
    gallery.hidden = true;
    sortWrap.hidden = true;
    segmented.hidden = true;
    setDestinationMode("admin", true);
    {
      const home = el("button", { type: "button", text: "Library" });
      home.addEventListener("click", () => go(folderHref(null)));
      crumbs.replaceChildren(
        home,
        el("span", { class: "crumbs__sep", text: "/" }),
        el("span", { class: "crumbs__here", text: "Admin" }),
      );
    }
    rail.build(); // the highlight reads `destination`, already ADMIN_KEY
  }

  /** `handOver`: the real console takes this chrome as is, so don't flash the gallery. */
  function hideAdminBooting(handOver: boolean): void {
    if (!adminBooting || adminBooting.hidden) return;
    adminBooting.hidden = true;
    if (handOver) return;
    gallery.hidden = false;
    sortWrap.hidden = false;
    segmented.hidden = false;
    setDestinationMode("admin", false);
  }

  /**
  * A cold start always builds a fresh panel and shows the gate; re-entry in one
  * session reuses it, since elevation is the server's fact.
  */
  function openAdmin(): void {
    if (admin) {
      admin.open();
      rail.build();
      return;
    }
    // Painted before the import is issued.
    showAdminBooting();
    void import("./admin")
      .then((m) => {
        admin = m.createAdminPanel({
          api,
          account: identity.email,
          content,
          gallery,
          crumbs,
          sortWrap,
          segmented,
          lockBtn: lockAdminBtn,
          setMode: (open) => setDestinationMode("admin", open),
          // Elevation changes only inside the panel (unlock, lock, 428); rebuild the
          // rail so the padlock never lies.
          onElevationChanged: () => rail.build(),
          toast,
          onSessionExpired: sessionDidExpire,
        });
        // A route change can land during the import.
        if (destination !== ADMIN_KEY) {
          hideAdminBooting(false);
          return;
        }
        // Hand over rather than tear down, to avoid flashing the gallery.
        hideAdminBooting(true);
        admin.open();
        rail.build(); // the console is open now; repaint the highlight
      })
      .catch(() => {
        // The chunk failed (dropped link, or a stale tab after a redeploy); a loading
        // state must not outlive what it describes.
        if (destination !== ADMIN_KEY || !adminBooting) return;
        adminBooting.replaceChildren(
          adminNotice("The console could not be loaded", "Check your connection and try again."),
        );
      });
  }
  // Two composed `Api` wrappers: version preview and bin. They never both fire
  // (previews are of live notes) and pass through when inactive.
  const historyScope = createHistoryScope();
  const api = historyScope.wrap(binScope.wrap(deps.api));

  // ---- state ----
  // `folderId`, `destination` and `query` are written only by their `show*`
  // handlers: a cache of the address bar.
  /**
  * `null` = root. Survives a note or destination, so Back or a rail click
  * lands in this folder's cached listing.
  */
  let folderId: Id | null = null;
  /**
  * The rail highlight reads this, not the panels' DOM-derived `isOpen()`, which
  * a sync-bump repaint can change without a route change.
  */
  let destination: string | null = null;
  let listing: Listing | undefined;
  let query = "";
  let sort: SortKey = readStoredSort();
  let view: View = "grid";
  let knownSyncVersion = 0;
  const key = (id: Id | null) => id ?? "\0root";

  // ---- failure routing ----
  /**
  * Expiry arrives in a burst (thumbnails plus the walk); the latch makes one
  * hand-off and blocks re-entry during handling.
  */
  let sessionExpired = false;
  function sessionDidExpire(): void {
    if (sessionExpired) return;
    sessionExpired = true;
    deps.onSessionExpired();
  }

  /**
  * A thumbnail's `?v=` 404'd: refetch the listing (STALE_PAGE). Once per hash,
  * so new hashes that also 404 can't spin.
  */
  const staleHandled = new Set<Hash>();
  function onStaleThumbnail(hash: Hash): void {
    if (sessionExpired || staleHandled.has(hash)) return;
    staleHandled.add(hash);
    void refetch(folderId, folderCache.get(folderId));
  }

  const failures: ApiFailureSink = {
    onSessionExpired: sessionDidExpire,
    onStalePage: (_noteId, page) => onStaleThumbnail(page.hash),
  };

  /** For listing/metadata errors; true means handled, skip the fallback. */
  function handled(e: unknown): boolean {
    return dispatchApiFailure(failures, e);
  }

  // ---- DOM: rail ----
  // `aria-busy` until the walk lands: counts are provisional.
  const nav = el("nav", { class: "nav", "aria-label": "Folders", "aria-busy": "true" });

  /** The shell keeps only where the user is; the tree lives in `folderCache.ts`. */
  const folderCache = createFolderCache({
    api,
    handled,
    onWalked: (changed) => rail.treeWalked(changed),
  });

  const rail: RailController = createRail({
    view: createRailView(nav),
    tree: folderCache.tree,
    // From the route via `folderId`/`destination`, not panel DOM. A destination
    // reports no folder (one `aria-current` only); the shell's own `folderId` is
    // kept so leaving the bin lands back in that folder.
    place: () =>
      destination !== null
        ? { folderId: null, destination, openPath: null }
        : {
            folderId,
            destination: null,
            openPath: listing ? listing.path : null,
            // See `RailPlace.searching`.
            searching: query.trim() !== "",
          },
    // The rail never navigates; it names a URL.
    onOpenFolder: (id) => go(folderHref(id)),
    onSelectCategory: () => enterPendingCategory(),
    onOpenDestination: (key) => go(destinationHref(key)),
    destinationCount: (key) => {
      switch (key) {
        // --- BIN COUNT ---
        case BIN_KEY:
          return bin.count();
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
          return admin?.isElevated()
            ? { icon: "unlock", label: "Admin console unlocked" }
            : { icon: "lock", label: "Admin console locked" };
        // The bin has a count, and a row has room for one badge.
        default:
          return null;
      }
    },
    isAdmin: () => identity.isAdmin,
    onSettled: () => renderGallery({ rail: false }),
    onLabelsSettled: () => relabelFolders(),
  });

  // The footer is one nameplate button opening the account page; sign out and
  // the theme toggle live there now, which gives the name column room.
  const nameplate = el(
    "button",
    {
      class: "account",
      type: "button",
      // Says what pressing does and who it's about.
      "aria-label": `Your account: ${identity.email || "signed in"}`,
      title: "Your account",
    },
    el("span", { class: "avatar", "aria-hidden": "true", text: initials(identity.email) }),
    el(
      "span",
      { class: "account__who" },
      el("span", { class: "account__name", text: (identity.email || "").split("@")[0] || "Signed in" }),
      el("span", { class: "account__mail", text: identity.email }),
    ),
    el("span", { class: "account__chevron", "aria-hidden": "true", html: svg(ICONS.chevron, 1.8) }),
  );
  nameplate.addEventListener("click", () => go(accountHref()));

  // Hidden until `usage()` resolves; red over quota.
  const quotaUsed = el("span", { class: "quota__used" });
  const quotaTotal = el("span", { class: "quota__total" });
  const quotaFill = el("div", { class: "quota__fill" });
  const quota = el(
    "div",
    { class: "quota", hidden: true, role: "img", "aria-label": "Storage used" },
    quotaUsed,
    el("div", { class: "quota__track" }, quotaFill),
    quotaTotal,
  );
  /**
  * Draws the bar and feeds the upload pre-flight, so a doomed transfer is
  * refused on drop. Null means unknown, never "no room".
  */
  let usage: { used: number; total: number } | null = null;

  function refreshUsage(): void {
    void authApi.usage().then((u) => {
      usage = u && u.total > 0 ? u : null;
      if (!usage) return;
      const pct = Math.max(0, Math.min(100, (usage.used / usage.total) * 100));
      quotaFill.style.width = `${pct}%`;
      quotaUsed.textContent = formatBytes(usage.used);
      quotaTotal.textContent = formatBytes(usage.total);
      quota.classList.toggle("is-over", usage.used > usage.total);
      quota.setAttribute(
        "aria-label",
        `Storage used: ${formatBytes(usage.used)} of ${formatBytes(usage.total)}`,
      );
      quota.hidden = false;
    });
  }
  refreshUsage();

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
    quota,
  );

  // ---- DOM: topbar ----
  const crumbs = el("div", { class: "crumbs", id: "crumbs" });
  const searchInput = el("input", {
    class: "search__input",
    id: "search",
    type: "search",
    autocomplete: "off",
    placeholder: "Search across every note — typed and handwritten",
    "aria-label": "Search notes",
  });
  // The first letter pushes (folder to results is a navigation); later letters
  // and clearing replace, so one search episode is one history entry.
  // Entering via a hash navigation resets focus to `<body>`, losing the caret on
  // the first keystroke; it's captured here and restored by `showSearch`, which
  // runs after the reset.
  let pendingSearchCaret: number | null = null;
  function restoreSearchFocus(): void {
    if (pendingSearchCaret === null) return;
    const caret = pendingSearchCaret;
    pendingSearchCaret = null;
    searchInput.focus();
    const input = searchInput as HTMLInputElement;
    // Guard only for DOMs without selection ranges (headless tests).
    try {
      input.setSelectionRange(caret, caret);
    } catch {
    }
  }

  searchInput.addEventListener("input", () => {
    const next = searchInput.value;
    // A blank query is the folder `folderId` still holds.
    const target = next.trim() === "" ? folderHref(folderId) : searchHref(next);
    if (current().name !== "search") {
      // Arm the caret restore only when entering search.
      if (next.trim() !== "") pendingSearchCaret = (searchInput as HTMLInputElement).selectionStart ?? next.length;
      go(target);
      return;
    }
    replaceRoute(target);
    // `replaceRoute` doesn't fire the route, so paint here.
    applyQuery(next);
  });

  /** Shared by keystrokes and the `#/search?q=` route; doesn't touch the URL. */
  function applyQuery(next: string): void {
    // The results belong in the gallery, which the console or account page covers.
    leaveAdmin();
    leaveAccount();
    query = next;
    // Names paint on the keystroke from the cached tree; transcripts arrive after
    // the debounce. `rail: false`: typing can't change the tree.
    search.setQuery(query);
    renderGallery({ rail: false });
  }

  const sortSelect = el(
    "select",
    { id: "sort", "aria-label": "Sort notes" },
    el("option", { value: "recent", text: "Recent" }),
    el("option", { value: "title", text: "Title" }),
    el("option", { value: "pages", text: "Pages" }),
  ) as HTMLSelectElement;
  // Otherwise the select shows its first option while sorted by another.
  sortSelect.value = sort;
  sortSelect.addEventListener("change", () => {
    sort = sortSelect.value as SortKey;
      writeLocal(SORT_KEY, sort);
    renderGallery();
  });

  const gridBtn = el("button", { type: "button", "aria-label": "Grid view", "aria-pressed": "true", html: svg(ICONS.grid, 1.7) });
  const listBtn = el("button", { type: "button", "aria-label": "List view", "aria-pressed": "false", html: svg(ICONS.list, 1.7) });

  gridBtn.addEventListener("click", () => setView("grid"));
  listBtn.addEventListener("click", () => setView("list"));

  // Both are hidden over results: they describe a folder listing.
  const sortWrap = el("span", { class: "select" }, sortSelect, el("span", { html: svg(ICONS.chevron, 1.8) }));
  const segmented = el("div", { class: "segmented", role: "group", "aria-label": "View" }, gridBtn, listBtn);

  // ---- destination mode ----
  // `is-destination` hides the search box (it would search a library not on
  // screen and navigate away). Tracked per destination: `renderGallery()` runs on
  // sync bumps and must not strip another destination's mode.
  const destinationsOpen = { bin: false, admin: false, account: false };
  function setDestinationMode(which: "bin" | "admin" | "account", open: boolean): void {
    // Mutually exclusive: opening one closes the rest, so flags describe one screen.
    if (open) {
      for (const other of ["bin", "admin", "account"] as const) {
        if (other !== which) destinationsOpen[other] = false;
      }
    }
    destinationsOpen[which] = open;
    const anyOpen = destinationsOpen.bin || destinationsOpen.admin || destinationsOpen.account;
    root.classList.toggle("is-destination", anyOpen);

    // Only takes controls away; each destination shows its own action and
    // `renderGallery` brings Upload back.
    if (anyOpen) {
      uploadBtn.hidden = true;
      toolsSep.hidden = true; // never a hairline with nothing after it
    }
    if (!destinationsOpen.bin) emptyBinBtn.hidden = true;
    if (!destinationsOpen.admin) lockAdminBtn.hidden = true;
  }

  /** Glyph then words, never icon-only; `hidden` per `.topbar__action[hidden]`. */
  function topbarAction(opts: {
    id: string;
    label: string;
    icon: IconName;
    ariaLabel?: string;
    danger?: boolean;
    /** Only for an unambiguous icon. */
    iconOnly?: boolean;
  }): HTMLButtonElement {
    const b = el("button", {
      class: `btn topbar__action${opts.iconOnly ? " topbar__action--icon" : ""}${opts.danger ? " is-danger" : ""}`,
      // Two of these share `.tools`; the id tells them apart in tests.
      id: opts.id,
      type: "button",
      hidden: true,
      // Only when the label isn't the whole story; an `aria-label` that omits the
      // visible text breaks WCAG Label in Name.
      ...(opts.ariaLabel ? { "aria-label": opts.ariaLabel } : {}),
    });
    b.append(el("span", { class: "topbar__action-mark", html: svg(ICONS[opts.icon], 1.7) }));
    if (opts.iconOnly) b.title = opts.ariaLabel ?? opts.label;
    else b.append(el("span", { text: opts.label }));
    return b;
  }

  // View-level, so beside sort and view. Red (destructive); disabled, not
  // removed, over an empty bin. The confirm rides on `bin.empty()`.
  const emptyBinBtn = topbarAction({
    id: "empty-bin",
    label: "Empty bin",
    icon: "trash",
    ariaLabel: "Delete everything in the recycle bin permanently",
    danger: true,
  });
  emptyBinBtn.addEventListener("click", () => bin.empty());

  // Not `danger`: locking destroys nothing.
  const lockAdminBtn = topbarAction({
    id: "lock-console",
    label: "Lock console",
    icon: "lock",
  });
  lockAdminBtn.addEventListener("click", () => void admin?.lock());

  // The discoverable, keyboard- and touch-reachable twin of drag and drop; both
  // hand files to the same `uploadZone.add`. Shown only over a folder listing.
  const uploadBtn = topbarAction({
    id: "upload",
    label: "Upload",
    icon: "export",
    ariaLabel: "Upload a file to this folder",
    // Icon-only: a universal mark for a non-destructive secondary route.
    iconOnly: true,
  });
  const toolsSep = el("span", { class: "tools__sep", hidden: true, "aria-hidden": "true" });
  const filePicker = el("input", {
    class: "upload__picker",
    type: "file",
    multiple: true,
    // A hint for the OS dialog only; drag and drop bypasses it, so pre-flight always runs.
    accept: UPLOAD_ACCEPT_ATTR,
    hidden: true,
    "aria-hidden": "true",
    tabindex: "-1",
  }) as HTMLInputElement;
  filePicker.addEventListener("change", () => {
    const picked = Array.from(filePicker.files ?? []);
    // Reset first: picking the same file twice fires no `change`.
    filePicker.value = "";
    if (picked.length > 0) uploadZone.add(picked);
  });
  uploadBtn.addEventListener("click", () => filePicker.click());

  function setBinMode(open: boolean, count: number, busy = false): void {
    setDestinationMode("bin", open);
    emptyBinBtn.hidden = !open;
    // Also disabled while its own call is in flight, or a slow-link second press
    // reports failure for a success.
    emptyBinBtn.disabled = count === 0 || busy;
  }

  const topbar = el(
    "div",
    { class: "topbar" },
    crumbs,
    el(
      "div",
      { class: "search" },
      el("span", { class: "search__glyph-wrap", html: `<svg class="search__glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round">${ICONS.search}</svg>` }),
      searchInput,
      // `aria-hidden`: the placeholder already says it.
      el("span", { class: "search__ocr", "aria-hidden": "true", text: "OCR" }),
    ),
    el("div", { class: "tools" }, sortWrap, segmented, toolsSep, uploadBtn, emptyBinBtn, lockAdminBtn),
    filePicker,
  );

  // ---- DOM: content (gallery + reader) ----
  const gallery = el("section", { class: "gallery", id: "gallery", "aria-label": "Notes" });
  const content = el("div", { class: "content" }, gallery);
  const toastEl = el("div", { class: "toast", role: "status", "aria-live": "polite" });

  // The thumbnail facade: every tile is a WebP blob from one call. PDF page 0
  // uses the viewer's MuPDF wasm, inert until a visible, uncached PDF tile needs
  // it (a persistent `sn-thumbs` hit answers first).
  const pdfThumbs: PdfThumbs = createPdfThumbs();
  const thumbnails: Thumbnails = createThumbnails({
    getTheme: currentTheme,
    net: createFetchThumbNet(),
    painter: createCanvasThumbPainter(),
    renderNote: (noteId, page, theme) => renderPage({ api, renderer, cache, theme }, noteId, page, "thumb"),
    renderPdfPage: pdfThumbs.renderPdfPage,
    persistent: deps.persistentThumbs,
  });
  const galleryEngine: LazyEngine = createLazyEngine({
    api,
    renderer,
    cache,
    getTheme: currentTheme,
    getThumbnail: thumbnails.getThumbnail,
    // Interim floor for a slow produce; see `PLACEHOLDER_AFTER_MS`.
    getGlyph: thumbnails.getGlyph,
    root: content,
    failures,
  });

  // Native image tiles are lazy-loaded by us: Chromium never loads a
  // `loading="lazy"` `<img>` inserted already in the viewport during an SPA
  // re-render. `data-src` is promoted on approach.
  const imgLazy: IntersectionObserver | null =
    typeof IntersectionObserver !== "undefined"
      ? new IntersectionObserver(
          (entries, obs) => {
            for (const e of entries) {
              if (!e.isIntersecting) continue;
              const img = e.target as HTMLImageElement;
              const src = img.dataset.src;
              if (src && !img.src) img.src = src;
              obs.unobserve(img);
            }
          },
          { root: content, rootMargin: "200px" },
        )
      : null;

  // ---- transcript search ----
  // Logic lives in noteSearch.ts. The engine is the browser's own index; no `api`
  // is passed, since there is no library-wide search route.
  let searchState: SearchState = { kind: "idle" };
  const searchService = createSearchService({
    // Stands in for the manifest when this session never synced, so a full local
    // store stays searchable offline. Read fresh: the walk fills it later.
    listing: () =>
      [...folderCache.values()].flatMap((cached) =>
        cached.entries.flatMap((e) =>
          e.kind === "note" && e.fileHash
            // The numeric `fileId` is canonical; `gallerySearch` converts back.
            ? [{ md5: e.fileHash, fileId: Number(e.id), updatedAt: e.updatedAt }]
            : [],
        ),
      ),
  });
  const search = createNoteSearch({
    search: searchService,
    failures,
    view: {
      setState(next) {
        searchState = next;
        // Only engine-arrived states repaint here; `idle`/`searching` callers already render.
        if (next.kind !== "results" && next.kind !== "error") return;
        // One paint per answer: answers are whole. Drawn bitmaps come back off the
        // render cache.
        renderGallery({ rail: false });
      },
    },
  });

  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  function toast(message: string): void {
    toastEl.textContent = message;
    toastEl.classList.add("is-shown");
    if (toastTimer !== undefined) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("is-shown"), 2400);
  }

  const exporter: Exporter = createExporter({ api, renderer });

  // One deps object for every viewer, so Back, Move to bin and position
  // reporting are literally the same closures.
  const viewerDeps: ViewerDeps = {
    api,
    // In-document search: the same wasm FTS5 engine on one document's
    // `text/<md5>`, built once and shared by every viewer. `text/<md5>` is
    // `immutable`, so `index_version` from the manifest rides the query string to
    // bust the cache on re-derivation; read fresh per call.
    docSearch: createDocSearch({ indexVersion: (md5) => searchService.indexVersion(md5) }),
    renderer,
    cache,
    getTheme: currentTheme,
    // Back to where the note was opened from; see `readerBack`.
    onBack: () => go(readerBack),
    toast,
    onSessionExpired: sessionDidExpire,
    // The same `bin.trash` as the card menu (toast, device line), then leave like
    // Back. `kind: "note"` is right for any file type.
    onMoveToBin: (meta) => {
      void bin.trash({ id: meta.id, name: meta.name, kind: "note" });
      go(readerBack);
    },
    // Bin-origin Restore / Delete through the bin controller's by-id methods (the
    // purge confirm included). Navigation waits for the outcome: a cancel or
    // failure leaves the viewer open; success returns to `#/bin`.
    onRestore: (meta) => {
      void bin.restore(meta.id).then((done) => {
        if (done) go(readerBack);
      });
    },
    onPurge: (meta) => {
      void bin.purge(meta.id).then((done) => {
        if (done) go(readerBack);
      });
    },
    // The same `restoreVersion` as the panel. For a PDF's annotations the `.mark`
    // is restored but the document is what reopens.
    onRestoreVersion: (subject, version) =>
      void restoreVersion(subject.id, version, subject.name, subject.annotationsOn ?? subject.id),
    // The same history panel as the card menu; a forward reference, only called on click.
    onVersions: (subject, anchor, viewingMd5) =>
      historyController.open(
        { id: subject.id, name: subject.name, fileType: subject.fileType },
        { anchor, viewingMd5, annotationsOn: subject.annotationsOn },
      ),
    // Rewrites the hash without a history entry. Bin wins first (a trashed version
    // preview is still reached through the bin), then version preview, then live.
    onPosition: (noteId, page, q, versionMd5, bin) =>
      bin
        ? replaceBinNotePosition(noteId, page)
        : versionMd5
          ? replaceNoteVersionPosition(noteId, shortMd5(versionMd5), page)
          : replaceNotePosition(noteId, page, q),
  };

  const reader: Reader = createReader(viewerDeps);
  content.append(reader.el);
  // Mounted once beside the reader, hidden until `activate` shows one.
  const spdViewer: Viewer = createSpdViewer(viewerDeps);
  content.append(spdViewer.el);
  const txtViewer: Viewer = createTxtViewer(viewerDeps);
  content.append(txtViewer.el);
  const pdfViewer: Viewer = createPdfViewer(viewerDeps);
  content.append(pdfViewer.el);

  /** Exactly one viewer paints at a time. */
  let activeViewer: Viewer | null = null;

  /**
  * By server-verified `fileType`; the reader is the default. Membership must
  * match `hasDedicatedViewer` (core/fileKind.ts), which the bin uses.
  */
  function viewerFor(fileType: string): Viewer {
    switch ((fileType || "").toLowerCase()) {
      // --- SPD VIEWER ---
      case "spd":
        return spdViewer;
      // --- TXT VIEWER ---
      case "txt":
        return txtViewer;
      // A `.mark` doesn't come here: it parses as a note and the reader paints it.
      case "pdf":
        return pdfViewer;
      default:
        return reader; // note, image, and every other kind
    }
  }

  /** `v.open()` shows `v.el`; this only hides the prior viewer. */
  function activate(v: Viewer): void {
    if (activeViewer && activeViewer !== v) activeViewer.hide();
    activeViewer = v;
    // Hide the gallery, not just cover it: IntersectionObserver ignores occlusion,
    // so tiles (expensive for PDFs) kept rendering behind the viewer.
    gallery.hidden = true;
  }

  function hideActiveViewer(): void {
    // The next live read must not stay pinned to a retained version.
    historyScope.clear();
    if (activeViewer) {
      activeViewer.hide();
      activeViewer = null;
    }
    gallery.hidden = false;
  }

  const root = el(
    "div",
    { class: "sn-root" },
    el("div", { class: "app" }, sidebar, el("main", { class: "main" }, topbar, content)),
    toastEl,
  );

  const bin: BinController = createBin({
    api,
    // The gallery's own engine; its `reset()` is the bin's teardown.
    view: createBinView({
      gallery,
      crumbs,
      sortWrap,
      segmented,
      root,
      engine: galleryEngine,
      setMode: setBinMode,
      onLeave: () => go(folderHref(null)),
    }),
    // Routed to `#/bin/note/:id` (the live route 404s for trashed files) so Back,
    // reload and copy-link reopen the same trashed file with a `"bin"` origin.
    onOpen: (entry) => go(binNotePageHref(entry.id)),
    onChanged: (mutated) => {
      // The badge moves every refresh; the folder only refetches on a real mutation.
      rail.build();
      if (mutated) void refetch(folderId, folderCache.get(folderId));
    },
    handled,
  });
  binScope.attach((id) => bin.isTrashed(id));

  // ---- the extracted features ----
  // Each gets an explicit context; built once every dependency exists. Order
  // matters: cards use `cardActions`' menu, search rows use the card factory.
  const historyController = createHistoryController({
    api,
    host: root,
    toast,
    handled,
    // With `annotationsOn`, `noteId` is a `.mark` and the live document opens
    // with the ink rerouted; without it, the file's past version opens.
    openPreview: (noteId, version, annotationsOn) =>
      void (annotationsOn != null
        ? openAnnotationsPreview(annotationsOn, noteId, version)
        : openHistoryPreview(noteId, version)),
    restore: (noteId, version, noteName) => restoreVersion(noteId, version, noteName),
  });
  /**
  * `entry` is the object the cached listing holds, so one field write plus a
  * repaint updates it; the SSE bump reconciles. `NameTakenError` is rethrown to
  * keep the dialog open.
  */
  async function onRename(entry: Entry): Promise<void> {
    await openRenameDialog({
      host: root,
      entry: {
        name: entry.name,
        fileType: entry.kind === "note" ? entry.fileType : "",
        isFolder: entry.kind === "folder",
      },
      submit: async (fullName) => {
        let updated: Entry;
        try {
          updated = await api.rename(entry.id, fullName);
        } catch (e) {
          if (e instanceof NameTakenError) throw e; // the dialog keeps itself open
          if (handled(e)) return; // a dead session etc. — routed, dialog closes
          toast("Couldn't rename that. Try again.");
          return;
        }
        entry.name = updated.name;
        renderGallery();
        toast(`Renamed to '${updated.name}'.`);
      },
    });
  }

  const cardActions = createCardActions({
    api,
    exporter,
    toast,
    handled,
    sessionDidExpire,
    onTrash: (entry) => void bin.trash(entry),
    onRename: (entry) => void onRename(entry),
    isCategoryRoot: (entry) => entry.kind === "folder" && rail.categoryIconFor(entry) !== null,
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
    galleryEngine,
    imgLazy,
    getView: () => view,
    labelFor: (folder) => rail.labelFor(folder),
    categoryIconFor: (folder) => rail.categoryIconFor(folder),
    pendingCategoryOf: (folder) => rail.pendingCategoryOf(folder),
    // `selectCategory` already fires `onSelectCategory`; don't call it again.
    onSelectCategory: (cat) => rail.selectCategory(cat),
    scheduleSpan,
    cardMenu: cardActions.cardMenu,
  });
  const gallerySearch: GallerySearch = createGallerySearch({
    gallery,
    getSearchState: () => searchState,
    folders: folderCache,
    treeLoaded: () => rail.loaded(),
    labelFor: (folder) => rail.labelFor(folder),
    resultCard: galleryCards.resultCard,
    emptyState,
    indexPending: () => indexPending,
  });

  /**
  * Read per event, so a drag that ends after a navigation can't upload into
  * the folder left. Null over a destination, results, a pending category or an
  * open viewer: the same places Upload is hidden. `templates` comes from the
  * rail's identity resolution.
  */
  function uploadDestination(): UploadDestination | null {
    if (destination !== null || activeViewer !== null) return null;
    if (query.trim() !== "" || rail.pending() !== null) return null;
    return {
      id: folderId,
      templates: folderId !== null && rail.categoryFor({ id: folderId })?.templates === true,
    };
  }

  /** The zone owns feedback, pre-flight, progress and toasts; the shell owns the rest. */
  const uploadZone: UploadZone = createUploadZone({
    target: gallery,
    // Over the scroll container, not the gallery, so a short listing's empty space
    // is still a target.
    overlayHost: content,
    listHost: root,
    destination: uploadDestination,
    // Unknown never blocks; the server's 413 is the authority.
    remainingBytes: () => (usage === null ? null : Math.max(0, usage.total - usage.used)),
    // File names only: an upload never replaces a folder. Null means unknown, so
    // the zone doesn't ask.
    existingNames: (id) => {
      const cached = folderCache.get(id);
      return cached ? cached.entries.filter((e) => e.kind === "note").map((e) => e.name) : null;
    },
    confirmConflict: (req) => openConflictDialog({ host: root, ...req }),
    upload: (folderIdArg, file, onProgress, signal, onConflict) =>
      api.upload(folderIdArg, file, onProgress, signal, onConflict),
    onUploaded: (entry, dest) => {
      // Optimistic splice, then `refetch` corrects auto-renames.
      const cached = folderCache.get(dest.id);
      if (cached) {
        // A replace keeps its id, so it swaps in place.
        const at = cached.entries.findIndex((e) => e.id === entry.id);
        cached.entries =
          at >= 0 ? cached.entries.map((e, i) => (i === at ? entry : e)) : [...cached.entries, entry];
        if (listing === cached || key(folderId) === key(dest.id)) {
          listing = cached;
          renderGallery();
        }
      }
      refreshUsage();
      void refetch(folderId, folderCache.get(folderId));
      void folderCache.prefetch(true);
    },
    toast,
    handled,
  });

  /** Everything is the shell's; the page owns only where buttons sit. */
  const ACCOUNT_HOST: AccountHost = {
    api,
    account: identity.email,
    content,
    gallery,
    crumbs,
    sortWrap,
    segmented,
    setMode: (open) => setDestinationMode("account", open),
    toast,
root,
    onLeave: () => go(folderHref(null)),
    onOpenBin: () => go(destinationHref(BIN_KEY)),
    onSignOut: () => deps.onSignOut(),
    onSessionExpired: sessionDidExpire,
    onSetTheme: (next) => setThemeTo(next),
  };
  /**
  * Built on first entry, not with the shell: its DOM on the boot path lost the
  * 150 ms `LOADING_PAINT_DELAY_MS` race and broke `slowLink`/`find` e2e tests.
  */
  let accountPage: AccountPage | null = null;
  function account(): AccountPage {
    accountPage ??= createAccountPage(ACCOUNT_HOST);
    return accountPage;
  }

  function leaveAccount(): void {
    accountPage?.close();
  }

  // ---- rendering ----
  function buildCrumbs(): void {
    const parts: (Node | string)[] = [];
    const home = el("button", { type: "button", text: "Library" });
    home.addEventListener("click", () => go(folderHref(null)));
    if (query.trim()) {
      // Just "Search": results span the library, so a folder crumb would lie.
      crumbs.replaceChildren(el("span", { class: "crumbs__here", text: "Search" }));
      return;
    }
    const pending = rail.pending();
    if (pending) {
      // "Library" would contradict the highlighted rail row.
      parts.push(home, el("span", { class: "crumbs__sep", text: "/" }), el("span", { class: "crumbs__here", text: pending.label }));
      crumbs.replaceChildren(...parts);
      return;
    }
    if (!listing || (listing.folderId === null && listing.path.length === 0)) {
      parts.push(el("span", { class: "crumbs__here", text: "Library" }));
    } else {
      parts.push(home);
      const trail = crumbPath(listing.path);
      trail.forEach((folder, i) => {
        parts.push(el("span", { class: "crumbs__sep", text: "/" }));
        // The rail's label, so the crumb can't read `EXPORT` beside `Export`.
        const label = rail.labelFor(folder);
        if (i === trail.length - 1) {
          parts.push(el("span", { class: "crumbs__here", text: label }));
        } else {
          const crumb = el("button", { type: "button", text: label });
          crumb.addEventListener("click", () => go(folderHref(folder.id)));
          parts.push(crumb);
        }
      });
    }
    crumbs.replaceChildren(...parts);
  }

  /**
  * The narrow repaint the walk owes a folder listing: crumbs and folder cards
  * only, without resetting the render engine. Folder cards precede note cards,
  * so they line up by position; a length mismatch touches nothing.
  */
  function relabelFolders(): void {
    if (!galleryIsOnScreen()) return;
    buildCrumbs();
    if (query.trim() !== "" || !listing) return;
    const folders = visibleEntries().filter((e): e is Folder => e.kind === "folder");
    if (folders.length === 0) return;
    const cards = gallery.querySelectorAll<HTMLElement>(".card--folder");
    if (cards.length !== folders.length) return;

    // Only cards whose label or category status moved: a replaced node is
    // detached from under the user's hover or focus, and this runs on every sync.
    const stale = folders.filter((folder, i) => {
      const card = cards[i]!;
      const labelMoved = card.querySelector(".card__title")?.textContent !== rail.labelFor(folder);
      const categoryMoved = card.classList.contains("card--category") !== (rail.categoryIconFor(folder) !== null);
      return labelMoved || categoryMoved;
    });
    if (stale.length === 0) return;

    closeOpenMenu(); // a folder row's menu is about to be replaced
    folders.forEach((folder, i) => {
      if (!stale.includes(folder)) return;
      cards[i]!.replaceWith(galleryCards.folderCard(folder));
    });
    scheduleSpan();
  }

  function visibleEntries(): Entry[] {
    if (!listing) return [];
    // Only the root is rewritten (containers out). No query filter: a query
    // replaces the gallery with library-wide results.
    const entries = folderId === null ? rail.rootEntries(listing.entries) : listing.entries;
    const folders = entries.filter((e): e is Folder => e.kind === "folder");
    const notes = entries.filter((e): e is NoteSummary => e.kind === "note");
    notes.sort((a, b) => {
      if (sort === "title") return a.name.localeCompare(b.name);
      if (sort === "pages") return b.pageCount - a.pageCount;
      return b.updatedAt - a.updatedAt;
    });
    return [...folders, ...notes];
  }

  interface RenderOpts {
    /** False on the typing path: typing can't change the tree. */
    rail?: boolean;
  }

  // ---- masonry spans + tile aspect ----
  // CSS-grid row-span masonry (04-library-gallery.css). CSS decides heights; the
  // span pass only measures, and reruns only when a height can change.

  let spanScheduled = false;
  function scheduleSpan(): void {
    if (spanScheduled) return;
    spanScheduled = true;
    requestAnimationFrame(() => {
      spanScheduled = false;
      spanTiles();
    });
  }

  // A late webfont swap reflows captions, so span once more when fonts load.
  // `document.fonts` is absent in unit tests.
  if (typeof document !== "undefined" && document.fonts) {
    void document.fonts.ready.then(() => scheduleSpan());
  }

  /**
  * Rows = ⌈(outer height + gap) / row unit⌉, with unit and gap read off the
  * live grid. Only the icon masonry spans.
  */
  function spanTiles(): void {
    if (view !== "grid" || query.trim() !== "") return;
    const grid = getComputedStyle(gallery);
    const unit = parseFloat(grid.gridAutoRows);
    const gap = parseFloat(grid.getPropertyValue("--masonry-gap"));
    if (!Number.isFinite(unit) || unit <= 0) return; // not the masonry right now
    for (const child of gallery.children) {
      if (!(child instanceof HTMLElement)) continue;
      const height = child.getBoundingClientRect().height;
      if (height <= 0) continue;
      const cs = getComputedStyle(child);
      const outer = height + (parseFloat(cs.marginTop) || 0) + (parseFloat(cs.marginBottom) || 0);
      child.style.gridRowEnd = `span ${Math.max(1, Math.ceil((outer + (Number.isFinite(gap) ? gap : 0)) / unit))}`;
    }
  }

  function renderGallery(opts: RenderOpts = {}): void {
    // A destination owns the surface: ambient repaints (walk settling, sync bumps,
    // late search answers) must not paint over it. Route exits reassign
    // `destination` before repainting, so they pass.
    if (destination !== null) return;
    if (opts.rail !== false) rail.build();
    buildCrumbs();
    const searching = query.trim() !== "";
    sortWrap.hidden = searching;
    segmented.hidden = searching;
    // `uploadDestination()` decides, so the button and drop target agree.
    uploadBtn.hidden = uploadDestination() === null;
    toolsSep.hidden = uploadBtn.hidden;
    // This repaint is how the bin closes, so it also ends bin mode.
    setBinMode(false, 0);
    // Results are always a list: only a row has room for path, date and page count.
    gallery.className = `gallery${searching || view === "list" ? " is-list" : ""}`;
    galleryEngine.reset();
    imgLazy?.disconnect(); // drop the previous repaint's native-image observations
    closeOpenMenu(); // a card/row menu's DOM is about to be replaced
    gallery.replaceChildren();
    // Scheduled before appending; `spanTiles` knows which layouts span.
    scheduleSpan();

    if (searching) {
      const q = query.trim();
      // Below the floor: a quiet hint, no search. In-doc find is unaffected.
      if (q.length < MIN_GLOBAL_QUERY_LEN) {
        gallery.append(
          emptyState("Keep typing", `Type at least ${MIN_GLOBAL_QUERY_LEN} characters to search your library.`),
        );
        return;
      }
      gallerySearch.renderSearch(q);
      return;
    }

    const pending = rail.pending();
    if (pending) {
      gallery.append(
        rail.loaded()
          ? // Nothing to list and no id to list it with: a destination, not a
            // load and not a failure.
            emptyState(`${pending.label} is empty`, pending.pending)
          : emptyState("Loading…", "Fetching your notebooks."),
      );
      return;
    }

    if (!listing) {
      gallery.append(emptyState("Loading…", "Fetching your notebooks."));
      return;
    }
    const entries = visibleEntries();
    if (entries.length === 0) {
      // The empty state names the thing to do; a cloud file reaches the device on
      // the next sync.
      gallery.append(
        emptyState(
          "This folder is empty",
          "Drop a PDF here to read it on your Nomad — or it'll fill up as your Supernote syncs.",
        ),
      );
      return;
    }

    gallery.append(el("div", { class: "section-head" }, el("span", { text: listingSummary(entries) })));

    for (const [i, entry] of entries.entries()) {
      gallery.append(entry.kind === "folder" ? galleryCards.folderCard(entry) : galleryCards.noteCard(entry, i));
    }
  }

  function plural(n: number, one: string): string {
    return `${n} ${n === 1 ? one : `${one}s`}`;
  }

  /**
  * Folders and docs counted separately, each half omitted at zero. "Items" is
  * the total (matching folder rows and the rail); "docs" is any file, type-neutral.
  */
  function listingSummary(entries: Entry[]): string {
    const folders = entries.filter((e) => e.kind === "folder").length;
    const docs = entries.length - folders;
    const parts: string[] = [];
    if (folders > 0) parts.push(plural(folders, "folder"));
    if (docs > 0) parts.push(plural(docs, "doc"));
    return parts.join(" · ");
  }

  function emptyState(title: string, body: string): HTMLElement {
    return el(
      "div",
      { class: "empty" },
      el("div", { class: "empty__mark", text: rail.pending()?.label ?? (folderId ? "Folder" : "Library") }),
      el("h3", { text: title }),
      el("p", { text: body }),
    );
  }

  // ---- where the reader was opened from ----
  /**
  * The note's folder path from the whole-tree cache (search results carry no
  * folder), flattened like the breadcrumb. Null when unknown; the reader then
  * omits it rather than guessing.
  */
  function folderPathOf(noteId: Id): string | null {
    for (const cached of folderCache.values()) {
      if (!cached.entries.some((e) => e.kind === "note" && e.id === noteId)) continue;
      const names = crumbPath(cached.path).map((f) => rail.labelFor(f));
      return names.length === 0 ? null : names.join(" / ");
    }
    return null;
  }

  /** Null at the root. Names via `rail.labelFor`, never `folder.name`. */
  function currentFolderPath(): string | null {
    const pending = rail.pending();
    if (pending) return pending.label;
    if (!listing) return null;
    const names = crumbPath(listing.path).map((f) => rail.labelFor(f));
    return names.length === 0 ? null : names.join(" / ");
  }

  /**
  * A non-empty shell query makes it a search arrival. `folder` names where the
  * user stands (Back returns to that listing); `search` names the note's own
  * folder, which the user doesn't know yet.
  */
  function readerReturn(noteId: Id): { origin: ReaderOrigin; href: string } {
    // Bin first: a trashed file is in no folder or search; its path is the one it
    // had when deleted.
    if (bin.isTrashed(noteId)) {
      // So the viewer paints the same countdown as the bin row.
      return {
        origin: { kind: "bin", folderPath: bin.pathOf(noteId), retention: bin.retentionOf(noteId) },
        href: destinationHref(BIN_KEY),
      };
    }
    // The shell's `query`, never the route's `?q=`, which is in-note find.
    const q = query.trim();
    if (q) return { origin: { kind: "search", folderPath: folderPathOf(noteId) }, href: searchHref(q) };
    return { origin: { kind: "folder", folderPath: currentFolderPath() }, href: folderHref(folderId) };
  }

  /**
  * Back pushes this URL rather than `history.back()`: a note opened from a
  * shared link has no app entry beneath it, and the origin is still needed to
  * name the button.
  */
  let readerBack = folderHref(null);

  /** Reading hides the topbar; toggled only in `openNote` and `enterPlace`. */
  function setReading(reading: boolean): void {
    root.classList.toggle("is-reading", reading);
  }

  /**
  * A retained version in the reused viewer, read-only. The URL is replaced
  * (not pushed) with `#/note/:id/version/:short` so reload and copy-link
  * reproduce it. `.note` uses the version's own meta (`historyMeta`), falling
  * back to live geometry; the reroute is armed before the first paint.
  */
  async function openHistoryPreview(noteId: Id, version: FileVersion, startPage = 0): Promise<void> {
    const mine = ++routeToken;
    try {
      const base = await api.getNoteMeta(noteId);
      if (mine !== routeToken) return; // navigated away while fetching
      const type = base.fileType.trim().toLowerCase();
      // A trashed file's version preview is view-only (restore the file first);
      // raw viewers read the bin-scoped history route.
      const viewOnly = bin.isTrashed(noteId);
      const origin: ReaderOrigin = {
        kind: "history",
        folderPath: currentFolderPath(),
        version: { md5: version.md5, createdAt: version.createdAt },
        viewOnly,
      };

      // Raw kinds decode the version blob (`historyFileUrl`): no reroute, no
      // `historyMeta`. Seed the canonical URL before opening.
      if (type === "spd" || type === "txt" || fileKind(type) === "image") {
        readerBack = folderHref(folderId);
        const viewer = viewerFor(base.fileType);
        activate(viewer);
        replaceRoute(noteVersionHref(noteId, shortMd5(version.md5), startPage));
        const meta = rawVersionMeta(base, version);
        viewer.open(synthesizeSummary(meta), Promise.resolve(meta), startPage, origin, "");
        setReading(true);
        return;
      }

      let template = base;
      try {
        const vmeta = await api.historyMeta(noteId, version.md5);
        if (mine !== routeToken) return;
        template = vmeta;
      } catch {
        // Degraded preview (live geometry) beats none.
      }
      readerBack = folderHref(folderId); // Back leaves the preview for the folder
      activate(reader);
      // After activate (may hide a prior viewer), before open (first paint reads through it).
      historyScope.setActive(noteId, version.md5);
      replaceRoute(noteVersionHref(noteId, shortMd5(version.md5), startPage));
      const meta = versionMeta(template, version.md5);
      reader.open(synthesizeSummary(meta), Promise.resolve(meta), startPage, origin, "");
      setReading(true);
    } catch (e) {
      historyScope.clear();
      if (handled(e)) return;
      toast("Couldn't open that version.");
    }
  }

  /**
  * A past version of a PDF's `.mark`: the live document opens unchanged and
  * only the mark's page bytes are rerouted through `historyScope`. Not
  * addressable: the version belongs to the mark's history, so a document
  * version URL could only answer "no longer available".
  */
  async function openAnnotationsPreview(
    documentId: Id,
    markId: Id,
    version: FileVersion,
  ): Promise<void> {
    const mine = ++routeToken;
    try {
      const base = await api.getNoteMeta(documentId);
      if (mine !== routeToken) return; // navigated away while fetching
      const origin: ReaderOrigin = {
        kind: "history",
        folderPath: currentFolderPath(),
        version: { md5: version.md5, createdAt: version.createdAt },
        // Defensive: the bin nulls `annotationsId` in practice.
        viewOnly: bin.isTrashed(documentId),
      };
      readerBack = folderHref(folderId); // Back leaves the preview for the folder
      const viewer = viewerFor(base.fileType);
      activate(viewer);
      // Armed on the mark, not the document; after activate, before open.
      historyScope.setActive(markId, version.md5);
      viewer.open(synthesizeSummary(base), Promise.resolve(base), 0, origin, "");
      setReading(true);
    } catch (e) {
      historyScope.clear();
      if (handled(e)) return;
      toast("Couldn't open those annotations.");
    }
  }

  /**
  * The one restore path behind the panel and the banner; `runRestore` owns the
  * toast and 507 message. `returnTo` differs only for PDF annotations: the
  * `.mark` is restored, the document reopens.
  */
  function restoreVersion(
    noteId: Id,
    version: { md5: string; createdAt: number },
    _noteName: string,
    returnTo: Id = noteId,
  ): Promise<boolean> {
    return runRestore({
      api,
      noteId,
      md5: version.md5,
      confirm: () => confirmRestore(root, version),
      toast,
      handled,
      onRestored: () => {
        historyScope.clear();
        void refetch(folderId, folderCache.get(folderId));
        rail.build();
        go(noteHref(returnTo));
      },
    });
  }

  /**
  * Bumped per library/note transition, so a late `getNoteMeta` can't reopen the
  * reader (and hide the topbar) over a folder route.
  */
  let routeToken = 0;

  // ---- data / freshness ----
  /**
  * A category with no device folder yet: not a root navigation, no request.
  * The one unaddressable place (no id); the URL is replaced with the root so it
  * doesn't lie, via `replaceRoute` so the pending state survives.
  */
  function enterPendingCategory(): void {
    hideActiveViewer();
    setReading(false);
    leaveAdmin();
    leaveAccount();
    destination = null;
    folderId = null;
    listing = undefined;
    query = "";
    searchInput.value = "";
    search.reset();
    replaceRoute(folderHref(null));
    renderGallery();
  }

  // ---- the delayed loading paint ----
  // Loading, known-empty and "still the last folder" are different states. The
  // "Loading…" paint is delayed so a fast response shows none at all.

  /** The usual "no longer instantaneous" threshold. */
  const LOADING_PAINT_DELAY_MS = 150;

  let loadingPaintTimer: ReturnType<typeof setTimeout> | undefined;

  function cancelLoadingPaint(): void {
    if (loadingPaintTimer === undefined) return;
    clearTimeout(loadingPaintTimer);
    loadingPaintTimer = undefined;
  }

  /**
  * Paints only the place it was armed for: re-reads `folderId`, `query` and
  * `destination` and drops itself if any moved.
  */
  function scheduleLoadingPaint(id: Id | null): void {
    cancelLoadingPaint();
    loadingPaintTimer = setTimeout(() => {
      loadingPaintTimer = undefined;
      if (folderId !== id || destination !== null || query.trim() !== "") return;
      if (listing !== undefined) return; // a listing arrived by another path
      // The walk may have cached it meanwhile.
      const cached = folderCache.get(id);
      if (cached) listing = cached;
      renderGallery();
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
    const mine = routeToken;
    cancelLoadingPaint();
    rail.clearPending();
    folderId = id;
    query = "";
    searchInput.value = "";
    // Clears transcript hits too.
    search.reset();
    const cached = folderCache.get(id);
    if (cached) {
      listing = cached;
      renderGallery(); // stale-while-revalidate: paint immediately
    } else {
      // Cache miss: drop `listing` now (it describes the old folder, and any repaint
      // meanwhile would mix the two); only the paint waits.
      listing = undefined;
      scheduleLoadingPaint(id);
    }
    await refetch(id, cached);
    if (mine === routeToken) cancelLoadingPaint();
  }

  /**
  * A 404, or an empty `path` for a non-null id, both mean the folder is gone.
  * `redirect`, not `go`, so Back can't climb onto it; the toast explains.
  */
  function missingFolder(): void {
    toast("That folder isn't there any more.");
    redirect(folderHref(null));
  }

  /**
  * Late answers about a place the user has left are dropped, so a stale folder
  * failure can't replace an open bin or redirect out of it.
  */
  function galleryIsOnScreen(): boolean {
    return destination === null && !bin.isOpen();
  }

  async function refetch(id: Id | null, prev: Listing | undefined): Promise<void> {
    let fresh: Listing;
    try {
      // Through the cache, so boot's root listing and walk share one request.
      fresh = await folderCache.listFolder(id);
    } catch (e) {
      // A dead session isn't "couldn't load".
      if (handled(e)) return;
      if (id !== folderId) return; // navigated away while failing
      if (!galleryIsOnScreen()) return;
      // A 404 won't improve on retry; other failures keep the retry state.
      if (id !== null && e instanceof ApiError && e.status === 404) {
        missingFolder();
        return;
      }
      if (!prev) {
        listing = undefined;
        gallery.replaceChildren(emptyState("Couldn't load", "Check your connection and try again."));
      }
      return;
    }
    if (id !== folderId) return; // navigated away while fetching
    // The root legitimately has an empty path.
    if (id !== null && fresh.path.length === 0) {
      if (galleryIsOnScreen()) missingFolder();
      return;
    }
    knownSyncVersion = Math.max(knownSyncVersion, fresh.syncVersion);

    const result = reconcile(prev, fresh);
    // `result.listing` keeps unchanged entry objects, so identity-keyed work stays put.
    folderCache.put(id, result.listing);
    if (result.changed || listing !== result.listing) {
      listing = result.listing;
      // Not while the bin is open: a restore triggers this refetch and repainting
      // would close the bin.
      if (!bin.isOpen()) renderGallery();
    }
  }

  /**
  * Documents still being derived, or `null` if the server never said (old
  * server, polling fallback). Null means "say nothing", not zero.
  */
  let indexPending: number | null = null;

  function onBump(version: number): void {
    knownSyncVersion = Math.max(knownSyncVersion, version);
    if (classify(folderCache.get(folderId), knownSyncVersion) === "stale") {
      void refetch(folderId, folderCache.get(folderId));
      void folderCache.prefetch(true);
    }
  }
  /** Repaints only the search, and only when the number moved. */
  function onIndex(status: IndexStatus): void {
    if (status.pending === indexPending) return;
    indexPending = status.pending;
    if (query.trim() !== "" && destination === null && activeViewer === null) renderGallery();
  }
  const unsubscribe = live.subscribe(onBump, onIndex);

  // The index's lifecycle on the same socket: derive-complete and sync frames
  // coalesce in `attachLive`, so a big sync is a few manifest requests. Nothing
  // here instantiates the engine; only `search()` does.
  const detachSearchLive = searchService.attachLive(live);
  void searchService.syncNow();

  // ---- view / theme ----
  function setView(next: View): void {
    view = next;
    gridBtn.setAttribute("aria-pressed", String(next === "grid"));
    listBtn.setAttribute("aria-pressed", String(next === "list"));
    renderGallery();
  }

  /** Drop off-theme bitmaps and repaint what's on screen; the rest re-lazy. */
  function repaintForTheme(previous: Theme): void {
    void cache.evictTheme?.(previous);
    thumbnails.evictTheme(previous);
    // The Appearance control claims a theme, including on the OS-flip path.
    accountPage?.themeChanged();
    galleryEngine.bumpTheme();
    reader.bumpTheme();
  }

  /**
  * A no-op if already in force. The first press of the followed theme still
  * pins it, which stops following the OS.
  */
  function setThemeTo(next: Theme): void {
    const previous = currentTheme();
    setTheme(next);
    if (previous === next) {
      accountPage?.themeChanged();
      return;
    }
    repaintForTheme(previous);
  }

  // Follow the OS theme until one is pinned (`data-theme` wins). Handlers are
  // named so `destroy()` can remove them.
  const osThemeQuery = window.matchMedia?.("(prefers-color-scheme: dark)");
  const onOsThemeChange = (e: MediaQueryListEvent): void => {
    if (document.documentElement.getAttribute("data-theme")) return;
    // The theme being left is the inverse of the new one.
    repaintForTheme(e.matches ? "light" : "dark");
  };
  osThemeQuery?.addEventListener("change", onOsThemeChange);

  let resizeTimer: ReturnType<typeof setTimeout> | undefined;
  const onWindowResize = (): void => {
    if (resizeTimer !== undefined) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      galleryEngine.repaintVisible();
      reader.bumpTheme();
    }, 150);
  };
  window.addEventListener("resize", onWindowResize);

  /** The shell-level reset every route into a place performs. */
  function enterPlace(): void {
    routeToken++;
    hideActiveViewer();
    setReading(false);
    rail.clearPending();
  }

  // The first listing comes from main.ts's route dispatch; listing here would race it.
  void folderCache.prefetch();

  return {
    el: root,

    showFolder(id: Id | null): void {
      enterPlace();
      leaveAdmin();
      leaveAccount();
      destination = null;
      void navigate(id);
      requestAnimationFrame(() => galleryEngine.repaintVisible());
    },

    showSearch(q: string): void {
      // An empty `#/search` is corrected, not rendered.
      if (q.trim() === "") {
        redirect(folderHref(folderId));
        return;
      }
      enterPlace();
      destination = null;
      // The box agrees with the URL on reload or shared link.
      if (searchInput.value !== q) searchInput.value = q;
      applyQuery(q);
      // After the arriving-keystroke navigation's blur; a no-op otherwise.
      restoreSearchFocus();
    },

    showDestination(key: string): void {
      enterPlace();
      leaveAccount();
      query = "";
      searchInput.value = "";
      search.reset();
      // Assigned per arm: the admin arm must first repaint over a mounted bin, which
      // `renderGallery` refuses while `destination` names one.
      destination = null;
      switch (key) {
        // --- BIN ROUTE ---
        case BIN_KEY:
          leaveAdmin(); // one destination at a time
          destination = key;
          bin.open();
          rail.build(); // the bin is open now; repaint the highlight
          return;
        // --- ADMIN ROUTE ---
        case ADMIN_KEY:
          // The bin closes by being repainted over; do it while `destination` is null so
          // the guard lets it through.
          if (bin.isOpen()) renderGallery({ rail: false });
          destination = key;
          openAdmin();
          return;
        default:
          // Unreachable via the router; a removed destination's URL still lands somewhere.
          redirect(folderHref(folderId));
          return;
      }
    },

    showAccount(): void {
      enterPlace();
      // Same as the admin arm.
      if (bin.isOpen()) renderGallery({ rail: false });
      leaveAdmin();
      query = "";
      searchInput.value = "";
      search.reset();
      destination = ACCOUNT_KEY;
      account().open();
      // No rail row matches, so the highlight goes off.
      rail.build();
    },

    async openNote(id: Id, page = 0, q = ""): Promise<void> {
      const mine = ++routeToken;
      historyScope.clear();
      try {
        const { origin, href } = readerReturn(id);
        
        let summary: NoteSummary | undefined;
        if (listing) {
          summary = listing.entries.find((e): e is NoteSummary => e.kind === "note" && e.id === id);
        }
        
        let metaPromise: Promise<NoteMeta>;
        if (summary) {
          metaPromise = api.getNoteMeta(id);
        } else {
          const meta = await api.getNoteMeta(id);
          if (mine !== routeToken) return;
          summary = synthesizeSummary(meta);
          metaPromise = Promise.resolve(meta);
        }
        
        readerBack = href;
        const v = viewerFor(summary.fileType);
        activate(v);
        v.open(summary, metaPromise, page, origin, q);
        setReading(true);
      } catch (e) {
        if (handled(e)) return;
        toast("That note couldn't be opened.");
        // `redirect`, not `go`: a gone note never named a place.
        redirect(folderHref(folderId));
      }
    },

    async openNoteVersion(id: Id, short: string, page = 0): Promise<void> {
      const mine = ++routeToken;
      // Resolved against the panel's list; a non-session failure degrades to the live note.
      let history: Awaited<ReturnType<typeof api.noteHistory>>;
      try {
        history = await api.noteHistory(id);
      } catch (e) {
        if (mine !== routeToken) return;
        if (handled(e)) return;
        redirect(notePageHref(id, page));
        return;
      }
      if (mine !== routeToken) return; // routed away while fetching
      const match = resolveVersionShort(history.versions, short);
      if (match.kind === "past") {
        await openHistoryPreview(id, match.version, page);
        return;
      }
      // Current or none: the live note at its canonical URL (`redirect` replaces).
      // Current must not 404 after a restore; none gets a notice.
      if (match.kind === "none") toast("That version is no longer available.");
      redirect(notePageHref(id, page));
    },

    async openBinNote(id: Id, page = 0): Promise<void> {
      const mine = ++routeToken;
      // A bin open is never a version preview.
      historyScope.clear();
      // On a cold `#/bin/note/:id` this awaits the boot listing.
      try {
        await bin.ensureLoaded();
      } catch (e) {
        if (mine !== routeToken) return;
        if (handled(e)) return;
        // The bin will show its own load error.
        redirect(destinationHref(BIN_KEY));
        return;
      }
      if (mine !== routeToken) return; // routed away while the listing loaded
      // Not in the bin (purged, restored, never trashed): the listing plus a notice.
      if (!bin.isTrashed(id)) {
        toast("That file is no longer in the recycle bin.");
        redirect(destinationHref(BIN_KEY));
        return;
      }
      try {
        // The same origin a row click produces; meta comes via `binScope`.
        const { origin, href } = readerReturn(id);
        const meta = await api.getNoteMeta(id);
        if (mine !== routeToken) return; // routed away while fetching
        readerBack = href;
        const v = viewerFor(meta.fileType);
        activate(v);
        v.open(synthesizeSummary(meta), Promise.resolve(meta), page, origin, "");
        setReading(true);
      } catch (e) {
        if (handled(e)) return;
        toast("That file couldn't be opened.");
        redirect(destinationHref(BIN_KEY));
      }
    },

    destroy(): void {
      unsubscribe();
      // Otherwise one coalescing window and engine memory leak per sign-in cycle.
      detachSearchLive();
      searchService.dispose();
      // Otherwise these accumulate per sign-in cycle, each holding the shell alive.
      osThemeQuery?.removeEventListener("change", onOsThemeChange);
      window.removeEventListener("resize", onWindowResize);
      if (resizeTimer !== undefined) clearTimeout(resizeTimer);
      cancelLoadingPaint();
      // Kills the debounce timer and orphans in-flight queries.
      search.reset();
      bin.destroy();
      reader.destroy();
      spdViewer.destroy();
      txtViewer.destroy();
      admin?.destroy();
      accountPage?.destroy();
      // Aborts uploads and drops the document-level drag swallowers.
      uploadZone.destroy();
      galleryEngine.destroy();
      // Release the ~5 MB MuPDF worker now, not after its idle window.
      pdfThumbs.destroy();
    },
  };
}

export function synthesizeSummary(meta: NoteMeta): NoteSummary {
  return {
    kind: "note",
    id: meta.id,
    name: meta.name,
    pageCount: meta.pages.length,
    firstPage: meta.pages[0] ?? skeletonPage(0),
    updatedAt: 0,
    fileType: meta.fileType,
    fileHash: meta.fileHash,
    hasRecognizedText: meta.pages.some((p) => p.textHash !== null),
    thumbAspect: undefined,
    // The meta is the authority on the mark pairing.
    annotationsId: meta.annotationsId,
  };
}
