// The library shell: rail, topbar and lazily-thumbnailed gallery, with the
// reader overlaying it. A long-lived controller (created once in main.ts) so
// gallery state survives opening a note. The route is the source of truth:
// every entry point only `go()`s a URL, and the `show*` handlers are the only
// writers of the state that URL describes (see `router.ts`).
//
// This file is the wiring: it fills a `LibraryCtx` in dependency order and
// hands it to the parts (`libraryContext.ts` has the rule). The behaviour is
// in the parts, one concern each.

import { createPhoneShell } from "./libraryPhone";
import { createPlace } from "../../ui/place";
import { el } from "../../ui/dom";
import { SORT_KEY, readLocal, writeLocal } from "../../ui/storage";
import { binNotePageHref, current, destinationHref, folderHref, go } from "../../router";
import { createBackupNotice } from "./backupNotice";
import type { Api } from "../../api/types";
import type { NoteRenderer } from "../../render/types";
import type { RenderCache } from "../../cache/types";
import type { PersistentThumbStore } from "../../cache/idb";
import type { LiveChannel } from "../../sync/types";
import type { Hash, Id, NoteMeta, NoteSummary } from "../../core/types";
import { skeletonPage } from "../../core/noteSkeleton";
import { dispatchApiFailure } from "../../api/client";
import { createExporter } from "../../export/exporter";
import { createPdfThumbs } from "../../render/pdfThumb";
import { createViewerSet } from "../viewer/viewerSet";
import { createMasonry } from "../masonry";
import { createTopbar, type SortKey } from "./libraryTopbar";
import { createAdminDestination } from "../admin/adminDestination";
import { createHistoryScope } from "../historyScope";
import { createBin, createBinScope, createBinView } from "../bin/bin";
import { createAccountPage } from "../account/account";
import type { LibraryState } from "./libraryState";
import { seedContext } from "./libraryContext";
import { createLibraryModes } from "./libraryModes";
import { createLibraryView } from "./libraryView";
import { createLibraryData } from "./libraryData";
import { createLibraryRender } from "./libraryRender";
import { installLibraryRail } from "./libraryRail";
import { installLibraryEngines } from "./libraryEngines";
import { createLibraryViewerDeps } from "./libraryViewerDeps";
import { createLibraryFeatures } from "./libraryFeatures";
import { createLibraryPreviews } from "./libraryPreviews";
import { createLibraryRoutes } from "./libraryRoutes";
import { warmWasm } from "../../core/warmWasm";
import { appUp, installAppInks, installAppPages } from "./libraryApps";

export const ADMIN_KEY = "admin";
/**
* Not a `Destination` (no rail row), but written into `destination` so every
* "is a folder listing on screen?" guard treats it like the bin and console.
*/
export const ACCOUNT_KEY = "account";
/** The To-Do destination's rail key; its routes are `#/todo/<view>`. */
export const TODO_KEY = "todo";
/** The Digest destination's rail key; its routes are `#/digest/<place>`. */
export const DIGEST_KEY = "digest";

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
  /** To-Do at one of its views (`inbox`, `planned`, `list/<id>` …). */
  showTodo(view: string): void;
  /** Digest at a place (`category/<uid>`, `sources/<key>/d/<id>` …). */
  showDigest(place: string): void;
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
}

/** Validated, not cast: localStorage may hold a stale or hand-edited key. */
function readStoredSort(): SortKey {
  const raw = readLocal(SORT_KEY);
  return raw === "title" || raw === "pages" || raw === "recent" ? raw : "recent";
}

/**
 * "Skip to content", the first thing a keyboard reaches: past the rail and the
 * bar. Not followed as a link: the hash is the router's.
 */
function skipLink(target: HTMLElement): HTMLElement {
  const a = el("a", { class: "skip-link", href: "#content", text: "Skip to content" });
  a.addEventListener("click", (e) => {
    e.preventDefault();
    target.focus();
  });
  return a;
}

