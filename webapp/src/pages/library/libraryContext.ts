// The library shell's shared context: everything its parts read, named once.
//
// `createAppShell` fills a `LibraryCtx` in dependency order (state and failure
// routing, then DOM, engines, viewers, destinations, features, previews,
// routes) and each part is `createLibraryX(ctx)`. A part reads a member only
// when one of its functions runs, never while it is being built, so the
// construction order in `library.ts` is the one place that has to be right.
// Reading a member before the shell assigned it is a programming error that
// the boot path (every e2e test) surfaces at once.

import type { Place } from "../../ui/place";
import type { TodoPage } from "../todo/todoPage";
import type { DigestPage } from "../digest/digestPage";
import type { DigestInk } from "../digest/digestInk";
import type { DestinationMode } from "./libraryModes";
import type { Api } from "../../api/types";
import type { ApiFailureSink } from "../../api/client";
import type { NoteRenderer } from "../../render/types";
import type { RenderCache } from "../../cache/types";
import type { LiveChannel } from "../../sync/types";
import type { Id } from "../../core/types";
import type { LazyEngine } from "../../render/lazy";
import type { Thumbnails } from "../../render/thumbnails";
import type { PdfThumbs } from "../../render/pdfThumb";
import type { SearchService } from "../../search/searchService";
import type { Exporter } from "../../export/exporter";
import type { TodoInk } from "../todo/todoInk";
import type { Masonry } from "../masonry";
import type { RailController } from "../rail/rail";
import type { FolderCache } from "../folderCache";
import type { QuotaMeter } from "../railFooter";
import type { NoteSearchController } from "../noteSearch";
import type { HistoryScope } from "../historyScope";
import type { BinController } from "../bin/bin";
import type { BinScope } from "../bin/binView";
import type { AdminDestination } from "../admin/adminDestination";
import type { AccountPage } from "../account/account";
import type { ViewerSet } from "../viewer/viewerSet";
import type { Topbar } from "./libraryTopbar";
import type { LibraryState } from "./libraryState";
import type { AppDeps } from "./library";
import type { LibraryModes } from "./libraryModes";
import type { LibraryView } from "./libraryView";
import type { LibraryData } from "./libraryData";
import type { LibraryRender } from "./libraryRender";
import type { LibraryFeatures } from "./libraryFeatures";
import type { LibraryPreviews } from "./libraryPreviews";
import type { LibraryRoutes } from "./libraryRoutes";

export interface LibraryCtx {
  // ---- given by main.ts ----
  deps: AppDeps;
  identity: AppDeps["identity"];
  renderer: NoteRenderer;
  cache: RenderCache;
  live: LiveChannel;
  /** `deps.api` wrapped by the version-preview and bin scopes; the only `Api` the parts use. */
  api: Api;
  /** Pins live reads to a retained version while a preview is open. */
  historyScope: HistoryScope;
  /** Reroutes a trashed file's reads to the bin routes. */
  binScope: BinScope;

  st: LibraryState;

  // ---- failure routing ----
  failures: ApiFailureSink;
  /** For listing/metadata errors; true means handled, skip the fallback. */
  handled(e: unknown): boolean;
  /** Fired at most once per shell. */
  sessionDidExpire(): void;
  toast(message: string): void;

  // ---- DOM ----
  root: HTMLElement;
  content: HTMLElement;
  gallery: HTMLElement;
  toastEl: HTMLElement;
  sidebar: HTMLElement;
  topbar: Topbar;
  /**
  * Which destination owns the surface. Tracked per destination because
  * `renderGallery()` runs on sync bumps and must not strip another's mode.
  */
  destinationsOpen: Record<DestinationMode, boolean>;

  // ---- collaborators, built once ----
  folderCache: FolderCache;
  rail: RailController;
  quota: QuotaMeter;
  pdfThumbs: PdfThumbs;
  thumbnails: Thumbnails;
  galleryEngine: LazyEngine;
  /** Promotes `data-src` on approach; null without `IntersectionObserver`. */
  imgLazy: IntersectionObserver | null;
  searchService: SearchService;
  search: NoteSearchController;
  exporter: Exporter;
  /** Lassoed to-dos' handwriting, cut from their note pages (the To-Do page and search). */
  todoInk: TodoInk;
  /** Digests' handwritten notes (the Digest page and the viewers' Digests panels). */
  digestInk: DigestInk;
  masonry: Masonry;
  viewers: ViewerSet;
  /** Where you are: the tab's title and the page's <h1> (`ui/place.ts`). */
  place: Place;
  adminDest: AdminDestination;
  /** The To-Do destination; built at start so the rail knows whether to show it. */
  todo: TodoPage;
  /** The Digest destination; built at start, like To-Do. */
  digest: DigestPage;
  bin: BinController;

  // ---- the parts ----
  modes: LibraryModes;
  view: LibraryView;
  data: LibraryData;
  render: LibraryRender;
  features: LibraryFeatures;
  previews: LibraryPreviews;
  routes: LibraryRoutes;

  // ---- small shell helpers ----
  /** The folder cache's key for a folder id (`null` = root). */
  key(id: Id | null): string;
  /** Re-spans the masonry after the gallery's children changed. */
  scheduleSpan(): void;
  /** Reading hides the topbar; toggled only by `openNote` and `enterPlace`. */
  /** `name`: the open document's, for the tab's title and the <h1>. */
  setReading(reading: boolean, name?: string): void;
  /** Closes the active viewer and drops any version pin. */
  hideActiveViewer(): void;
  /** The account page, built on first entry (see `LibraryState.accountPage`). */
  account(): AccountPage;
  leaveAccount(): void;
  leaveAdmin(): void;
  leaveTodo(): void;
  leaveDigest(): void;
  /**
   * Leave every place that covers the gallery (the console, the account page,
   * To-Do, Digest) but `keep`: one at a time, and a new one added here only.
   * The bin closes by being repainted over, so it is not one of them.
   */
  leaveDestinations(keep?: CoveringPlace): void;
  openAdmin(): void;
}

/** The places that cover the gallery and are left by `leaveDestinations`. */
export type CoveringPlace = "admin" | "account" | "todo" | "digest";

/** The members the shell has before any part is built. */
export type LibraryCtxSeed = Pick<
  LibraryCtx,
  | "deps" | "identity" | "renderer" | "cache" | "live" | "api" | "historyScope" | "binScope" | "st"
  | "gallery" | "content" | "place" | "toastEl" | "destinationsOpen"
  | "failures" | "handled" | "sessionDidExpire" | "toast"
  | "key" | "scheduleSpan" | "setReading" | "hideActiveViewer" | "account" | "leaveAccount" | "leaveAdmin" | "leaveTodo" | "leaveDigest" | "leaveDestinations" | "openAdmin"
>;

/**
* Starts a context from its seed. The remaining members are assigned by
* `createAppShell` in dependency order; this cast is that lifecycle, stated once.
*/
export function seedContext(seed: LibraryCtxSeed): LibraryCtx {
  return seed as LibraryCtx;
}
