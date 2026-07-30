// The library shell (P3) — the signed-in app: a left rail of folders, a topbar
// (breadcrumbs, search, sort, view toggle, theme toggle), and a gallery grid of
// lazily-thumbnailed notes, with the reader overlaying it. Ported from the
// approved mockup; the chrome stays quiet and the note canvases carry the colour.
//
// This is a *controller* (created once in main.ts, kept alive across route
// changes) rather than a per-render page, so the gallery's lazy state and the
// reader survive navigating in and out of a note — matching the mockup, where the
// gallery lives on behind the reader.
//
// THE ROUTE IS THE SOURCE OF TRUTH, AND THIS SHELL REACTS TO IT. It used to own
// `folderId` as internal state and the rail called `navigate()` directly, which
// meant opening a subfolder and reloading put you back at the root, the recycle
// bin and the admin console had no address at all, and Back's meaning depended on
// which of two navigation systems you had last used. Now every entry point — a
// rail row, a gallery folder card, the breadcrumb, the search box, the bin — does
// nothing but `go()` a URL, and the four `show*` methods below are the ONLY
// writers of the state that URL describes. See `router.ts` for the rule and
// docs/explanation/routing.md for why addressability and history are separate.

import { el } from "../ui/dom";
import { ICONS, svg, type IconName } from "../ui/icons";
import { closeOpenMenu } from "../ui/menu";
import { currentTheme, setTheme } from "../ui/theme";
import { formatBytes, fileKind } from "../core/fileKind";
import { api as authApi } from "../api/client";
import { SORT_KEY, readLocal, writeLocal } from "../ui/storage";
import {
  current,
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
import type { Api } from "../api/types";
import type { NoteRenderer } from "../render/types";
import type { RenderCache } from "../cache/types";
import type { PersistentThumbStore } from "../cache/idb";
import type { LiveChannel } from "../sync/types";
import type { Entry, Folder, Hash, Id, Listing, NoteMeta, NoteSummary, Theme } from "../core/types";
import { skeletonPage } from "../core/noteSkeleton";
import { ApiError, NameTakenError, dispatchApiFailure, type ApiFailureSink } from "../api/client";
import { openRenameDialog } from "../ui/renameDialog";
import { createExporter, type Exporter } from "../export/exporter";
import { createLazyEngine, renderPage, type LazyEngine } from "../render/lazy";
import {
  createThumbnails,
  createCanvasThumbPainter,
  createFetchThumbNet,
  type Thumbnails,
} from "../render/thumbnails";
import { classify, reconcile } from "../sync/freshness";
import { createReader, type Reader, type ReaderOrigin } from "./reader";
// The multi-viewer seam: a file's type picks a viewer, all conforming to the one
// `Viewer` shape (see `pages/viewer.ts`). The reader is the default; the `.spd`
// and `.txt` stubs are wired in at `viewerFor` below.
import { createSpdViewer } from "./spdViewer";
import { createTxtViewer } from "./txtViewer";
import type { Viewer, ViewerDeps } from "./viewer";
import { createNoteSearch, MIN_GLOBAL_QUERY_LEN, type SearchState } from "./noteSearch";
// The three features pulled out of this god-file (Review-2 Pass-2 #3), each fed
// an explicit context the controller builds — no hidden coupling back in.
import { createGalleryCards, type GalleryCards } from "./galleryCards";
import { createCardActions } from "./cardActions";
import { createHistoryScope, versionMeta, rawVersionMeta } from "./historyScope";
import { createHistoryController, runRestore, confirmRestore } from "./historyPanel";
import type { FileVersion } from "../core/types";
import { createGallerySearch, type GallerySearch } from "./gallerySearch";
// The rail and the tree/category resolution it rests on. `crumbPath` comes from
// there too: the breadcrumb is painted here, where its other inputs (the search
// query, the pending category) live, but the container-flattening rule it
// applies is the RAIL'S rule and there is exactly one copy of it.
import { createRail, createRailView, crumbPath, type FolderTree, type RailController } from "./rail";
// The recycle bin. It paints into `gallery` and is closed by `renderGallery()`
// overwriting it, so there is no teardown hook here — see bin.ts's header.
import { BIN_KEY, createBin, createBinScope, createBinView, type BinController } from "./bin";
// TYPE ONLY, so the console still code-splits: `import type` is erased, and the
// one runtime `import("./admin")` below is what pulls the chunk. Most households
// have a single admin, so the console's code and CSS should not ride along in
// every reader's first paint.
import type { AdminPanel } from "./admin";

/** The admin console's {@link Destination} key. Matches `DESTINATIONS` in rail.ts. */
const ADMIN_KEY = "admin";

export interface AppDeps {
  api: Api;
  renderer: NoteRenderer;
  cache: RenderCache;
  /**
   * The persistent thumbnail store (`sn-thumbs`), the SAME instance the render
   * cache uses (main.ts opens it once and passes it to both). Shared so the
   * facade's `.spd`/`.txt`/cover/image thumbnails persist across reloads in the
   * one store, under the one byte budget — the render path already did. Optional/
   * null in tests and any host that runs memory-only.
   */
  persistentThumbs?: PersistentThumbStore | null;
  live: LiveChannel;
  /**
   * Who is signed in. `isAdmin` reaches the rail so admin-only destinations can
   * be hidden — a rail row is NOT the access check (the server gates every admin
   * route), it just avoids showing a door that always refuses.
   */
  identity: { email: string; isAdmin: boolean };
  onSignOut: () => void;
  /**
   * The `sn_session` cookie went invalid while the shell was open — every
   * subsequent call would fail the same way. Like {@link onSignOut} this is a
   * callback rather than a router import: the shell never navigates the app
   * itself, main.ts owns that (it is the composition root). Fired at most once
   * per shell.
   */
  onSessionExpired: () => void;
}

/**
 * THE ROUTE HANDLERS, and the only writers of "where the shell is".
 *
 * One per kind of place, called by main.ts and by nothing else. Each is
 * IDEMPOTENT — a route can be dispatched twice (see `onRoute` in router.ts) and
 * `go()` re-fires deliberately when the target is already current — and each
 * performs the SAME shell-level reset, because every one of them means "you are
 * somewhere else now": the reader closes, the console closes, the pending
 * category clears.
 */
export interface AppShell {
  el: HTMLElement;
  /**
   * List a folder — `#/folder/:id`, or the library root (`#/`) for `null`.
   *
   * The id is the device's, and it is stable by design: the device assigns it
   * and nothing ever relocates a row, which is what makes a folder link outlive
   * a sync.
   */
  showFolder(id: Id | null): void;
  /**
   * Show library-wide results for `q` — `#/search?q=`. A blank query is not a
   * place; it redirects back to the folder the shell is standing in.
   */
  showSearch(q: string): void;
  /**
   * Show a {@link Destination} — `#/bin`, `#/admin`. The key is the rail's own,
   * so there is nothing here that can drift from `DESTINATIONS`.
   *
   * `#/admin` LANDS ON THE ELEVATION GATE, never on the console. Addressable is
   * not accessible: the server gates every admin route on `require_admin` plus a
   * live elevation, and a bookmark must not imply otherwise.
   */
  showDestination(key: string): void;
  /**
   * Open a note in the reader at `page` — the INTERNAL 0-based index. The route
   * it came off counts from one (`#/note/:id` and `#/note/:id/page/1` are both
   * the first page, `/page/5` is the fifth); the conversion happens in the
   * router and nowhere else. `q` primes find-in-note (`?q=term`).
   *
   * All three come from the ROUTE rather than being held here, so a reload or a
   * shared link lands on exactly the document, the page and the search the URL
   * describes.
   */
  openNote(id: Id, page?: number, q?: string): Promise<void>;
  /**
   * Resolve a `#/note/:id/version/:short` deep link (hot-cache versioning) and
   * open what it names, at `page` (the INTERNAL 0-based index). `short` is a
   * 7-hex-char md5 prefix; resolution is client-side against `noteHistory` (the
   * list the panel already fetches), LIVE-FIRST:
   *
   *  - a PAST version → the read-only preview in the reused reader;
   *  - the CURRENT md5 → the LIVE note, with the URL canonicalised to the bare
   *    `#/note/:id/page/:n` (a restore can make a past version's md5 the live one,
   *    so this branch must win and never 404);
   *  - no match (aged out of the hot cache / bad prefix) → the live note + a
   *    "no longer available" notice, never a blank or hard error.
   */
  openNoteVersion(id: Id, short: string, page?: number): Promise<void>;
  /**
   * Open a `#/bin/note/:id/page/:n` deep link — a TRASHED file in its viewer, at
   * `page` (the INTERNAL 0-based index). The recycle-bin twin of {@link openNote}:
   * it ensures the bin listing is loaded (a cold load races the boot-time fetch),
   * then finds the trashed entry and opens it with a `"bin"` origin — the SAME
   * path a bin-row click takes (`readerReturn` → bin origin, `viewerFor` → the
   * right viewer), so Back says "Recycle bin", the file's actions are Restore /
   * Delete permanently, and its bytes come off the bin-scoped routes.
   *
   * GRACEFUL FALLBACK: a file no longer in the bin (purged or restored since the
   * link was made) falls back to the bin LISTING (`#/bin`) with a notice — the
   * analog of the version-preview age-out — never a blank or a hard 404.
   */
  openBinNote(id: Id, page?: number): Promise<void>;
  destroy(): void;

  // --- DESTINATION VIEWS (append-only, at your own marker) ---
  // A `Destination` (see `rail.ts`) is a full-content view that is not a folder.
  // Each one is now a line in `DESTINATIONS`, an arm in `showDestination` below,
  // and nothing else — no method of its own. The rail routes (`go(#/key)`), the
  // router recognises the key because it reads the same list, and the shell
  // reacts. Two features can still do this in parallel; the marked arms are
  // where the edits go.
}

type SortKey = "recent" | "title" | "pages";

/**
 * The pinned sort order, or "recent" when nothing valid is stored.
 *
 * VALIDATED rather than cast: the value is user-writable (it is localStorage) and
 * a stale key from an older build — or a hand-edited one — would otherwise reach
 * the comparator as a `SortKey` it does not handle, silently leaving the gallery
 * in whatever order the listing happened to arrive in. An unrecognised value is
 * not an error worth surfacing; it just means "never chose".
 */
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
   * Routes reads for a TRASHED id through the bin's own endpoints (U2b).
   *
   * WRAPPED ONCE, HERE, so that `api` means the same thing everywhere below it.
   * The reader, the lazy render engine, the exporter and `openNote` all pull
   * note metadata or page bytes through this seam, and none of them should have
   * to know that a bin exists. The server keeps the two scopes on separate
   * routes deliberately — `Files.get` hardcodes `deleted = 0` and is the shared
   * ownership boundary behind every live read — so the split has to be honoured
   * somewhere, and this is the one place that costs nothing downstream.
   *
   * `attach` supplies the predicate further down, because the bin controller is
   * built after most of the things that read through this wrapper. Until then
   * nothing is trashed, which is the reading that changes no behaviour.
   */
  const binScope = createBinScope();

  /**
   * The admin console, created on FIRST ENTRY and kept for the life of the
   * shell. Null until then — the module is dynamically imported, so there is
   * nothing to hold before somebody has asked for it.
   */
  let admin: AdminPanel | null = null;

  /**
   * The user is going somewhere that is not a destination — a folder, a
   * category, a search. Called from the three places that are genuinely user-
   * driven navigation.
   *
   * NOT from `renderGallery`, which is how the bin closes: that also fires on a
   * live sync bump, and ejecting an admin from a half-typed delete confirmation
   * because a housemate's tablet finished uploading is not something the shell
   * should do. The bin can afford it (it is a listing); the console cannot.
   */
  function leaveAdmin(): void {
    // The stand-in below is the console for as long as its chunk is on the wire,
    // so leaving has to take that down too — otherwise a rail click during the
    // import leaves an "Opening the admin console" overlay sitting on top of the
    // folder the user asked for, with no console ever arriving to replace it.
    hideAdminBooting(false);
    admin?.close();
  }

  /**
   * THE CHUNK-IMPORT WINDOW, painted.
   *
   * `import("./admin")` is a round trip of its own — a separate module request,
   * on the same throttled link as everything else — and nothing used to be
   * painted before or during it. So the previous folder's gallery stayed on
   * screen, under a rail highlight that had already moved to Admin, for the whole
   * of it; and from the BIN it was worse, because the console's route closes the
   * bin by repainting the gallery over it, so the sequence was bin → a folder
   * listing nobody asked for → a long gap → the console.
   *
   * This is a STAND-IN, not the console: it takes the same surface the panel will
   * take (the content overlay, the topbar, the crumb) and says the one true thing
   * there is to say. The panel replaces it wholesale when the chunk lands, and it
   * deliberately reuses `.admin-notice` so the swap is a change of words rather
   * than a change of layout.
   *
   * Built lazily and kept: a session that never opens the console never creates
   * it, and one that does creates it once.
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
    // Exactly what `AdminPanel.chrome(true)` does, and for the same reasons: the
    // gallery is HIDDEN rather than emptied (so leaving the console lands back on
    // the folder without a refetch), sort and the view toggle describe a listing
    // this is not, and the crumb has to agree with the rail highlight. `lockBtn`
    // stays hidden — there is nothing to lock yet.
    gallery.hidden = true;
    sortWrap.hidden = true;
    segmented.hidden = true;
    setDestinationMode("admin", true);
    crumbs.replaceChildren(el("span", { class: "crumbs__here", text: "Admin" }));
    rail.build(); // the highlight reads `destination`, already ADMIN_KEY
  }

  /**
   * Take the stand-in down. `handOver` is true when the real console is taking
   * this surface over — the chrome it just set is the chrome the panel wants, so
   * touching it would flash the gallery back — and false when the route has left,
   * in which case everything the stand-in claimed has to be given back.
   */
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
   * Put the console up, importing it on first entry.
   *
   * IT ALWAYS LANDS ON THE ELEVATION GATE from a cold start, and that is the
   * client half of "addressable is not accessible": a bookmarked `#/admin`
   * reaches this on a fresh document where `admin` is null, so the panel is
   * built from scratch and `console_.open()` paints the gate. Re-entry inside
   * one session deliberately does not rebuild — the elevation is a fact about
   * the session and the server is its authority — but there is no reload, no
   * bookmark and no typed URL that can skip the gate, because none of them can
   * arrive with an `admin` that already exists.
   */
  function openAdmin(): void {
    if (admin) {
      admin.open();
      rail.build();
      return;
    }
    // Painted BEFORE the import is issued, so there is no frame in which the
    // surface still belongs to whatever was here before — see `showAdminBooting`.
    showAdminBooting();
    // The one runtime import. Everything it is handed is something this shell
    // already owns — the panel creates nothing here but its own <section>.
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
          // THE PADLOCK MUST NOT LIE. Elevation changes in three places — an
          // unlock, a lock, and a 428 that parks the console back on the gate —
          // and only the panel sees any of them. Every one of them comes through
          // here, and the rail is a pure function of what it is asked, so a
          // rebuild is the whole of the update.
          onElevationChanged: () => rail.build(),
          toast,
          onSessionExpired: sessionDidExpire,
        });
        // The import is a round trip, and a route change can land inside it: a
        // rail click while the chunk is loading would otherwise open the console
        // over the folder the user has just asked for. `destination` is the
        // route's answer, so checking it here is checking whether the console is
        // still where the URL says we are.
        if (destination !== ADMIN_KEY) {
          hideAdminBooting(false);
          return;
        }
        // HAND OVER, don't tear down: `admin.open()` sets exactly the chrome the
        // stand-in is already holding, so giving it back first would flash the
        // gallery between the two.
        hideAdminBooting(true);
        admin.open();
        rail.build(); // the console is open now; repaint the highlight
      })
      .catch(() => {
        // The chunk itself failed to load — a dropped link mid-import, or a stale
        // tab asking a redeployed server for a hash that no longer exists. Left
        // alone this sat on "Loading…" for the rest of the session, which is the
        // one thing a loading state must never do: outlive the thing it describes.
        if (destination !== ADMIN_KEY || !adminBooting) return;
        adminBooting.replaceChildren(
          adminNotice("The console could not be loaded", "Check your connection and try again."),
        );
      });
  }
  // Two seam wrappers, composed: `historyScope` reroutes page bytes + in-note
  // search onto a retained VERSION while a preview is up (H7/H8), `binScope`
  // reroutes them onto the bin for a trashed note. They never both fire (a preview
  // is only ever of a LIVE note), and each is a pure passthrough when inactive, so
  // the order is immaterial; the reader reads through the composed result unchanged.
  const historyScope = createHistoryScope();
  const api = historyScope.wrap(binScope.wrap(deps.api));

  // --- state ---------------------------------------------------------------
  //
  // `folderId`, `destination` and `query` are not this shell's decisions any
  // more: each is written ONLY by the `show*` route handler that owns it, so all
  // three are a cache of what the address bar says rather than a second opinion
  // about it. That is the whole of the inversion — everything else here already
  // read them.
  /**
   * The folder the gallery is listing (`null` = root), from the folder route.
   *
   * SURVIVES A NOTE OR A DESTINATION, deliberately: the reader is an overlay and
   * the bin paints over the gallery, so neither moves you out of the folder you
   * were in — which is what lets Back out of a note, or a rail click out of the
   * bin, land in that folder's cached listing rather than at the root.
   */
  let folderId: Id | null = null;
  /**
   * The {@link Destination} key currently open, from the destination route, or
   * null. THE RAIL'S HIGHLIGHT READS THIS, not `bin.isOpen()`/`admin.isOpen()`,
   * so it cannot disagree with the address bar: the two panels' own open flags
   * follow their DOM, and DOM can be repainted by a live sync bump that no route
   * change accompanied.
   */
  let destination: string | null = null;
  let listing: Listing | undefined;
  const cachedListings = new Map<string, Listing>();
  let rootFolders: Folder[] = [];
  let query = "";
  let sort: SortKey = readStoredSort();
  let view: View = "grid";
  let knownSyncVersion = 0;
  const key = (id: Id | null) => id ?? "\0root";

  // --- failure routing -----------------------------------------------------
  /**
   * An expired session is terminal for this shell, and it arrives in a *burst*:
   * a gallery of thumbnails plus the tree prefetch all 401 at once. The latch
   * makes that one hand-off to main.ts, and — since the flag also short-circuits
   * every later handler — an UNAUTHORIZED raised *during* the expiry handling
   * itself can't re-trigger it.
   */
  let sessionExpired = false;
  function sessionDidExpire(): void {
    if (sessionExpired) return;
    sessionExpired = true;
    deps.onSessionExpired();
  }

  /**
   * A thumbnail's `?v=` hash 404'd. That hash came from this folder's listing
   * (`NoteSummary.firstPage`), so the listing is the metadata to refetch to honour
   * the STALE_PAGE contract. One refetch per stale hash — a refetch yields new
   * hashes, and if those 404 too we must not spin.
   */
  const staleHandled = new Set<Hash>();
  function onStaleThumbnail(hash: Hash): void {
    if (sessionExpired || staleHandled.has(hash)) return;
    staleHandled.add(hash);
    void refetch(folderId, cachedListings.get(key(folderId)));
  }

  const failures: ApiFailureSink = {
    onSessionExpired: sessionDidExpire,
    onStalePage: (_noteId, page) => onStaleThumbnail(page.hash),
  };

  /**
   * Classify a caught error from a *listing/metadata* call (no page involved).
   * Returns true when it was actionable and the caller should skip its own
   * fallback; anything else stays non-fatal, exactly as before.
   */
  function handled(e: unknown): boolean {
    return dispatchApiFailure(failures, e);
  }

  // --- DOM: rail -----------------------------------------------------------
  // `aria-busy` until the tree walk lands: the rail pins all six categories from
  // the first paint, so until then its counts and its resolved/absent split are
  // provisional. It is a real a11y signal, not a test hook — a screen reader
  // should not announce "Export, 0" as settled while it is still being counted.
  const nav = el("nav", { class: "nav", "aria-label": "Folders", "aria-busy": "true" });

  /**
   * The rail's entries, and with them the whole category/container model — see
   * `rail.ts`. This shell keeps only what the rail cannot know: the listing
   * cache it reads through {@link FolderTree}, where the user currently is, and
   * what selecting a row means for the reader, the search box and the gallery.
   *
   * The rail is a PURE FUNCTION of the cache plus `place()`: it never fetches,
   * so `prefetchTree` below stays the only thing that asks the server about
   * folders.
   */
  const tree: FolderTree = {
    roots: () => rootFolders,
    children: (id) => {
      const cached = cachedListings.get(key(id));
      return cached ? cached.entries.filter((e): e is Folder => e.kind === "folder") : [];
    },
    walked: (id) => cachedListings.has(key(id)),
  };

  const rail: RailController = createRail({
    view: createRailView(nav),
    tree,
    // `listing` being undefined is not the same as an empty path: with no
    // listing nothing is expanded, not even the current folder.
    //
    // A DESTINATION IS MUTUALLY EXCLUSIVE WITH A FOLDER (see `RailPlace`), so
    // while the bin is open this reports no folder at all rather than the one
    // the user happened to be standing in — otherwise two rows would be
    // `aria-current` at once. The shell's own `folderId`/`listing` are left
    // untouched, which is what lets a rail click out of the bin land back in
    // that folder's cached listing.
    // BOTH HALVES COME OFF THE ROUTE, via the two variables only the `show*`
    // handlers write. It used to ask `admin?.isOpen()`/`bin.isOpen()`, which is
    // a question about DOM: the bin unmounts whenever the gallery repaints, and
    // the gallery repaints on a live sync bump nobody navigated for, so the
    // highlight could drift from the address bar with no route change in
    // between. Now it cannot — the rail says what the URL says.
    //
    // A DESTINATION IS MUTUALLY EXCLUSIVE WITH A FOLDER (see `RailPlace`), so
    // while one is open this reports no folder at all rather than the one the
    // user happened to be standing in — otherwise two rows would be
    // `aria-current` at once. The shell's own `folderId`/`listing` are left
    // untouched, which is what lets a rail click out of the bin land back in
    // that folder's cached listing.
    place: () =>
      destination !== null
        ? { folderId: null, destination, openPath: null }
        : {
            folderId,
            destination: null,
            openPath: listing ? listing.path : null,
            // Not a highlight — see `RailPlace.searching`. It is what tells the
            // walk that the gallery currently on screen (a results list, whose
            // name half reads the cached tree) depends on it finishing.
            searching: query.trim() !== "",
          },
    // EVERY ENTRY POINT IS NOW A URL. The rail does not navigate; it says where
    // it wants to be and the route handler takes it there. That is what makes
    // "open a subfolder, reload, and you are still in it" true without the rail
    // knowing anything about reloads.
    onOpenFolder: (id) => go(folderHref(id)),
    onSelectCategory: () => enterPendingCategory(),
    onOpenDestination: (key) => go(destinationHref(key)),
    // Append your arm at your marker; a destination with nothing to count
    // returns 0 and renders no badge.
    destinationCount: (key) => {
      switch (key) {
        // --- BIN COUNT ---
        case BIN_KEY:
          return bin.count();
        // --- ADMIN COUNT ---
        // No arm for "admin", deliberately: the console has nothing whose
        // number belongs on a rail badge. The only count it could carry is how
        // many people are in the household, and a standing figure about
        // housemates on the navigation is the kind of ambient stat this console
        // was designed not to keep. `default` returns 0, which renders none.
        default:
          return 0;
      }
    },
    // Append your arm at your marker; a destination with no state to show
    // returns null and renders no glyph.
    destinationState: (key) => {
      switch (key) {
        // --- ADMIN STATE ---
        // THE PADLOCK. It says whether the console is elevated right now, so
        // that "am I still in?" is answerable from the navigation instead of
        // by opening the console and finding out. It is a fact the panel owns
        // (the server is the authority and the panel is what talks to it), so
        // this reads through `isElevated()` rather than keeping a second copy
        // the shell would have to remember to update.
        //
        // NULL BEFORE THE FIRST ENTRY, when `admin` has not been imported yet:
        // the shell has never asked the server anything, so "locked" is the
        // truthful reading — and it is also the state the gate will put up.
        //
        // The accessible name changes WITH the glyph, not just the shape:
        // WCAG's non-text rules are not satisfied by a swap a screen reader
        // cannot hear.
        case ADMIN_KEY:
          return admin?.isElevated()
            ? { icon: "unlock", label: "Admin console unlocked" }
            : { icon: "lock", label: "Admin console locked" };
        // Nothing else has a state. The BIN deliberately does not: it has a
        // count, and a row has room for one badge.
        default:
          return null;
      }
    },
    isAdmin: () => identity.isAdmin,
    // The rail has just rebuilt itself; only the gallery is left to repaint.
    onSettled: () => renderGallery({ rail: false }),
    onLabelsSettled: () => relabelFolders(),
  });

  const logoutBtn = el("button", {
    class: "icon-btn",
    type: "button",
    title: "Sign out",
    "aria-label": "Sign out",
    html: svg(ICONS.logout),
  });
  logoutBtn.addEventListener("click", () => deps.onSignOut());

  // The theme toggle lives HERE, in the rail's footer, and not in the topbar.
  //
  // Theme is an app-level preference — the same category as the signed-in
  // account and signing out, which already sit in this footer. It is not a
  // property of the view you happen to be in, so it should not come and go with
  // one. It used to live in the topbar, and `.sn-root.is-reading` hides the
  // topbar outright, so the control vanished exactly when someone is staring at
  // a bright page and wants dark. The rail is rendered in both the library and
  // the reader (nothing hides it, at any viewport width), so one instance here
  // is reachable from everywhere.
  //
  // The alternative — a second toggle in the reader's own bar — was rejected:
  // two controls for one piece of state means two glyphs to keep in sync with
  // `updateThemeGlyph`, and it is the same duplication that hiding the topbar
  // was meant to remove.
  const themeBtn = el("button", {
    class: "icon-btn",
    type: "button",
    title: "Toggle theme",
    "aria-label": "Toggle light or dark",
    html: svg(ICONS.sun),
  });
  themeBtn.addEventListener("click", () => toggleTheme());

  // Storage quota bar, under the account footer. Progressive + optional: hidden
  // until `usage()` resolves; a failed/absent fetch, or a user with no quota,
  // just leaves it hidden — the rail works without it. Turns red over quota.
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
  void authApi.usage().then((u) => {
    if (!u || u.total <= 0) return;
    const pct = Math.max(0, Math.min(100, (u.used / u.total) * 100));
    quotaFill.style.width = `${pct}%`;
    quotaUsed.textContent = formatBytes(u.used);
    quotaTotal.textContent = formatBytes(u.total);
    quota.classList.toggle("is-over", u.used > u.total);
    quota.setAttribute("aria-label", `Storage used: ${formatBytes(u.used)} of ${formatBytes(u.total)}`);
    quota.hidden = false;
  });

  // The `<aside>` itself, not the entries: the brand block and the account
  // footer (identity, theme, sign out) are shell concerns, so the shell builds
  // them. `rail` above owns everything inside `nav`.
  const sidebar = el(
    "aside",
    { class: "rail" },
    el(
      "div",
      { class: "brand" },
      el("span", { text: "INKHOLD" }),
    ),
    nav,
    el(
      "div",
      { class: "account" },
      el("div", { class: "avatar", text: initials(identity.email) }),
      el(
        "div",
        { class: "account__who" },
        el("div", { class: "account__name", text: (identity.email || "").split("@")[0] || "Signed in" }),
        el("div", { class: "account__mail", text: identity.email }),
      ),
      // Grouped so the two app-level buttons read as one cluster, and so the
      // footer stays one flex row: `.account__who` is the only flexible child,
      // which is what keeps the email ellipsising instead of pushing the rail's
      // fixed 232px into overflow now that there are two buttons, not one.
      el("div", { class: "account__actions" }, themeBtn, logoutBtn),
    ),
    quota,
  );

  // --- DOM: topbar ---------------------------------------------------------
  const crumbs = el("div", { class: "crumbs", id: "crumbs" });
  const searchInput = el("input", {
    class: "search__input",
    id: "search",
    type: "search",
    autocomplete: "off",
    // The mockup's promise, now that the second half of it is real.
    placeholder: "Search across every note — typed and handwritten",
    "aria-label": "Search notes",
  });
  // THE ONE PLACE WHERE PUSH AND REPLACE MEET IN THE SAME HANDLER, and the
  // clearest illustration of the rule.
  //
  // Typing the FIRST letter is a NAVIGATION: you were in a folder and you are
  // now looking at library-wide results, which is a different place. It pushes,
  // so Back leaves the search and returns to the folder.
  //
  // Every letter AFTER that is an ADJUSTMENT of a search you are already looking
  // at, so it replaces. Without that, `w`, `wi`, `wit`, `witc` would each be a
  // rung on the history ladder and Back would spell the query backwards one
  // character at a time — the exact failure `replaceNotePosition` exists to
  // avoid for page turns.
  //
  // CLEARING THE BOX REPLACES TOO, even though it does leave the search. One
  // search episode is one history entry either way; making the exit a push
  // instead would mean type-then-clear left two entries behind, both of which
  // Back has to step through to reach the folder you never actually left.
  // ENTERING the search route is a hash navigation (`go` sets `location.hash`),
  // and a fragment that matches no element makes the browser RESET DOCUMENT FOCUS
  // to `<body>` — which drops the caret out of the box on the very FIRST
  // keystroke, so the letters after it land nowhere (or, once focus is regained,
  // at the wrong caret). Every letter after the first replaces in place and never
  // navigates, so only the arriving keystroke is affected. The caret is captured
  // here, before the navigation, and re-asserted by `showSearch` — the handler
  // the navigation dispatches, which runs AFTER the browser's focus reset. Null
  // except across that one navigation; a folder navigation never arms it.
  let pendingSearchCaret: number | null = null;
  function restoreSearchFocus(): void {
    if (pendingSearchCaret === null) return;
    const caret = pendingSearchCaret;
    pendingSearchCaret = null;
    searchInput.focus();
    const input = searchInput as HTMLInputElement;
    // A `<input type="search">` supports selection range everywhere we ship; the
    // guard is only for a DOM that does not implement it (a headless test host).
    try {
      input.setSelectionRange(caret, caret);
    } catch {
      /* selection unsupported — focus alone already keeps typing in the box */
    }
  }

  searchInput.addEventListener("input", () => {
    const next = searchInput.value;
    // A blank query is not a place — it is the folder you were standing in all
    // along, which `folderId` still holds precisely because search never moved
    // it. See `folderHref`/`searchHref`.
    const target = next.trim() === "" ? folderHref(folderId) : searchHref(next);
    if (current().name !== "search") {
      // Arriving. The route handler does the painting — but arm the focus restore
      // first (only when this is genuinely entering search, not blanking back to
      // a folder), because the hash navigation is about to blur the box.
      if (next.trim() !== "") pendingSearchCaret = (searchInput as HTMLInputElement).selectionStart ?? next.length;
      go(target);
      return;
    }
    replaceRoute(target);
    // Painted from here rather than by a re-dispatch: `replaceRoute` deliberately
    // does not fire the route, so the address bar and the gallery move together
    // without the same list being built twice per keystroke.
    applyQuery(next);
  });

  /**
   * Show `q`'s results (or, for a blank `q`, the folder behind them) WITHOUT
   * touching the URL — the caller has already put the address bar where it
   * belongs.
   *
   * Shared by the keystroke path above and the `#/search?q=` route handler, so a
   * typed query and a shared link reach the same screen through the same code.
   */
  function applyQuery(next: string): void {
    // Searching is navigation: the results belong in the gallery, which the
    // console is currently covering.
    leaveAdmin();
    query = next;
    // Two halves of ONE question, and they resolve at different speeds: names
    // are matched against the cached tree on the keystroke, transcripts are a
    // debounced round-trip. Both are library-wide, so the list can be painted
    // from the name half immediately and grown when the response lands, rather
    // than answering one query at two different scopes.
    //
    // `rail: false` is the point about not compounding the known per-keystroke
    // rebuild — the folder tree cannot change because someone typed.
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
  // The CONTROL has to agree with the state it was restored from. Without this the
  // options paint in declaration order, so the box reads "Recent" while the gallery
  // is sorted by title — the control lying about the order it is showing.
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

  // Held as variables because both are HIDDEN OVER RESULTS: sort orders a folder
  // listing and the toggle picks how to lay one out, and a query has left the
  // folder behind entirely. Leaving them on screen would offer two controls that
  // describe something the user is no longer looking at.
  const sortWrap = el("span", { class: "select" }, sortSelect, el("span", { html: svg(ICONS.chevron, 1.8) }));
  const segmented = el("div", { class: "segmented", role: "group", "aria-label": "View" }, gridBtn, listBtn);

  // --- DESTINATION MODE ---
  //
  // A destination (the bin, the admin console) is a MODE in the topbar, the same
  // way reading is: `is-reading` hides the whole library header, and
  // `is-destination` hides only the search box — which would otherwise search a
  // library the user is not looking at, and typing in it navigates away, so
  // leaving it there is the same trap the reader's header was. See 03's
  // `.sn-root.is-destination`.
  //
  // ONE CLASS FOR BOTH, not `is-bin` plus `is-admin`: the rule is not "the bin is
  // open", it is "what is on screen is not a folder listing".
  //
  // TRACKED PER DESTINATION rather than as a single boolean, because the two
  // switch it independently and their calls interleave. `renderGallery()` runs
  // on a live sync bump and calls `setBinMode(false, …)`; a single flag would let
  // a housemate's tablet finishing an upload strip the mode off the console
  // somebody is standing in, putting the search box back over it.
  const destinationsOpen = { bin: false, admin: false };
  function setDestinationMode(which: "bin" | "admin", open: boolean): void {
    destinationsOpen[which] = open;
    root.classList.toggle("is-destination", destinationsOpen.bin || destinationsOpen.admin);
  }

  /**
   * A labelled topbar action belonging to one destination — `Empty bin`,
   * `Lock console`. Glyph then words, never icon-only: a lone mark in a toolbar
   * is a guess, and neither of these is something to guess at.
   *
   * Hidden by the `hidden` attribute (see `.topbar__action[hidden]` in 03, which
   * has to restate it) so it exists only where it means something.
   */
  function topbarAction(opts: { id: string; label: string; icon: IconName; ariaLabel?: string; danger?: boolean }): HTMLButtonElement {
    const b = el("button", {
      class: `btn topbar__action${opts.danger ? " is-danger" : ""}`,
      // An id, as `#crumbs`, `#search`, `#sort` and `#gallery` already have:
      // there are two of these in `.tools` now and they are otherwise
      // distinguishable only by their label, which is the thing under test.
      id: opts.id,
      type: "button",
      hidden: true,
      // Only where the words on the button are not the whole story. When it is
      // omitted the visible label IS the accessible name, which is what WCAG's
      // Label in Name asks for — an `aria-label` that does not contain the
      // visible text makes the control unspeakable by anyone reading it aloud.
      ...(opts.ariaLabel ? { "aria-label": opts.ariaLabel } : {}),
    });
    b.append(el("span", { class: "topbar__action-mark", html: svg(ICONS[opts.icon], 1.7) }), el("span", { text: opts.label }));
    return b;
  }

  // `Empty bin` is a VIEW-LEVEL control — it acts on the whole bin rather than on
  // any row — so it sits with sort and the view toggle rather than inside the
  // content. Red at rest because it is destructive (red is danger and nothing
  // else here; green is brand and state), and DISABLED rather than removed over
  // an empty bin: the control is where the user will look for it next time, and a
  // button that vanishes teaches nothing about why. The confirm rides on
  // `bin.empty()`, which is the only way in.
  const emptyBinBtn = topbarAction({
    id: "empty-bin",
    label: "Empty bin",
    icon: "trash",
    ariaLabel: "Delete everything in the recycle bin permanently",
    danger: true,
  });
  emptyBinBtn.addEventListener("click", () => bin.empty());

  // `Lock console` is the console's equivalent, and deliberately NOT `danger`:
  // locking destroys nothing — it is the safe direction, and it is the same act
  // as the gate the admin has already passed. Red here would spend the one
  // colour this app reserves for "this destroys something" on the button that
  // undoes the risk rather than the one that takes it.
  const lockAdminBtn = topbarAction({
    id: "lock-console",
    label: "Lock console",
    icon: "lock",
    // No `aria-label`: "Lock console" already says exactly what it does, and any
    // longer name would no longer contain the words on the button.
  });
  lockAdminBtn.addEventListener("click", () => void admin?.lock());

  /** The bin's half of the mode, plus its own topbar action's state. */
  function setBinMode(open: boolean, count: number, busy = false): void {
    setDestinationMode("bin", open);
    emptyBinBtn.hidden = !open;
    // TWO REASONS FOR ONE APPEARANCE, and both are "there is nothing this click
    // can usefully do": an empty bin, and this button's own call still in
    // flight. Without the second, a slow link let `Empty bin` be pressed twice —
    // and the second call, arriving at a bin the first had already emptied,
    // reported a failure for an operation that had succeeded.
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
      // The mockup's chip, restored now that it is honest: this box really does
      // read the recognised ink. `aria-hidden` because the placeholder already
      // says so in words — a screen-reader user should not also hear a stray "OCR".
      el("span", { class: "search__ocr", "aria-hidden": "true", text: "OCR" }),
    ),
    el("div", { class: "tools" }, sortWrap, segmented, emptyBinBtn, lockAdminBtn),
  );

  // --- DOM: content (gallery + reader) -------------------------------------
  const gallery = el("section", { class: "gallery", id: "gallery", "aria-label": "Notes" });
  const content = el("div", { class: "content" }, gallery);
  const toastEl = el("div", { class: "toast", role: "status", "aria-live": "polite" });

  // The thumbnail facade the gallery paints through: it answers WHAT image a tile
  // shows (always a WebP blob — a note page, an extracted `.spd`, an image, a
  // `.txt` snippet, or a glyph), hiding cache/HTTP/render behind one call. The
  // note-page strategy reuses the exact `renderPage` pipeline the engine used to
  // inline, at the "thumb" tier.
  const thumbnails: Thumbnails = createThumbnails({
    getTheme: currentTheme,
    net: createFetchThumbNet(),
    painter: createCanvasThumbPainter(),
    renderNote: (noteId, page, theme) => renderPage({ api, renderer, cache, theme }, noteId, page, "thumb"),
    persistent: deps.persistentThumbs,
  });
  const galleryEngine: LazyEngine = createLazyEngine({
    api,
    renderer,
    cache,
    getTheme: currentTheme,
    getThumbnail: thumbnails.getThumbnail,
    root: content,
    failures,
  });

  // Native image tiles (a raw PNG/JPG shown as its own `<img>`, not through the
  // engine) are lazy-loaded by US, not by the browser's `loading="lazy"`.
  // Chromium never loads a lazy `<img>` inserted ALREADY inside the viewport
  // during an SPA re-render — no scroll follows to trip its intersection check,
  // so the tile sticks on the 3:4 fallback forever, blank. It looked
  // intermittent because the first FULL page load does trip the check; only
  // in-place hash navigations back into a folder hit it. So we ship the tile
  // with `data-src` and promote it to a real `src` the moment it nears the
  // viewport, which is reliable both in-view and on-scroll. Same `root` as the
  // engine; disconnected per repaint beside `galleryEngine.reset()`.
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

  // --- transcript search ----------------------------------------------------
  // The debounce/staleness/failure logic lives in the controller (noteSearch.ts),
  // along with the grouping and the snippet→text decode; this shell is only the
  // DOM half of it. The same `failures` sink the gallery and the reader use, so
  // an expired session mid-search reaches the composition root instead of quietly
  // rendering as "no matches".
  let searchState: SearchState = { kind: "idle" };
  const search = createNoteSearch({
    api,
    failures,
    view: {
      setState(next) {
        const prev = searchState;
        searchState = next;
        // ONLY the states that arrive from the NETWORK repaint from here.
        // `idle` and `searching` are set synchronously inside `setQuery`/`reset`,
        // whose callers already render — repainting here too would paint the
        // same list twice on every keystroke.
        if (next.kind !== "results" && next.kind !== "error") return;
        // A LATER PAGE of the same results (the "More results" control spent
        // its cursor) APPENDS instead of repainting: the rows already on
        // screen are exactly what the user is reading, and a full rebuild
        // would replay their entrance animation, reset the lazy engine's
        // observations and risk the scroll position — for a list whose shown
        // prefix did not change. The guards make "same results, grown" a fact
        // rather than a guess: same query, the previous hits a strict prefix
        // of the next (the controller builds them by appending), and the
        // painted DOM still the one this search drew.
        const painted = gallerySearch.getPainted();
        if (
          next.kind === "results" &&
          prev.kind === "results" &&
          prev.query === next.query &&
          next.hits.length > prev.hits.length &&
          painted !== null &&
          painted.query === next.query &&
          painted.countEl.isConnected
        ) {
          gallerySearch.appendSearchResults(painted);
          return;
        }
        // The results ARE the gallery now, so an arriving response repaints it
        // rather than a box beneath it. That does reset the lazy engine — but
        // the list it is repainting is precisely what changed, and every bitmap
        // already drawn is still in the render cache, so the name matches that
        // were on screen a moment ago come back off the cache, not off the wire.
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

  // The same browser-side exporter the reader uses; the library only ever asks
  // it for `documentPdf` (see `exportDocument`).
  const exporter: Exporter = createExporter({ api, renderer });

  // ONE deps object for EVERY viewer (see `pages/viewer.ts`). The reader is no
  // longer the only thing an open file can be, so its callbacks — Back, the one
  // `bin.trash` path behind Move to bin, position reporting — are shared with the
  // `.spd`/`.txt` viewers by construction. That is what stops the universal
  // actions drifting apart between viewers: they are literally the same closures.
  const viewerDeps: ViewerDeps = {
    api,
    renderer,
    cache,
    getTheme: currentTheme,
    // Back to WHERE THE NOTE WAS OPENED FROM — the bin, a search, or the folder
    // — rather than always to the root. See `readerBack` below for why this is a
    // push to a known URL and not `history.back()`.
    onBack: () => go(readerBack),
    toast,
    onSessionExpired: sessionDidExpire,
    // "Move to bin" from inside a viewer routes through the SAME `bin.trash` the
    // library card's delete uses — one trash path, so the undo toast, the U6
    // device line (`DEVICE_LINE`) and the control-plane call are shared by
    // construction rather than reinvented. Then leave the viewer exactly the way
    // Back does: the note now lives in the bin, so `readerBack` (the folder or
    // search it was opened from) is where to land, and that route's handler
    // (`enterPlace`) hides whichever viewer was up. A file is a `NoteSummary`
    // whatever its type, so `kind: "note"` is right for an image, PDF or `.spd`.
    onMoveToBin: (meta) => {
      void bin.trash({ id: meta.id, name: meta.name, kind: "note" });
      go(readerBack);
    },
    // The BIN-ORIGIN pair (Restore / Delete permanently, shown by every viewer
    // when the file was opened FROM the bin). Both route through the bin
    // controller's own by-id methods, so the toast, the purge's confirm dialog —
    // the bin's rule: no caller reaches the destructive half without it — and
    // the badge/gallery refresh (`onChanged`) are the ONE machinery the bin's
    // row actions use. Navigation waits for the outcome, unlike `onMoveToBin`'s
    // fire-and-forget: a cancelled confirm or a failed call leaves the file in
    // the bin and the viewer honestly open on it, while a success means the file
    // no longer exists in the bin context, so the viewer closes back to the bin
    // page (`readerBack` is `#/bin` for a bin origin).
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
    // Restore the version being PREVIEWED (the history banner's action). Routes
    // through the SAME `restoreVersion` the list row uses — one confirm, one
    // quota-error path, one refresh — so the two entry points cannot drift.
    onRestoreVersion: (meta, version) => void restoreVersion(meta.id, version, meta.name),
    // The reader's "Versions" control — the SAME history panel the card ⋯ menu
    // opens (`historyController.open`), never a second one. A forward reference to
    // the controller built below; only ever called on a click, long after.
    onVersions: (meta, anchor, viewingMd5) =>
      historyController.open({ id: meta.id, name: meta.name, fileType: meta.fileType }, { anchor, viewingMd5 }),
    // The viewer moved, or its find query changed. Each rewrites the hash WITHOUT
    // a history entry (see `router.ts`), so the URL keeps describing what is on
    // screen while Back stays one step out of the note. WHICH form depends on the
    // origin: a file opened FROM THE BIN gets the deep `#/bin/note/:id/page/:n`
    // (`replaceBinNotePosition`) — its blob is not at the live route; a version
    // PREVIEW gets `#/note/:id/version/:short` (`replaceNoteVersionPosition`); a
    // plain LIVE open gets the bare note URL (`replaceNotePosition`). The flags are
    // mutually exclusive — bin wins first because a trashed version preview is
    // still reached through the bin.
    onPosition: (noteId, page, q, versionMd5, bin) =>
      bin
        ? replaceBinNotePosition(noteId, page)
        : versionMd5
          ? replaceNoteVersionPosition(noteId, shortMd5(versionMd5), page)
          : replaceNotePosition(noteId, page, q),
  };

  const reader: Reader = createReader(viewerDeps);
  content.append(reader.el);
  // The type-specific viewers, mounted ONCE beside the reader — same overlay slot,
  // all hidden until `activate` shows one. Their bodies are stubs today (a
  // placeholder + the shared toolbar); the `.spd`/`.txt` viewer agents fill the
  // render at the markers inside each module.
  const spdViewer: Viewer = createSpdViewer(viewerDeps);
  content.append(spdViewer.el);
  const txtViewer: Viewer = createTxtViewer(viewerDeps);
  content.append(txtViewer.el);

  /**
   * The viewer on screen, or null. Exactly one paints at a time — {@link activate}
   * hides whichever was active before the next opens, so note → `.spd` → note
   * never stacks two overlays. Tracked here because the reader is no longer the
   * only viewer, and the old route-away `reader.close()` only knew how to hide it.
   */
  let activeViewer: Viewer | null = null;

  /**
   * Which viewer opens a file, by its server-verified `fileType`. The DEFAULT is
   * the reader — `.note`, images and every unrecognised kind still go there,
   * exactly as before; only the types with a dedicated module branch off. A new
   * viewer adds a `case` at its marker and is mounted beside the reader above.
   */
  function viewerFor(fileType: string): Viewer {
    switch ((fileType || "").toLowerCase()) {
      // --- SPD VIEWER: the .spd viewer agent fills spdViewer.ts; this seam is live ---
      case "spd":
        return spdViewer;
      // --- TXT VIEWER: the .txt viewer agent fills txtViewer.ts; this seam is live ---
      case "txt":
        return txtViewer;
      default:
        return reader; // note, image, and every other kind
    }
  }

  /** Make `v` the visible viewer, hiding the one it replaces. `v.open()` shows
   *  `v.el` itself; this only guarantees the PRIOR viewer has left the layer. */
  function activate(v: Viewer): void {
    if (activeViewer && activeViewer !== v) activeViewer.hide();
    activeViewer = v;
  }

  /** Route away from every viewer: hide whatever is active. Replaces the old
   *  `reader.close()`, which could only hide the reader — a `.spd`/`.txt` viewer
   *  left up would otherwise paint under the folder gallery. */
  function hideActiveViewer(): void {
    // Leaving a viewer also leaves any version-preview reroute — the next live
    // read must not be pinned to a retained version. Harmless when no preview is
    // active (the scope is already quiet).
    historyScope.clear();
    if (activeViewer) {
      activeViewer.hide();
      activeViewer = null;
    }
  }

  const root = el(
    "div",
    { class: "sn-root" },
    el("div", { class: "app" }, sidebar, el("main", { class: "main" }, topbar, content)),
    toastEl,
  );

  const bin: BinController = createBin({
    api,
    // The gallery's OWN engine, not a second one: the bin paints into the
    // gallery, so the scroll root is already right and `renderGallery`'s
    // `reset()` is already the teardown its canvases need.
    view: createBinView({ gallery, crumbs, sortWrap, segmented, root, engine: galleryEngine, setMode: setBinMode }),
    // A trashed file with a real viewer (`.note`, `.spd`, `.txt` — the bin's
    // `actions.open` mirrors `viewerFor`) is ROUTED, not opened directly, so
    // Back, a reload and the browser's own history all behave. It routes to the
    // deep `#/bin/note/:id` URL (NOT the live `#/note/:id`, whose blob 404s for a
    // trashed file), dispatched through `openBinNote` — which builds the `"bin"`
    // origin (`readerReturn`) that makes the viewer's Back say "Recycle bin" and
    // swaps its file actions to Restore / Delete permanently. That URL then tracks
    // the page, so a reload / copy-link reopens the SAME trashed file at the same
    // place instead of falling back to the library.
    onOpen: (entry) => go(binNotePageHref(entry.id)),
    onChanged: (mutated) => {
      // The badge is a function of the bin listing, so it moves on every
      // refresh; the FOLDER behind the bin only changes when something was
      // actually trashed or restored, and refetching it on the boot-time
      // listing would duplicate the request the first route dispatch has just
      // made.
      rail.build();
      if (mutated) void refetch(folderId, cachedListings.get(key(folderId)));
    },
    handled,
  });
  // The reader can only ask for bin-scoped bytes once there is a bin to ask.
  binScope.attach((id) => bin.isTrashed(id));

  // --- the three extracted features (Review-2 Pass-2 #3) -------------------
  //
  // The controller keeps owning lifecycle and state; these own rendering/logic.
  // Each is handed an explicit context — everything it touches arrives as an
  // argument (or an imported pure helper), so there is no hidden coupling back
  // into this closure. Built HERE, once every dependency exists (the bin, the
  // exporter, the search controller); the functions they return are only ever
  // CALLED at runtime (a route dispatch, a search response), long after this.
  //
  // Order matters: the card factory's overflow menu comes from `cardActions`,
  // and the search renderer's rows come from the card factory.
  // The "history of this file" list, launched from a note card's ⋯ menu. Built
  // before `cardActions` (whose menu triggers it) and handed the two things it
  // does not own: how to PREVIEW a version (the shell activates the reader with
  // the history reroute armed) and how to RESTORE one (the shared confirm+refresh
  // path). Both are hoisted function declarations below.
  const historyController = createHistoryController({
    api,
    host: root,
    toast,
    handled,
    openPreview: (noteId, version) => void openHistoryPreview(noteId, version),
    restore: (noteId, version, noteName) => restoreVersion(noteId, version, noteName),
  });
  /**
   * Rename a live file or folder (docs/scratch/rename.md). Opens the dialog
   * prefilled from the entry's name + type; the dialog owns the field, the
   * keyboard flow and the collision loop, and calls back here to do the write.
   *
   * On success the visible listing is updated OPTIMISTICALLY — `entry` is the same
   * object the card was built from and the same one the cached listing holds, so
   * one field write plus a repaint is the whole update; the SSE `syncVersion` bump
   * reconciles the rest. A clash (409 → `NameTakenError`) is rethrown so the dialog
   * stays open with the collision line; every other failure routes through the
   * shell's failure sink exactly as the other card actions do.
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
    // The rail is the ONE owner of "which folder IS a category" (resolved by
    // identity, so a user's own folder merely named `Note` is not caught). A note
    // is never a category root; only the six pinned category anchors are.
    isCategoryRoot: (entry) => entry.kind === "folder" && rail.categoryIconFor(entry) !== null,
    onHistory: (noteSummary, anchor) =>
      historyController.open(
        { id: noteSummary.id, name: noteSummary.name, fileType: noteSummary.fileType },
        { anchor },
      ),
  });
  const galleryCards: GalleryCards = createGalleryCards({
    galleryEngine,
    imgLazy,
    getView: () => view,
    getSearchState: () => searchState,
    labelFor: (folder) => rail.labelFor(folder),
    categoryIconFor: (folder) => rail.categoryIconFor(folder),
    pendingCategoryOf: (folder) => rail.pendingCategoryOf(folder),
    // The SAME path the rail's unresolved row takes, so a category with no folder
    // yet lands in one state whichever surface selected it. `selectCategory` also
    // fires the rail's own `onSelectCategory` (→ `enterPendingCategory`), so this
    // must not call that as well.
    onSelectCategory: (cat) => rail.selectCategory(cat),
    scheduleSpan,
    cardMenu: cardActions.cardMenu,
  });
  const gallerySearch: GallerySearch = createGallerySearch({
    gallery,
    galleryEngine,
    getSearchState: () => searchState,
    loadMore: () => search.loadMore(),
    cachedListings,
    // The rail owns "has the tree walk landed" (`treeWalked`), and the name half
    // of a query is a function of exactly that walk — so the search renderer
    // asks the same authority the gallery's pending-category branch does rather
    // than keeping a second copy of the flag.
    treeLoaded: () => rail.loaded(),
    labelFor: (folder) => rail.labelFor(folder),
    resultCard: galleryCards.resultCard,
    emptyState,
  });

  // set the initial theme glyph
  updateThemeGlyph();

  // --- rendering -----------------------------------------------------------
  /**
   * The walk currently running, or null. ONE AT A TIME, and that is the whole of
   * the fix for the stacking: `onBump` fires a forced walk per sync-version bump,
   * and a tablet uploading a folder of notes bumps repeatedly, so a full
   * N-round-trip BFS used to be started on top of each still-running one — every
   * one of them contending for the browser's ~6 connections with the listing and
   * the thumbnails the user is actually looking at, and every one of them ending
   * in a repaint.
   */
  let treeWalk: Promise<void> | null = null;
  /**
   * A forced walk was asked for WHILE one was running, so exactly one more runs
   * when this one finishes. This is the coalescing half: a burst of ten bumps
   * costs two walks, not ten, and the last one still sees the settled tree —
   * which is what the bump was asking about. A boolean rather than a counter,
   * because "walk it again" does not get truer by being asked twice.
   */
  let walkAgain = false;
  /**
   * Bumped per walk. The in-flight guard above is what keeps two walks from
   * existing, and this is what keeps that from being merely incidental: a walk
   * that is no longer the current one WRITES NOTHING. Without it, a slower
   * earlier walk finishing last would overwrite a newer walk's tree entry by
   * entry — `cachedListings.set` and `rootFolders` were both unconditional — and
   * the tree the rail, the crumbs and name-search read would be a blend of two.
   */
  let treeGen = 0;
  /**
   * A signature of the tree the LAST completed walk left behind, or null before
   * the first one. What `rail.treeWalked(changed)` is answered from — see
   * `treeSignature`. Null is deliberately not "" : the first walk must always
   * repaint, including over a household whose tree is genuinely empty, because
   * `rail.loaded()` flips with it and that is what turns a category's "Loading…"
   * into "Export is empty".
   */
  let treeSig: string | null = null;

  /**
   * Everything a repaint would be FOR, as one string: which folders exist, where,
   * what they hold and what they are called. The rail's rows and counts, the root
   * gallery's flattening, the crumb labels and name-search all read exactly this
   * and nothing else, so two walks with the same signature owe the gallery
   * nothing. Cheap because the tree is household-sized by construction — the same
   * assumption the sequential BFS above already rests on.
   *
   * The same reading `freshness.ts` takes of a single listing, one level up.
   */
  function treeSignature(): string {
    const parts: string[] = [];
    for (const k of [...cachedListings.keys()].sort()) {
      parts.push(k);
      for (const e of cachedListings.get(k)!.entries) {
        // `itemCount` for a folder and `updatedAt` for a note are the two things
        // besides existence and name that anything downstream renders.
        parts.push(`${e.kind}${e.id}${e.name}${e.kind === "folder" ? e.itemCount : e.updatedAt}`);
      }
    }
    return parts.join("\u0000");
  }

  /**
   * Populate `cachedListings` for the whole (small, household-sized) tree so the
   * rail can resolve category paths and render nested subfolders, and so the root
   * gallery can flatten the containers away — both are then pure functions of the
   * cache. BFS, sequential; `force` re-lists already-cached folders (used when a
   * sync bump lands).
   *
   * THE SEQUENTIAL BFS STAYS SEQUENTIAL. It is N round-trips before the rail's
   * resolution, the crumb labels and name-search are correct, and parallelising
   * it is not a change to make here: the server serialises every connection on
   * one coarse `db_lock`, so a fan-out would queue on a mutex while spending the
   * browser's ~6 connections that the gallery's own reads need.
   *
   * This wrapper is the GUARDING half — one walk at a time, coalesced, generation-
   * checked — and `walkTree` below is the walk.
   */
  function prefetchTree(force = false): Promise<void> {
    if (treeWalk) {
      // Join the walk already running rather than starting a second. A FORCED
      // caller cannot be satisfied by it — the running walk may already have
      // passed the folder whose change prompted the bump — so it books the one
      // follow-up `walkAgain` allows.
      if (force) walkAgain = true;
      return treeWalk;
    }
    const run = walkTree(force).finally(() => {
      treeWalk = null;
      if (!walkAgain) return;
      walkAgain = false;
      void prefetchTree(true);
    });
    treeWalk = run;
    return run;
  }

  async function walkTree(force: boolean): Promise<void> {
    const mine = ++treeGen;
    const queue: (Id | null)[] = [null];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const id = queue.shift()!;
      if (seen.has(key(id))) continue;
      seen.add(key(id));
      let l = cachedListings.get(key(id));
      if (!l || force) {
        try {
          l = await api.listFolder(id);
        } catch (e) {
          // An expired session fails every remaining hop identically — stop the
          // walk and let the shell re-authenticate instead of grinding through
          // the tree. Any other failure just skips this folder, as before.
          if (handled(e)) return;
          continue;
        }
        if (mine !== treeGen) return; // superseded — this walk's tree is nobody's
        cachedListings.set(key(id), l);
        if (id === null) rootFolders = l.entries.filter((e): e is Folder => e.kind === "folder");
      }
      for (const e of l.entries) if (e.kind === "folder") queue.push(e.id);
    }
    if (mine !== treeGen) return;
    const sig = treeSignature();
    const changed = treeSig === null || sig !== treeSig;
    treeSig = sig;
    // Drops `aria-busy`, rebuilds, and settles a category that was selected
    // while still unresolved — see `rail.ts`. `changed` is what keeps a walk
    // that found nothing new from costing a full gallery repaint.
    rail.treeWalked(changed);
  }

  function buildCrumbs(): void {
    const parts: (Node | string)[] = [];
    const home = el("button", { type: "button", text: "Library" });
    home.addEventListener("click", () => go(folderHref(null)));
    if (query.trim()) {
      // JUST "Search", with no folder ahead of it. `Note / Search` would claim a
      // scope the search does not have: results span the whole library, so
      // naming the folder you happened to be standing in when you typed is a lie
      // about what is on screen. Nothing is stranded by dropping the path — every
      // rail click clears the query and puts the folder crumb straight back.
      crumbs.replaceChildren(el("span", { class: "crumbs__here", text: "Search" }));
      return;
    }
    const pending = rail.pending();
    if (pending) {
      // The category has no folder, but it IS where the user is. Saying
      // "Library" here would contradict the highlighted rail row.
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
        // `rail.labelFor`, not `folder.name`: a category anchor is called by its
        // category label everywhere, so the crumb cannot read `EXPORT` while the
        // rail two inches away reads `Export`.
        const label = rail.labelFor(folder);
        if (i === trail.length - 1) {
          // The LAST crumb is where you already are — plain text, not a link.
          parts.push(el("span", { class: "crumbs__here", text: label }));
        } else {
          // Every ANCESTOR in between is clickable now — jump straight to it, the
          // same as "Library" (the root ancestor) already does.
          const crumb = el("button", { type: "button", text: label });
          crumb.addEventListener("click", () => go(folderHref(folder.id)));
          parts.push(crumb);
        }
      });
    }
    crumbs.replaceChildren(...parts);
  }

  /**
   * The NARROW repaint the tree walk owes a folder listing — see
   * `RailDeps.onLabelsSettled`.
   *
   * The crumb trail and the folder cards are the only two things in a folder
   * gallery whose text is a function of the walk (`rail.labelFor`,
   * `rail.categoryIconFor`), and they are rebuilt HERE rather than by calling
   * `renderGallery`, deliberately: the full repaint drops every note card,
   * resets the shared render engine and re-observes every lazy image, throwing
   * away work that has nothing to do with what changed. It is the same churn
   * `settle`'s `changed` gate is there to stop; adding a second source of it to
   * fix a label would be a poor trade.
   *
   * Folder cards precede note cards in the gallery (see `renderGallery`), so the
   * two lists line up positionally; a length mismatch means the DOM is not this
   * listing's and nothing is touched.
   */
  function relabelFolders(): void {
    // The same one question the folder fetch's own late answers ask — the crumb
    // and the cards belong to the bin or the console while either is up.
    if (!galleryIsOnScreen()) return;
    // The crumb is the visible half on a deep link — "Library / EXPORT" until the
    // walk resolves the anchor. It is cheap and unconditional.
    buildCrumbs();
    if (query.trim() !== "" || !listing) return;
    const folders = visibleEntries().filter((e): e is Folder => e.kind === "folder");
    if (folders.length === 0) return;
    const cards = gallery.querySelectorAll<HTMLElement>(".card--folder");
    if (cards.length !== folders.length) return;

    // ONLY THE CARDS WHOSE RENDERING ACTUALLY MOVED. Replacing all of them
    // unconditionally is not merely wasteful: a replaced node is DETACHED, so a
    // card the user is hovering, has tabbed to, or is in the middle of clicking
    // is pulled out from under them — and `settle()` runs on every completed
    // walk, i.e. on every sync bump from the device, not just the first. The two
    // things this pass can change are the label (`EXPORT` → `Export`) and whether
    // the card is a category, so comparing those two is the whole test.
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
    // A category card is a different height from a plain folder chip.
    scheduleSpan();
  }

  function visibleEntries(): Entry[] {
    if (!listing) return [];
    // The root is the one listing this app rewrites: containers out, their
    // meaningful children in. Everywhere else shows exactly what the server said.
    // NO QUERY FILTER HERE ANY MORE. A query does not narrow the folder you are
    // standing in — it replaces the gallery with library-wide results (see
    // `renderSearch`), because filtering names to this folder while transcripts
    // searched everything answered one question at two scopes, with nothing on
    // screen to say which.
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
    /**
     * Rebuild the folder rail too. Default true. Set false on the search-typing
     * path: the rail is a pure function of the cached tree, which cannot change
     * because someone typed a letter, and rebuilding it per keystroke is the
     * known inefficiency this change was told not to compound.
     */
    rail?: boolean;
  }

  // --- masonry spans + tile aspect ----------------------------------------
  //
  // The icon gallery is CSS-grid row-span masonry (04-library-gallery.css has
  // the geometry): uniform `--tile-w-icon` columns over a small fixed row unit,
  // each card spanning the rows its own height needs. The HEIGHT is decided by
  // CSS alone — the tile's pre-set `aspect-ratio` at the fixed column width,
  // plus the caption — so the span pass below only ever MEASURES and never
  // sizes; it is what folds the cards up under each other, and it re-runs only
  // when a height can genuinely change (a repaint, or an image's one allowed
  // aspect correction).

  /** One scheduled pass per frame, however many corrections ask for it. */
  let spanScheduled = false;
  function scheduleSpan(): void {
    if (spanScheduled) return;
    spanScheduled = true;
    requestAnimationFrame(() => {
      spanScheduled = false;
      spanTiles();
    });
  }

  // A LATE WEBFONT SWAP IS A HEIGHT CHANGE, and this masonry measures heights.
  // The captions are set in the app's own faces; until those load the browser
  // paints the fallback, and the swap re-flows every caption — so a first paint
  // that landed before the fonts did leaves every card spanning the wrong number
  // of rows, with the gaps that implies, until something else repaints. `size-
  // adjust` on the @font-face keeps the error small, which is exactly why it went
  // unnoticed rather than why it is not there. One extra pass, once per document.
  //
  // Guarded: `document.fonts` is absent in the non-browser environments the unit
  // tests construct these modules in (the same guard `thumbnails.ts` uses).
  if (typeof document !== "undefined" && document.fonts) {
    void document.fonts.ready.then(() => scheduleSpan());
  }

  /**
   * Span every gallery child over the masonry's row unit: rows needed =
   * ⌈(outer height + vertical gap) / row unit⌉, with the gap folded into the
   * span (row-gap is 0) so cards start mid-track instead of on shared lines.
   * Margins count — the section head owns real ones — and the unit/gap are read
   * off the live grid, so the CSS constants have exactly one home.
   *
   * ONLY the icon masonry spans. The list, search results and the bin are row
   * layouts; the guards mirror `renderGallery`'s own mode decision, and the
   * `grid-auto-rows` parse turns non-finite the moment `.is-bin`'s block layout
   * is standing in front of the grid anyway.
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
    // A DESTINATION OWNS THE SURFACE. While the route says the bin or the
    // console is what is on screen, an AMBIENT repaint — the boot-time tree
    // walk settling (`rail.onSettled`), a live sync bump, a late search
    // response — must not paint the folder gallery over it: that repaint is
    // the bin's documented close mechanism, and on a hard reload of `#/bin`
    // the tree prefetch used to land AFTER the bin opened and blank it (the
    // console lost its topbar the same way). Route-driven exits never trip
    // this guard, because every `show*` handler reassigns `destination`
    // BEFORE it repaints — the guard only ever reads "the address bar still
    // says a destination", which is exactly when the gallery is not the view.
    if (destination !== null) return;
    if (opts.rail !== false) rail.build();
    buildCrumbs();
    const searching = query.trim() !== "";
    // Sort and the view toggle describe a folder listing; results are not one.
    sortWrap.hidden = searching;
    segmented.hidden = searching;
    // Leaving the bin is this repaint, and nothing else — the same overwrite
    // that closes it turns its mode off. That is the teardown hook bin.ts is
    // built around; it just has to be one line, here, rather than nowhere.
    setBinMode(false, 0);
    // Results are always a list: a row is what has room for an excerpt and a
    // strip of page chips, and a grid of covers could show neither.
    gallery.className = `gallery${searching || view === "list" ? " is-list" : ""}`;
    galleryEngine.reset();
    imgLazy?.disconnect(); // drop the previous repaint's native-image observations
    closeOpenMenu(); // a card/row menu's DOM is about to be replaced
    gallery.replaceChildren();
    // The masonry span pass, scheduled BEFORE the children are appended below:
    // the rAF fires after this whole repaint, whatever branch it takes, and
    // `spanTiles` itself knows which layouts span (only the icon masonry).
    scheduleSpan();

    if (searching) {
      const q = query.trim();
      // BELOW THE GLOBAL FLOOR: a 1–2 char library-wide query does not search —
      // it is broad-term cost and noise (`MIN_GLOBAL_QUERY_LEN`, and the backend
      // gate behind it). The results area idles with a quiet hint rather than
      // firing search-as-you-type or painting name matches for a single letter.
      // (In-doc find, inside a viewer, is unaffected — it searches at any length.)
      if (q.length < MIN_GLOBAL_QUERY_LEN) {
        gallery.append(
          emptyState("Keep typing", `Type at least ${MIN_GLOBAL_QUERY_LEN} characters to search your library.`),
        );
        return;
      }
      gallerySearch.renderSearch(q);
      return;
    }

    // A category with no folder behind it. Which of the two things that means
    // depends entirely on whether the tree walk has finished — see
    // `RailController.loaded`.
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
      gallery.append(emptyState("This folder is empty", "Notes synced from your Supernote will appear here."));
      return;
    }

    gallery.append(el("div", { class: "section-head" }, el("span", { text: listingSummary(entries) })));

    for (const [i, entry] of entries.entries()) {
      gallery.append(entry.kind === "folder" ? galleryCards.folderCard(entry) : galleryCards.noteCard(entry, i));
    }
  }

  /** `n thing` / `n things`, with the plural only where it belongs. */
  function plural(n: number, one: string): string {
    return `${n} ${n === 1 ? one : `${one}s`}`;
  }

  /**
   * What the gallery's section head says about the listing under it.
   *
   * TWO HALVES, COUNTED SEPARATELY — "8 docs" over a folder holding a subfolder
   * and eight files is not what is on screen; a folder is not one of the docs.
   * The folder half is OMITTED when there are none, rather than reading
   * "0 folders · 8 docs", and so is the doc half (a folder of nothing but
   * subfolders says "6 folders", not "6 folders · 0 docs").
   *
   * THE VOCABULARY IS FIXED, and it dovetails with the folder rows and the rail:
   *
   *   - "items" = folders AND docs together, the total. That is what a folder row
   *     and a rail count say about what is inside a folder ("8 items").
   *   - "docs"  = any file, whatever its type — note, image, PDF, `.spd`.
   *
   * So `8 items` on a row and `1 folder · 7 docs` in the head of the folder it
   * opens are the same eight things, described at two levels.
   *
   * "docs" is TYPE-NEUTRAL ON PURPOSE: nothing here branches on `fileType`, so
   * nothing here can call a screenshot a note — the defect the old blanket
   * "notes" count had, and the one `itemCount` was fixed for.
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

  // --- where the reader was opened from ------------------------------------
  /**
   * The human path of the folder a note lives in — `Note / Projects` — or null
   * when this shell cannot say.
   *
   * Answered from `cachedListings`, which `prefetchTree` fills for the WHOLE
   * (household-sized) tree, because the question is asked from a search result
   * and a `SearchHit` carries no folder: results are library-wide, so the note is
   * very often somewhere the user has never navigated. The same container
   * flattening the breadcrumb uses (`crumbPath`) is applied here, so the reader
   * says `Note` where the server said `NOTE / Note`.
   *
   * Null when the walk has not reached the folder yet (or the note is not in the
   * cache at all). The reader renders that as ABSENT rather than guessing — a
   * subtitle that invents a folder is worse than one that omits it.
   */
  function folderPathOf(noteId: Id): string | null {
    for (const cached of cachedListings.values()) {
      if (!cached.entries.some((e) => e.kind === "note" && e.id === noteId)) continue;
      // The listing's own `path` is root → here, which is the note's folder.
      const names = crumbPath(cached.path).map((f) => rail.labelFor(f));
      return names.length === 0 ? null : names.join(" / ");
    }
    return null;
  }

  /** The folder the user is STANDING IN, as a path — null at the library root. */
  /**
   * NAMES COME FROM `rail.labelFor`, never from `folder.name`. A category anchor
   * is called by its category label everywhere it appears — the rail, the
   * breadcrumb, the reader's Back button, a search result's path — because the
   * device calls it `EXPORT` and the app calls it `Export`, and the same folder
   * reading as two different places is the bug this fixes.
   */
  function currentFolderPath(): string | null {
    const pending = rail.pending();
    if (pending) return pending.label;
    if (!listing) return null;
    const names = crumbPath(listing.path).map((f) => rail.labelFor(f));
    return names.length === 0 ? null : names.join(" / ");
  }

  /**
   * What Back should say for the note about to open. The query being non-empty
   * is what makes it a search arrival — the same test the mockup uses, and the
   * one that stays true because every navigation clears the box.
   *
   * NOTE WHICH FOLDER EACH KIND CARRIES, because they are not the same folder:
   *
   *  - `folder` — Back returns to the LISTING BEHIND the reader, so the label has
   *    to name where the user is standing, not where the note lives. For a note
   *    opened from the folder it is in these coincide; for one opened by URL from
   *    the root they do not, and "Library" is the honest destination.
   *  - `search` — the subtitle wants the NOTE'S OWN folder, which is the whole
   *    point: results are library-wide, so that folder is information the user
   *    does not already have.
   */
  function readerReturn(noteId: Id): { origin: ReaderOrigin; href: string } {
    // The BIN comes first, and it is the one origin that is not about where the
    // user was standing but about what the file IS: a trashed file exists in no
    // folder and in no search, so returning to either would drop the user
    // somewhere the thing they were just looking at does not appear. The path is
    // the one it had WHEN IT WAS DELETED — the only folder it can honestly name.
    if (bin.isTrashed(noteId)) {
      // The countdown rides along so the viewer's toolbar paints the SAME
      // retention rule the bin row does — the fourth surface of the one control
      // vocabulary (see `createBinViewerActions`).
      return {
        origin: { kind: "bin", folderPath: bin.pathOf(noteId), retention: bin.retentionOf(noteId) },
        href: destinationHref(BIN_KEY),
      };
    }
    // THE SHELL'S `query`, NEVER THE ROUTE'S `?q=`. They look alike and mean
    // opposite things: the route's `q` is the FIND running inside the note (see
    // `replaceNotePosition`), which the reader itself writes there as you type.
    // Deciding the origin from it would send Back to a library-wide search for a
    // term the user only ever looked for within one notebook.
    const q = query.trim();
    if (q) return { origin: { kind: "search", folderPath: folderPathOf(noteId) }, href: searchHref(q) };
    return { origin: { kind: "folder", folderPath: currentFolderPath() }, href: folderHref(folderId) };
  }

  /**
   * Where the reader's own Back button goes — the URL of the place the note was
   * opened FROM, captured when it opened.
   *
   * IT PUSHES, and it is not `history.back()`, which is the tempting
   * simplification now that every origin has an address. Two things stop it
   * being equivalent. A note reached by a shared link or a bookmark has no app
   * entry beneath it at all, so `history.back()` would walk the user out of the
   * app entirely — the one case a reader's Back button must never do. And the
   * origin is still needed whatever Back does: it is what the button is CALLED
   * ("Recycle bin", "Projects") and what the reader's subtitle prints, and
   * history can say where you came from but not what to name it. So the origin
   * stays, and routing buys it the thing it was missing — a Back out of a note
   * opened from the bin now lands in the BIN rather than at `#/`.
   */
  let readerBack = folderHref(null);

  /**
   * Reading is a MODE: the library's topbar leaves while it is on. Toggled here
   * rather than inside the reader because the class belongs to the shell whose
   * header it hides, and both transitions already funnel through exactly two
   * places (`openNote`, and `enterPlace` for every route out of a note).
   */
  function setReading(reading: boolean): void {
    root.classList.toggle("is-reading", reading);
  }

  /**
   * Open a retained VERSION in the reused viewer, read-only preview (phase 4/5).
   *
   * ADDRESSABLE for EVERY previewable kind: the URL is canonicalised to
   * `#/note/:id/version/:short` (a REPLACE, not a push — opening a preview is
   * reading, so Back still leaves for the folder via `readerBack`), so a reload /
   * copy-link reproduces this version. The `.note` reader and the raw
   * `.spd`/`.txt`/image viewers alike get this — the raw branch below seeds the
   * SAME URL the `.note` branch does, then each viewer's own `onPosition` sync
   * refines a route that is already this one.
   *
   * For `.note`, the page-structure template is the VERSION's OWN meta
   * (`historyMeta`, H7): its real page count + dims, so a version that added/removed
   * pages previews with its own geometry rather than the live note's slots. On a
   * `historyMeta` failure we fall back to the LIVE meta as the template
   * (`versionMeta(base, md5)`) — a degraded preview beats no preview. Either way the
   * history reroute is armed on `historyScope` just before the reader's first paint
   * pulls page bytes through the wrapped api.
   */
  async function openHistoryPreview(noteId: Id, version: FileVersion, startPage = 0): Promise<void> {
    const mine = ++routeToken;
    try {
      // The live meta gives the file's id/name/type — the fallback template for a
      // `.note`, and everything the raw kinds need.
      const base = await api.getNoteMeta(noteId);
      if (mine !== routeToken) return; // navigated away while fetching
      const type = base.fileType.trim().toLowerCase();
      // A version preview of a TRASHED file is VIEW-ONLY: the banner's Restore is
      // suppressed (restore the FILE first, then a version — bin-parity.md) and the
      // raw-based viewers fetch the version's bytes off the bin-scoped history
      // route. The version LIST, Viewing/Current and click-to-preview all stay.
      const viewOnly = bin.isTrashed(noteId);
      const origin: ReaderOrigin = {
        kind: "history",
        folderPath: currentFolderPath(),
        version: { md5: version.md5, createdAt: version.createdAt },
        viewOnly,
      };

      // DISPATCH BY KIND. `.spd`/`.txt`/image render CLIENT-SIDE from the version's
      // RAW bytes (`historyFileUrl`), so they skip most of the `.note` machinery: no
      // `historyScope` reroute (that reroutes per-PAGE SNPG bytes) and no
      // `historyMeta` (a `.note`-only render index). A minimal meta carrying the
      // version md5 is all the viewer needs; it fetches the bytes itself. But the
      // preview IS addressable, exactly as `.note`: seed the canonical
      // `#/note/:id/version/:short` URL BEFORE the viewer opens (a REPLACE — Back
      // still leaves for the folder via `readerBack`) so a reload / copy-link
      // reproduces this version, and so the viewer's own `onPosition` sync (which
      // writes the `/version/:short` form) refines a route that is already this one.
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

      // `.note`: the SNPG reroute path. Prefer the version's OWN meta (its real page
      // count + dims, H7); a `historyMeta` failure falls back to the live geometry.
      let template = base;
      try {
        const vmeta = await api.historyMeta(noteId, version.md5);
        if (mine !== routeToken) return;
        template = vmeta;
      } catch {
        // A degraded preview (live geometry) beats no preview — keep `base`.
      }
      readerBack = folderHref(folderId); // Back leaves the preview for the folder
      activate(reader);
      // AFTER activate (which may hide a prior viewer), BEFORE open (whose first
      // paint reads through the wrapped api).
      historyScope.setActive(noteId, version.md5);
      // Make the preview ADDRESSABLE before the reader's own sync fires: replace
      // (not push) the current URL with the `#/note/:id/version/:short` form, so a
      // reload / copy-link reproduces this version. Opening a preview is reading,
      // not navigating — Back returns to the folder via `readerBack` — so it is a
      // replace, matching the reader's URL discipline. On a deep-link this is a
      // no-op or a canonicalisation of the prefix to its 7-char form; from the
      // panel it turns the folder URL into the version URL. It also seeds the route
      // the reader's per-page `replaceNoteVersionPosition` then refines.
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
   * Restore a version as the file's current one (phase 6) — the ONE path behind
   * both the list row's Restore and the preview banner's. Confirms with honest
   * undoable framing, then on success drops the preview reroute, refreshes the
   * folder listing + rail badges, and routes to the note so it reopens as its new
   * current version. `runRestore` owns the toast and the 507 (over-quota) message.
   */
  function restoreVersion(
    noteId: Id,
    version: { md5: string; createdAt: number },
    _noteName: string,
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
        void refetch(folderId, cachedListings.get(key(folderId)));
        rail.build();
        go(noteHref(noteId));
      },
    });
  }

  /**
   * Bumped by every route transition between the library and a note.
   *
   * `openNote` awaits `getNoteMeta`, so a route change (a Back, a rail click)
   * can land `enterPlace` in the middle of it. Without this the late response
   * would re-open the reader over a folder route AND hide the topbar — leaving a
   * shell with no header at all, which is the new and worse half of a hazard the
   * unguarded `reader.open` already had.
   */
  let routeToken = 0;

  // --- data / freshness ----------------------------------------------------
  /**
   * The rail selected a category whose folder does not exist on the device yet.
   *
   * The rail already holds WHICH category (`rail.pending()`) — there is no id to
   * list, so that flag is the whole of that state. This is the SHELL's half:
   * deliberately NOT a `navigate(null)`, because root is a real listing and would
   * show the whole library under a rail row that says "Export". No request is
   * made — there is no id to make one with, and inventing one would 404. Shares
   * `navigate`'s reader rule and query reset so the two entry points cannot
   * diverge.
   */
  /**
   * THE ONE PLACE THAT IS NOT ADDRESSABLE, and it is not addressable because it
   * has no identity to address: the category's folder does not exist on the
   * device yet, so there is no id, and any URL invented for it would name a
   * folder the server would 404. It is transient by construction — the moment
   * the device creates the folder, `settle()` turns it into an ordinary
   * `#/folder/:id` navigation.
   *
   * What it must NOT do is leave the address bar lying. The shell is standing at
   * the root here (no folder, no listing), so the URL is REPLACED with the root:
   * no history entry, because selecting an empty category is not somewhere you
   * went, and a reload lands on the library instead of on the folder you were in
   * three clicks ago. `replaceRoute` rather than `redirect` precisely so the
   * pending state survives — a re-dispatch would clear it.
   */
  function enterPendingCategory(): void {
    hideActiveViewer();
    setReading(false);
    leaveAdmin();
    destination = null;
    folderId = null;
    listing = undefined;
    query = "";
    searchInput.value = "";
    search.reset();
    replaceRoute(folderHref(null));
    renderGallery();
  }

  // --- the delayed loading paint -------------------------------------------
  //
  // LOADING AND KNOWN-EMPTY ARE DIFFERENT STATES, and so are LOADING and
  // "still showing the last folder". A cache miss used to paint nothing at all:
  // on a cold boot the shell mounted with an empty gallery for a whole round
  // trip, and on a folder-to-folder move the previous folder stayed fully on
  // screen under the new chrome. `renderGallery()` already knows what to say
  // (`!listing` → "Loading…"); it was simply never called.
  //
  // But a loading state that paints INSTANTLY is its own defect: on a warm link
  // every navigation would flash "Loading…" for 40 ms between two good paints,
  // which reads as a flicker rather than as progress. So the paint is DELAYED —
  // a fast response wins the race and the user sees no loading state at all, a
  // slow one is admitted well before the request completes.

  /**
   * How long a folder listing may be outstanding before the gallery says so.
   *
   * Chosen as the usual "this is no longer instantaneous" threshold: below it a
   * response feels like a direct result of the click and any interstitial reads
   * as a flash; above it a blank region is indistinguishable from a freeze.
   */
  const LOADING_PAINT_DELAY_MS = 150;

  /** The armed delayed paint, or undefined. At most one — a navigation cancels
   *  the previous one before arming its own. */
  let loadingPaintTimer: ReturnType<typeof setTimeout> | undefined;

  /** Disarm the delayed paint: the listing landed, or we left before it could. */
  function cancelLoadingPaint(): void {
    if (loadingPaintTimer === undefined) return;
    clearTimeout(loadingPaintTimer);
    loadingPaintTimer = undefined;
  }

  /**
   * Arm the "Loading…" paint for the folder `id`, {@link LOADING_PAINT_DELAY_MS}
   * from now.
   *
   * IT CAN ONLY EVER PAINT THE PLACE IT WAS ARMED FOR. The user can navigate,
   * search or open the bin inside the delay, and every one of those makes this
   * paint wrong — so the timer re-reads the same route state `renderGallery`
   * itself reads (`folderId`, `query`, `destination`) and drops itself if any of
   * them has moved. `destroy()` clears it too, so a torn-down shell leaves
   * nothing scheduled to paint into DOM on its way out.
   */
  function scheduleLoadingPaint(id: Id | null): void {
    cancelLoadingPaint();
    loadingPaintTimer = setTimeout(() => {
      loadingPaintTimer = undefined;
      if (folderId !== id || destination !== null || query.trim() !== "") return;
      if (listing !== undefined) return; // a listing arrived by another path
      // The tree walk may have reached this folder while we waited — its listing
      // is the same listing, so paint it rather than a loading state we no
      // longer need.
      const cached = cachedListings.get(key(id));
      if (cached) listing = cached;
      renderGallery();
    }, LOADING_PAINT_DELAY_MS);
  }

  /**
   * The `#/folder/:id` route's body (and `#/`'s, with `null`).
   *
   * LANDING ON A CONTAINER is now genuinely reachable from a URL — `#/folder/
   * dir-note` is a link somebody can bookmark — where it used to be only the
   * transient container card the root renders before `prefetchTree` has walked
   * it. It is still RENDERED NORMALLY rather than redirected: `NOTE` really does
   * hold `Note` and `MyStyle`, so listing them is a truthful, reachable view, and
   * `crumbPath` keeps the container's name in the breadcrumb while you are
   * standing in it.
   *
   * A DEEP LINK CAN ARRIVE BEFORE THE TREE WALK, and nothing here waits for it:
   * the listing is one request that does not depend on the walk, so the gallery
   * and the breadcrumb are right immediately. What is provisional is the RAIL —
   * which category a folder belongs under is `resolveCategory`'s answer, and
   * that needs the walk — so until it lands the rail simply highlights nothing.
   * `rail.treeWalked()` rebuilds it when it does. That is the same waiting
   * mechanism `pendingCategory` uses and deliberately not a second one.
   */
  async function navigate(id: Id | null): Promise<void> {
    // `navigate` is fire-and-forget (`void navigate(id)`), so two can overlap: a
    // slow folder still awaiting its listing when the user clicks another. The
    // route token is what makes the TRAILING cancel below belong to this call
    // only — without it, the slow one resolving last would disarm the newer
    // navigation's loading paint and restore the blank window it exists to fill.
    const mine = routeToken;
    cancelLoadingPaint();
    rail.clearPending();
    folderId = id;
    query = "";
    searchInput.value = "";
    // Clearing the box has to clear BOTH halves of the query. Without this the
    // previous folder's transcript hits would sit under the new folder's
    // gallery, still linking somewhere else entirely.
    search.reset();
    const cached = cachedListings.get(key(id));
    if (cached) {
      listing = cached;
      renderGallery(); // stale-while-revalidate: paint immediately
    } else {
      // CACHE MISS — nothing truthful to paint yet. `listing` is dropped
      // IMMEDIATELY (not after the delay) because it now describes a folder we
      // are no longer in: any repaint triggered meanwhile — the sort select, the
      // view toggle, `rail.onSettled` — would otherwise run `visibleEntries()`
      // with `folderId` = B and `listing` = A, and at the root would apply the
      // root flattening to a non-root listing. The PAINT is what waits; see
      // `scheduleLoadingPaint`.
      listing = undefined;
      scheduleLoadingPaint(id);
    }
    await refetch(id, cached);
    if (mine === routeToken) cancelLoadingPaint();
  }

  /**
   * A folder route named a folder that is not there — deleted from the device,
   * trashed, or a link that has outlived its subtree.
   *
   * TWO SIGNALS, because the two backends answer differently and both readings
   * are honest: the real control plane 404s, and a listing that comes back with
   * an EMPTY `path` for a non-null id is a server saying "these are the ancestors
   * of nothing". Either way this is a `redirect`, not a `go`: the missing folder
   * was never a place, so it must not become a history entry that Back can climb
   * onto and be bounced off again. The toast is what keeps it from being a
   * silent teleport to the root.
   */
  function missingFolder(): void {
    toast("That folder isn't there any more.");
    redirect(folderHref(null));
  }

  /**
   * Is the folder gallery still the surface on screen?
   *
   * ONE QUESTION, ONE PLACE. `renderGallery` refuses to paint while the route
   * says a destination is open, and `refetch`'s success path additionally
   * refuses while the bin's node is mounted — but the FAILURE path used to
   * `replaceChildren` the gallery element directly, around both, and the
   * missing-folder redirect fired regardless. So a folder you gave up on could
   * land its failure minutes later and replace an open recycle bin with
   * "Couldn't load", or bounce you out of it to the root, while the URL, the
   * rail highlight and the `Empty bin` button all still said Recycle bin.
   *
   * A late answer about a place the user has left is DROPPED, not painted: they
   * have moved on, and there is nothing here they asked to be told.
   */
  function galleryIsOnScreen(): boolean {
    return destination === null && !bin.isOpen();
  }

  async function refetch(id: Id | null, prev: Listing | undefined): Promise<void> {
    let fresh: Listing;
    try {
      fresh = await api.listFolder(id);
    } catch (e) {
      // A dead session isn't a "couldn't load this folder" — don't paint the
      // retry empty-state over a shell that's about to be torn down.
      if (handled(e)) return;
      if (id !== folderId) return; // navigated away while failing
      // …nor over a destination the user opened while this was in flight.
      if (!galleryIsOnScreen()) return;
      // GONE is not UNREACHABLE. A 404 is the server answering, so retrying will
      // never help and "check your connection" would be a lie; anything else
      // (a network drop, a 500) keeps the retry state it always had.
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
    // The other half of the missing-folder signal — see `missingFolder`. The
    // root legitimately has an empty path, so this asks only about a real id.
    if (id !== null && fresh.path.length === 0) {
      // The same guard as the failure path: a redirect is a navigation, and
      // yanking someone out of the bin they are standing in is worse than
      // leaving a folder id nobody is looking at uncorrected.
      if (galleryIsOnScreen()) missingFolder();
      return;
    }
    knownSyncVersion = Math.max(knownSyncVersion, fresh.syncVersion);
    if (id === null) rootFolders = fresh.entries.filter((e): e is Folder => e.kind === "folder");

    const result = reconcile(prev, fresh);
    cachedListings.set(key(id), result.listing);
    if (result.changed || listing !== result.listing) {
      listing = result.listing;
      // NOT while the bin is on screen. A restore mutates the folder BEHIND the
      // bin and asks for exactly this refetch, so repainting here would overwrite
      // the bin — with its own action's result — and drop it back to a folder the
      // user never navigated to. `listing` is updated either way, so the folder is
      // correct the moment the bin is closed by something that meant to close it.
      if (!bin.isOpen()) renderGallery();
    }
  }

  /** A live sync-version bump: revalidate the folder we're looking at if stale. */
  function onBump(version: number): void {
    knownSyncVersion = Math.max(knownSyncVersion, version);
    if (classify(cachedListings.get(key(folderId)), knownSyncVersion) === "stale") {
      void refetch(folderId, cachedListings.get(key(folderId)));
      // Refresh the rail's category counts/subfolders across the whole tree.
      void prefetchTree(true);
    }
  }
  const unsubscribe = live.subscribe(onBump);

  // --- view / theme --------------------------------------------------------
  function setView(next: View): void {
    view = next;
    gridBtn.setAttribute("aria-pressed", String(next === "grid"));
    listBtn.setAttribute("aria-pressed", String(next === "list"));
    renderGallery();
  }

  function updateThemeGlyph(): void {
    themeBtn.innerHTML = svg(currentTheme() === "dark" ? ICONS.moon : ICONS.sun);
  }

  /** Repaint for a theme change: drop the now-off-theme bitmaps, then repaint only
   * what's on screen; the rest re-lazy on next scroll (keyed by theme, so nothing
   * is lost). */
  function repaintForTheme(previous: Theme): void {
    void cache.evictTheme?.(previous);
    // The facade caches WebP blobs per theme too; drop the off-theme ones so a
    // toggle does not leave both worlds resident.
    thumbnails.evictTheme(previous);
    updateThemeGlyph();
    galleryEngine.bumpTheme();
    reader.bumpTheme();
  }

  function toggleTheme(): void {
    const previous = currentTheme();
    const next: Theme = previous === "dark" ? "light" : "dark";
    // Pins the attribute AND persists it, so the choice survives a reload.
    setTheme(next);
    repaintForTheme(previous);
  }

  // Follow the OS theme, live, while the user hasn't pinned one. A pinned choice
  // sets `data-theme`, which both wins in CSS and short-circuits this.
  // Handlers are hoisted to named consts (and the MediaQueryList kept) so
  // `destroy()` can remove them — otherwise they leak across sign-out/in.
  const osThemeQuery = window.matchMedia?.("(prefers-color-scheme: dark)");
  const onOsThemeChange = (e: MediaQueryListEvent): void => {
    if (document.documentElement.getAttribute("data-theme")) return;
    // We are moving *to* the OS's new theme, so the theme being left is its inverse.
    repaintForTheme(e.matches ? "light" : "dark");
  };
  osThemeQuery?.addEventListener("change", onOsThemeChange);

  // Repaint on-screen tiles after a resize (debounced).
  let resizeTimer: ReturnType<typeof setTimeout> | undefined;
  const onWindowResize = (): void => {
    if (resizeTimer !== undefined) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      galleryEngine.repaintVisible();
      reader.bumpTheme();
    }, 150);
  };
  window.addEventListener("resize", onWindowResize);

  /**
   * The shell-level reset EVERY route into a place performs, before that place's
   * own work.
   *
   * One function rather than four copies because the copies drifted: the bin's
   * arm and the console's arm each had their own transcription of it, and a
   * destination added in a hurry would have got a third. The reader is closed
   * DIRECTLY here — not by routing away, which is what the old `navigate` had to
   * do — because we are already inside the route handler that replaced it.
   */
  function enterPlace(): void {
    routeToken++;
    hideActiveViewer();
    setReading(false);
    rail.clearPending();
  }

  // Fill the tree so the category rail resolves. THE FIRST LISTING IS NOT KICKED
  // OFF HERE any more: main.ts dispatches the route immediately after building
  // this shell, and that dispatch is what lists a folder. A `navigate(null)` here
  // would race it — booting on `#/folder/projects` would fetch the root, throw
  // the answer away, and fetch again.
  void prefetchTree();

  return {
    el: root,

    showFolder(id: Id | null): void {
      enterPlace();
      leaveAdmin();
      destination = null;
      void navigate(id);
      // Ensure on-screen thumbnails are painted for the current theme.
      requestAnimationFrame(() => galleryEngine.repaintVisible());
    },

    showSearch(q: string): void {
      // `#/search` with nothing in it is not a place — see `searchHref`. A
      // hand-typed or truncated one is CORRECTED rather than rendered, so the
      // address bar never describes a screen the app does not have.
      if (q.trim() === "") {
        redirect(folderHref(folderId));
        return;
      }
      enterPlace();
      destination = null;
      // The box has to agree with the URL: on a reload or a shared link nobody
      // typed this, and a results list above an empty search field is the
      // control lying about what produced it.
      if (searchInput.value !== q) searchInput.value = q;
      applyQuery(q);
      // Re-assert focus + caret after the arriving-keystroke navigation (which
      // the browser blurred). A no-op on a reload / shared link, where nothing
      // armed it — those must not steal focus from wherever the user is.
      restoreSearchFocus();
    },

    showDestination(key: string): void {
      enterPlace();
      query = "";
      searchInput.value = "";
      search.reset();
      // Assigned PER ARM below rather than up front: the admin arm has to close
      // a still-mounted bin by repainting the gallery over it, and
      // `renderGallery` refuses to paint over whatever destination this
      // variable names — so it must not name one until the old surface is gone.
      // Cleared first because arriving here IS the navigation away from
      // whichever destination was open.
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
          // The bin has no `close()` — it closes by the gallery being repainted
          // over it (see bin.ts). Merely hiding the gallery would leave it
          // MOUNTED, so the console would be sitting on top of it. Repainting
          // first both unmounts it and restores the folder the admin will land
          // back on — and it runs while `destination` is still null, which is
          // what lets it through the guard at the top of `renderGallery`.
          if (bin.isOpen()) renderGallery({ rail: false });
          destination = key;
          openAdmin();
          return;
        default:
          // Unreachable through the router, which only mints a key it read out
          // of `DESTINATIONS`. Kept honest anyway: a destination removed from
          // that list while a tab still holds its URL must land somewhere real.
          redirect(folderHref(folderId));
          return;
      }
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
        // "That note couldn't be opened" would be a lie for a dead session, and
        // bouncing to the library would just freeze there instead.
        if (handled(e)) return;
        toast("That note couldn't be opened.");
        // A `redirect`, not a `go`: a link to a note that is gone (or to a
        // trashed one this session has not listed the bin for) never named a
        // place, so it must not leave a rung Back can climb onto and be bounced
        // off again. Same reasoning as `missingFolder`.
        redirect(folderHref(folderId));
      }
    },

    async openNoteVersion(id: Id, short: string, page = 0): Promise<void> {
      const mine = ++routeToken;
      // Client-side resolution against the SAME list the panel fetches — no
      // backend prefix-match route. On a fetch failure that is not a dead session,
      // degrade to the live note (its own open handles a missing note honestly).
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
        // A retained version → the read-only preview, at the requested page.
        // `openHistoryPreview` canonicalises the URL to the 7-char `:short` form.
        await openHistoryPreview(id, match.version, page);
        return;
      }
      // CURRENT or NONE both land on the live note with the URL canonicalised to
      // the bare `#/note/:id/page/:n` — `redirect` REPLACES (no history rung) and
      // re-dispatches through the router's `note` arm, so `openNote` opens it and
      // there is one canonical address. The current branch must NOT 404 (a restore
      // can make a past version's md5 the live one); the none branch is the
      // hot-cache age-out, softened by a notice rather than a hard error.
      if (match.kind === "none") toast("That version is no longer available.");
      redirect(notePageHref(id, page));
    },

    async openBinNote(id: Id, page = 0): Promise<void> {
      const mine = ++routeToken;
      // A bin open is never a version preview: drop any lingering history reroute
      // so the trashed file reads its own (current) blob, not one left armed.
      historyScope.clear();
      // The listing has to be in hand before we can find the entry or build its
      // origin — on a COLD `#/bin/note/:id` load this awaits the boot-time fetch
      // (or one retry), the friction the recycle-bin deep link uniquely carries.
      try {
        await bin.ensureLoaded();
      } catch (e) {
        if (mine !== routeToken) return;
        if (handled(e)) return;
        // The listing itself could not be fetched — send them to the bin, which
        // will surface its own load error rather than a dead viewer.
        redirect(destinationHref(BIN_KEY));
        return;
      }
      if (mine !== routeToken) return; // routed away while the listing loaded
      // NOT (or no longer) in the bin: purged / restored since the link was made,
      // or simply never trashed. Fall back to the LISTING plus a notice — the
      // recycle-bin analog of the version-preview age-out. `redirect` REPLACES (no
      // history rung) and re-dispatches through the `destination` arm, which paints
      // the bin.
      if (!bin.isTrashed(id)) {
        toast("That file is no longer in the recycle bin.");
        redirect(destinationHref(BIN_KEY));
        return;
      }
      try {
        // `readerReturn` reads the bin origin (path + retention countdown) and the
        // `#/bin` Back href off the now-loaded listing — the SAME origin a row
        // click produces. `getNoteMeta` reroutes to the bin-scoped meta route
        // (`binScope`, keyed on `isTrashed`), so a trashed file's meta resolves.
        const { origin, href } = readerReturn(id);
        const meta = await api.getNoteMeta(id);
        if (mine !== routeToken) return; // routed away while fetching
        readerBack = href;
        // DISPATCH by kind exactly as a live open does — `.spd`/`.txt` to their own
        // viewers, every other kind (`.note`, images) to the reader — each opened
        // with the `bin` origin, whose per-position sync writes the bin URL.
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
      // Shell-level window listeners registered at build time. Without these
      // removals they accumulate one set per sign-out/in cycle, each holding
      // the whole torn-down shell alive.
      osThemeQuery?.removeEventListener("change", onOsThemeChange);
      window.removeEventListener("resize", onWindowResize);
      if (resizeTimer !== undefined) clearTimeout(resizeTimer);
      // Nothing scheduled to paint into a shell on its way out — see
      // `scheduleLoadingPaint`.
      cancelLoadingPaint();
      // The card/row overflow menus install their own document listeners once,
      // inside `ui/menu.ts`, and are keyed on which menu is open — there is
      // nothing per-shell to tear down here any more.
      // Kills the debounce timer and orphans any in-flight query, so a shell
      // torn down mid-search (a sign-out, an expired session) leaves nothing
      // scheduled to paint into DOM that is on its way out.
      search.reset();
      bin.destroy();
      reader.destroy();
      spdViewer.destroy();
      txtViewer.destroy();
      admin?.destroy();
      galleryEngine.destroy();
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
  };
}