export function createAppShell(deps: AppDeps): AppShell {
  const { renderer, cache, live, identity } = deps;

  // ---- state ----
  const st: LibraryState = {
    folderId: null,
    destination: null,
    listing: undefined,
    query: "",
    sort: readStoredSort(),
    view: "grid",
    knownSyncVersion: 0,
    sessionExpired: false,
    searchState: { kind: "idle" },
    toastTimer: undefined,
    accountPage: null,
    readerBack: folderHref(null),
    routeToken: 0,
    loadingPaintTimer: undefined,
    indexPending: null,
    resizeTimer: undefined,
  };

  // Two composed `Api` wrappers: version preview and bin. They never both fire
  // (previews are of live notes) and pass through when inactive. `binScope`
  // is wrapped once here so the reader, lazy engine, exporter and `openNote`
  // never learn the bin exists; `attach` comes later, until then nothing is trashed.
  const binScope = createBinScope();
  const historyScope = createHistoryScope();
  const api = historyScope.wrap(binScope.wrap(deps.api));

  // ---- DOM skeleton ----
  const gallery = el("section", { class: "gallery", id: "gallery", "aria-label": "Notes" });
  // The one <main>: what the bar and the rail are around. Focusable from code,
  // for the skip link and a change of screen.
  const place = createPlace();
  const content = el("main", { class: "content", id: "content", tabindex: "-1" }, place.heading, gallery);
  const toastEl = el("div", { class: "toast", role: "status", "aria-live": "polite" });

  /**
  * A thumbnail's `?v=` 404'd: refetch the listing (STALE_PAGE). Once per hash,
  * so new hashes that also 404 can't spin.
  */
  const staleHandled = new Set<Hash>();

  // The members below this literal are assigned in dependency order; a part
  // reads them only when called (see `libraryContext.ts`).
  const ctx = seedContext({
    deps,
    identity,
    renderer,
    cache,
    live,
    api,
    historyScope,
    binScope,
    st,
    gallery,
    content,
    place,
    toastEl,
    destinationsOpen: { bin: false, admin: false, account: false, todo: false, digest: false },

    // ---- failure routing ----
    failures: {
      onSessionExpired: () => ctx.sessionDidExpire(),
      onStalePage: (_noteId, page) => {
        if (st.sessionExpired || staleHandled.has(page.hash)) return;
        staleHandled.add(page.hash);
        void ctx.data.refetch(st.folderId, ctx.folderCache.get(st.folderId));
      },
    },
    handled: (e) => dispatchApiFailure(ctx.failures, e),
    sessionDidExpire() {
      if (st.sessionExpired) return;
      st.sessionExpired = true;
      deps.onSessionExpired();
    },
    toast(message) {
      toastEl.textContent = message;
      toastEl.classList.add("is-shown");
      if (st.toastTimer !== undefined) clearTimeout(st.toastTimer);
      st.toastTimer = setTimeout(() => toastEl.classList.remove("is-shown"), 2400);
    },

    // ---- small shell helpers ----
    key: (id) => id ?? "\0root",
    scheduleSpan: () => ctx.masonry.schedule(),
    setReading: (reading, name) => {
      ctx.root.classList.toggle("is-reading", reading);
      ctx.place.overlay(reading ? (name ?? null) : null);
    },
    hideActiveViewer() {
      // The next live read must not stay pinned to a retained version.
      historyScope.clear();
      ctx.viewers.hideActive();
    },
    account() {
      st.accountPage ??= createAccountPage(ctx.features.accountHost);
      return st.accountPage;
    },
    leaveAccount: () => st.accountPage?.close(),
    leaveAdmin: () => ctx.adminDest.leave(),
    leaveTodo: () => ctx.todo?.close(),
    leaveDigest: () => ctx.digest?.close(),
    leaveDestinations(keep) {
      if (keep !== "admin") ctx.leaveAdmin();
      if (keep !== "account") ctx.leaveAccount();
      if (keep !== "todo") ctx.leaveTodo();
      if (keep !== "digest") ctx.leaveDigest();
    },
    openAdmin: () => ctx.adminDest.open(),
    searchInView: () => st.query.trim() !== "" && st.destination === null && ctx.viewers.active() === null,
  });

  // ---- the parts that only read lazily ----
  ctx.modes = createLibraryModes(ctx);
  ctx.view = createLibraryView(ctx);
  ctx.data = createLibraryData(ctx);
  ctx.render = createLibraryRender(ctx);

  // ---- DOM: rail and topbar ----
  installLibraryRail(ctx);
  ctx.quota.refresh();

  ctx.topbar = createTopbar({
    initialSort: st.sort,
    folderId: () => st.folderId,
    applyQuery: (q) => ctx.modes.applyQuery(q),
    onSort: (next) => {
      st.sort = next;
      writeLocal(SORT_KEY, st.sort);
      ctx.render.renderGallery();
    },
    onView: (next) => ctx.view.setView(next),
    onEmptyBin: () => ctx.bin.empty(),
    onLockAdmin: () => ctx.adminDest.lock(),
    onFiles: (files) => ctx.features.uploadZone.add(files),
  });

  // ---- engines ----
  // The thumbnail facade: every tile is a WebP blob from one call. PDF page 0
  // uses the viewer's MuPDF wasm, inert until a visible, uncached PDF tile needs
  // it (a persistent `sn-thumbs` hit answers first).
  ctx.pdfThumbs = createPdfThumbs();
  installLibraryEngines(ctx);
  ctx.exporter = createExporter({ api, renderer });
  installAppInks(ctx);

  // ---- viewers ----
  ctx.viewers = createViewerSet(createLibraryViewerDeps(ctx), content, gallery);

  // Admins only: a backup that failed, is late, or never happened.
  const backupNotice = createBackupNotice({
    api,
    isAdmin: () => identity.isAdmin,
    onOpen: () => {
      ctx.adminDest.revealBackups();
      go(destinationHref(ADMIN_KEY));
    },
  });

  const header = el("header", { class: "main__head" }, ctx.topbar.el, backupNotice.el);
  const column = el("div", { class: "main" }, header, content);
  const app = el("div", { class: "app" }, ctx.sidebar, column);
  ctx.root = el("div", { class: "sn-root" }, skipLink(content), app, toastEl);

  // On a phone: the rail as a drawer, the bar's buttons, the tab bar.
  const phone = createPhoneShell({
    root: ctx.root,
    app,
    rail: ctx.sidebar,
    header,
    main: content,
    topbar: ctx.topbar,
    searchInput: ctx.topbar.searchInput,
    section: () => (st.destination === TODO_KEY ? "todo" : st.destination === ACCOUNT_KEY ? "you" : "library"),
    up: () => {
      const r = current();
      const inApp = appUp(r);
      if (inApp !== undefined) return inApp;
      if (r.name === "search") {
        // Back to where the search started, named as the rail names it.
        const here = st.listing?.folderId === st.folderId ? st.listing?.path.at(-1) : undefined;
        const label = st.folderId === null ? "Library" : here ? ctx.rail.labelFor(here) : "folder";
        return { href: folderHref(st.folderId), label };
      }
      if (r.name === "folder") {
        // The crumbs' last link is the parent (Library for a top folder).
        const links = ctx.topbar.crumbs.querySelectorAll("a[href]");
        const parent = links[links.length - 1];
        return parent ? { href: parent.getAttribute("href")!, label: (parent.textContent ?? "").trim() || "Library" } : { href: folderHref(null), label: "Library" };
      }
      return null;
    },
  });
  column.append(phone.tabbar);

  // ---- destinations ----
  // The breadcrumbs' current place names every library screen (folders,
  // search, the bin, admin, the account page), whoever painted them.
  new MutationObserver(() => {
    const here = ctx.topbar.crumbs.querySelector('[aria-current="page"]');
    if (here) ctx.place.set(here.textContent ?? "");
  }).observe(ctx.topbar.crumbs, { childList: true });

  installAppPages(ctx);

  ctx.adminDest = createAdminDestination({
    api,
    account: identity.email,
    content,
    gallery,
    crumbs: ctx.topbar.crumbs,
    sortWrap: ctx.topbar.sortWrap,
    segmented: ctx.topbar.segmented,
    lockBtn: ctx.topbar.lockAdminBtn,
    setMode: (open) => {
      ctx.modes.setDestinationMode("admin", open);
      backupNotice.setConsoleOpen(open);
    },
    rebuildRail: () => ctx.rail.build(),
    isCurrent: () => st.destination === ADMIN_KEY,
    toast: ctx.toast,
    onSessionExpired: ctx.sessionDidExpire,
    onBackupsChanged: () => void backupNotice.refresh(),
  });

  ctx.bin = createBin({
    api,
    // The gallery's own engine; its `reset()` is the bin's teardown.
    view: createBinView({
      gallery,
      crumbs: ctx.topbar.crumbs,
      sortWrap: ctx.topbar.sortWrap,
      segmented: ctx.topbar.segmented,
      root: ctx.root,
      engine: ctx.galleryEngine,
      setMode: ctx.modes.setBinMode,
      onLeave: () => go(folderHref(null)),
    }),
    // Routed to `#/bin/note/:id` (the live route 404s for trashed files) so Back,
    // reload and copy-link reopen the same trashed file with a `"bin"` origin.
    onOpen: (entry) => go(binNotePageHref(entry.id)),
    onChanged: (mutated) => {
      // The badge moves every refresh; the folder only refetches on a real mutation.
      ctx.rail.build();
      if (mutated) void ctx.data.refetch(st.folderId, ctx.folderCache.get(st.folderId));
    },
    handled: ctx.handled,
  });
  binScope.attach((id) => ctx.bin.isTrashed(id));

  // ---- features, previews, routes ----
  ctx.features = createLibraryFeatures(ctx);
  ctx.masonry = createMasonry(gallery, () => st.view === "grid" && st.query.trim() === "");
  ctx.previews = createLibraryPreviews(ctx);

  // ---- live data ----
  const unsubscribe = live.subscribe(ctx.data.onBump, ctx.data.onIndex);
  // The index's lifecycle on the same socket: derive-complete and sync frames
  // coalesce in `attachLive`, so a big sync is a few manifest requests. Nothing
  // here instantiates the engine; only `search()` does.
  const detachSearchLive = ctx.searchService.attachLive(live);
  void ctx.searchService.syncNow();

  // ---- theme and viewport ----
  // Follow the OS theme until one is pinned (`data-theme` wins). Handlers are
  // named so `destroy()` can remove them.
  const osThemeQuery = window.matchMedia?.("(prefers-color-scheme: dark)");
  const onOsThemeChange = (e: MediaQueryListEvent): void => {
    if (document.documentElement.getAttribute("data-theme")) return;
    // The theme being left is the inverse of the new one.
    ctx.view.repaintForTheme(e.matches ? "light" : "dark");
  };
  osThemeQuery?.addEventListener("change", onOsThemeChange);

  const onWindowResize = (): void => {
    if (st.resizeTimer !== undefined) clearTimeout(st.resizeTimer);
    st.resizeTimer = setTimeout(() => {
      ctx.galleryEngine.repaintVisible();
      ctx.viewers.reader.bumpTheme();
    }, 150);
  };
  window.addEventListener("resize", onWindowResize);

  // The first listing comes from main.ts's route dispatch; listing here would race it.
  void ctx.folderCache.prefetch();

  // Signed in, so worth it: the search and PDF wasm modules download in the
  // background, after the gallery and when the browser is idle.
  const cancelWarmWasm = warmWasm();

  ctx.routes = createLibraryRoutes(ctx);
  const routes = ctx.routes;
  return {
    el: ctx.root,
    showFolder: routes.showFolder,
    showSearch: routes.showSearch,
    showDestination: routes.showDestination,
    showAccount: routes.showAccount,
    showTodo: routes.showTodo,
    showDigest: routes.showDigest,
    openNote: routes.openNote,
    openNoteVersion: routes.openNoteVersion,
    openBinNote: routes.openBinNote,
    destroy(): void {
      phone.destroy();
      cancelWarmWasm();
      unsubscribe();
      // Otherwise one coalescing window and engine memory leak per sign-in cycle.
      detachSearchLive();
      ctx.searchService.dispose();
      // Otherwise these accumulate per sign-in cycle, each holding the shell alive.
      osThemeQuery?.removeEventListener("change", onOsThemeChange);
      window.removeEventListener("resize", onWindowResize);
      if (st.resizeTimer !== undefined) clearTimeout(st.resizeTimer);
      ctx.data.cancelLoadingPaint();
      // Kills the debounce timer and orphans in-flight queries.
      ctx.search.reset();
      ctx.bin.destroy();
      ctx.viewers.destroy();
      ctx.adminDest.destroy();
      backupNotice.destroy();
      st.accountPage?.destroy();
      ctx.todo.destroy();
      ctx.digest.destroy();
      // Aborts uploads and drops the document-level drag swallowers.
      ctx.features.uploadZone.destroy();
      ctx.galleryEngine.destroy();
      // Release the ~5 MB MuPDF worker now, not after its idle window.
      ctx.pdfThumbs.destroy();
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
