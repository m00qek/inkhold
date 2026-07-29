// The .note reader (P3). A full-bleed overlay over the library: a lazy filmstrip
// of every page (thumb tier) down the left, and a single main viewer painting the
// current page (full tier). Both go through the same lazy pipeline as the gallery
// — the filmstrip via the IntersectionObserver engine, the viewer via a direct
// `renderPage` (it's always visible, so there's nothing to lazily gate) plus
// neighbour prefetch on idle so paging feels instant.
//
// Ported from the approved mockup's reader. The Download menu has THREE groups —
// THIS PAGE — CURRENT VIEW, THIS PAGE — ORIGINAL VIEW (shown only once a layer's
// visibility has been changed, since with nothing toggled the two views are
// byte-identical) and WHOLE NOTEBOOK. Every transformed export is generated in
// the browser (see `export/`) and downloaded, never written back to the device's
// EXPORT/ folder; the whole-notebook group also offers the raw `.note`. The
// per-page rows adapt to the focused page: with a live layer stack they flatten
// the chosen VIEW (honouring toggles), with none the current view IS the
// composite and the layered-only rows fold away.

import { el } from "../ui/dom";
import type { Api } from "../api/types";
import type { NoteRenderer } from "../render/types";
import type { RenderCache } from "../cache/types";
import type { Hash, Id, NoteMeta, NoteSummary, PageRef, Theme, WordBox } from "../core/types";
import { createLazyEngine, renderPage, type LazyEngine } from "../render/lazy";
import { createTemplateProvider } from "../render/template";
import { dispatchApiFailure, type ApiFailureSink } from "../api/client";
import { fileKind, formatBytes, rawFileUrl, historyFileUrl, type FileKind } from "../core/fileKind";
import { createOcrController, type OcrState } from "./ocrPanel";
import { createFindController, type FindState } from "./findInNote";
import { OVAL_VIEWBOX, ovalsFor } from "./findOvals";
import { createExporter, download, type Exporter } from "../export/exporter";
import { createToolbar } from "./toolbar";
import {
  svg,
  VIEWER_IC,
  VIEWER_DEBOUNCE_MS,
  backWord,
  createViewerHeader,
  createZoomStepper,
  createViewerExportMenu,
} from "./viewerChrome";
import { createBinViewerActions, type BinRetention } from "../ui/binViewerActions";
import { relativeTime, absoluteTime } from "../ui/relativeTime";
import { createLayersPanel } from "./layersPanel";
import { createSidePanel, sidePanelState } from "../ui/sidePanel";
import { VirtualList } from "../ui/virtualList";
import { DEFAULT_PAGE_DIMS, skeletonPage } from "../core/noteSkeleton";
import {
  buildNoteLayerThumb,
  createNoteLayersController,
  noteLayerExportFilename,
  toPanelLayers,
} from "./noteLayers";
import { exportFlatPng, exportOra, flattenLayers, type ExportWhich } from "../export/layered";
import type { PageLayer } from "../core/types";

export interface ReaderDeps {
  api: Api;
  renderer: NoteRenderer;
  cache: RenderCache;
  getTheme: () => Theme;
  /** Navigate back to the library (the reader never mutates the hash itself). */
  onBack: () => void;
  toast: (message: string) => void;
  /**
   * The session died mid-read (a 401/403 from any page fetch). The reader can't
   * re-authenticate — it hands off to the shell, which hands off to the
   * composition root. Only the UNAUTHORIZED half is delegated: STALE_PAGE the
   * reader handles itself, since it owns the note metadata that carries the
   * stale hashes.
   */
  onSessionExpired: () => void;
  /**
   * Move the currently-open note to the recycle bin (the right-zone action). The
   * reader hands the shell the note's identity and DOES NOTHING ELSE — the shell
   * owns the one trash path (`bin.trash`), so the undo toast, the U6 device line
   * and the control-plane call are shared with the library card's delete by
   * construction, not reinvented here. The shell also navigates away afterwards;
   * the reader never mutates the hash itself (same rule as {@link onBack}).
   *
   * Hidden in the recycle-bin context, where the note is ALREADY trashed and the
   * two callbacks below take over the file zone — see `open()`.
   */
  onMoveToBin?: (meta: NoteMeta) => void;
  /**
   * The BIN-ORIGIN file actions (see `pages/viewer.ts`, whose contract this
   * mirrors): shown instead of Move to bin when the note was opened FROM the
   * recycle bin. The reader hands the shell the note's identity and nothing
   * else — the shell routes both through the bin controller, so Restore's toast,
   * the purge's confirm dialog and the navigation back to the bin are the bin's
   * one machinery rather than a reader-owned copy.
   */
  onRestore?: (meta: NoteMeta) => void;
  onPurge?: (meta: NoteMeta) => void;
  /**
   * Restore the version currently being PREVIEWED (history mode) as the file's
   * current version. The reader hands the shell the note's identity + the
   * version's md5 and does nothing else — the shell owns the confirm, the
   * quota-error surfacing, the library/reader refresh and the toast, so the
   * preview's Restore and the list row's Restore are one machinery. Only fired
   * from the history banner, which only shows for a `history` origin.
   */
  onRestoreVersion?: (meta: NoteMeta, version: { md5: string; createdAt: number }) => void;
  /**
   * Open this note's VERSION HISTORY — the same panel the library card's ⋯ menu
   * opens (`onHistory`), wired to the reader toolbar's "Versions" control for
   * discoverability while reading. The reader hands the shell the note's identity,
   * the toolbar button the floating panel anchors to, and — WHEN previewing a
   * retained version — that version's md5, so its row is marked `Viewing`. Absent
   * `viewingMd5` (a live-note open) means no row is the one on screen.
   */
  onVersions?: (meta: NoteMeta, anchor: HTMLElement, viewingMd5?: string) => void;
  /**
   * The reader's POSITION changed — the page on screen, or the in-note search
   * running over it. The shell answers by rewriting the URL with
   * `history.replaceState` (see `router.ts`), so the address bar always describes
   * what is on screen without a history entry per page turn.
   *
   * `versionMd5` is present ONLY while previewing a retained version (history
   * mode): the shell then emits the `#/note/:id/version/:short` form so a reload
   * / copy-link reproduces that version, instead of the bare live-note URL. `bin`
   * is present ONLY for a file opened FROM the recycle bin: the shell emits the
   * deep `#/bin/note/:id/page/:n` form, because a trashed file's blob is not at
   * the live `#/note/:id` route. The two flags are mutually exclusive.
   *
   * A callback rather than a router import for the same reason `onBack` is one:
   * the reader never mutates the hash itself. It reports where it is; the shell
   * decides what that means for the URL.
   */
  onPosition?: (noteId: Id, page: number, query: string, versionMd5?: string, bin?: boolean) => void;
}

/**
 * WHERE THE READER WAS OPENED FROM — which is the only thing the Back label can
 * usefully carry, now that the library's topbar is hidden while a note is open.
 *
 * `kind` decides the WORD on the button, and with it whether the subtitle still
 * has to name the folder:
 *
 *  - `"folder"` — Back says the folder's own name, so repeating it in the
 *    subtitle would be exactly the duplication hiding the topbar removed.
 *  - `"search"` — results are LIBRARY-WIDE, so the note's folder is emphatically
 *    not where you were; Back says `Search` and the folder becomes genuinely new
 *    information that belongs in the subtitle.
 *  - `"bin"` — same shape as search: the bin is not the note's folder.
 *
 * `folderPath` is the note's own folder, `null` when the shell could not work it
 * out (a deep link, or a note in a folder the tree walk has not reached). Absent
 * is rendered as absent — never as a guess and never as an empty separator.
 */
export interface ReaderOrigin {
  kind: "folder" | "search" | "bin" | "history";
  /** Human path of the note's folder (`Note / Projects`), or null if unknown. */
  folderPath: string | null;
  /**
   * For a HISTORY origin only: the retained version being previewed, so the
   * reader can banner WHEN it is from (`createdAt`, epoch ms) and hand `md5` to
   * the Restore action. Absent for every live origin; the reader shows the
   * "previewing an older version" chrome exactly when this is present.
   */
  version?: { md5: string; createdAt: number };
  /**
   * For a BIN origin only: the trashed file's countdown, so the viewer toolbar
   * can paint the SAME retention rule the bin row shows (a compact horizontal
   * variant of `.life`). Absent for folder/search origins, and null when the bin
   * could not resolve it — the toolbar then shows the "…" menu with no timeline.
   */
  retention?: BinRetention | null;
  /**
   * For a HISTORY origin whose file is TRASHED: the preview is VIEW-ONLY. The
   * banner's Restore-this-version is suppressed (restore the FILE first, then a
   * version — see bin-parity.md's decision) and raw-based viewers fetch the
   * version's bytes through the bin-scoped history route. The version LIST,
   * `Viewing`/`Current` and click-to-preview all stay; only per-version restore
   * is removed. Absent (falsy) for a live file's history preview.
   */
  viewOnly?: boolean;
}

/** The default when nothing better is known: Back goes to the whole library. */
const LIBRARY_ORIGIN: ReaderOrigin = { kind: "folder", folderPath: null };

export interface Reader {
  /** The `.reader` section, mounted once inside the library's content area. */
  el: HTMLElement;
  /**
   * Show a file, starting at `startPage` (0-based, clamped into range; default
   * the first page). The start page comes from the ROUTE — a search hit deep-links
   * to the page its excerpt is on — so it is a parameter rather than a follow-up
   * `showPage()` call: opening and then jumping would paint page 1 first and
   * visibly bounce, and would leave the filmstrip's `aria-current` on the wrong
   * page for a frame.
   *
   * **THREE OUTCOMES, on `meta.fileType`** (see `core/fileKind.ts`). Only a
   * verified `.note` gets the SNPG pipeline below. An image is handed to the
   * browser as an `<img>` off the raw-bytes endpoint, and anything else gets an
   * honest "no preview" state with a download. Before this split every one of
   * them opened the reader and painted a blank canvas, because the backend
   * fabricates a placeholder page for a blob it cannot parse and the client had
   * no way to tell that page was fake. `startPage` is ignored outside note mode.
   *
   * `origin` is where Back goes and what it is called — see {@link ReaderOrigin}.
   *
   * `query` PRIMES FIND, and it comes off the route too (`?q=`): the bar opens,
   * the field is filled and the controller is handed the query, which lands the
   * reader on the first match through the settle-and-navigate path find already
   * has. There is deliberately no second path for it — priming is `find.setQuery`
   * and nothing else, so a deep link and a keystroke reach the same code.
   */
  open(summary: NoteSummary, metaPromise: Promise<NoteMeta>, startPage?: number, origin?: ReaderOrigin, query?: string): Promise<void> | void;
  close(): void;
  /**
   * The shell is switching to another viewer (see `pages/viewer.ts`). The reader
   * fully closes — a hidden reader must keep no decoded page and no keydown
   * listener, and the shell re-primes it through `open()` before it is seen again,
   * so there is nothing lighter worth doing. Identical to {@link close}; this is
   * the name the {@link Viewer} contract uses, which is what lets the reader be
   * the shell's default viewer without a wrapper.
   */
  hide(): void;
  isOpen(): boolean;
  /** Repaint for a new theme: filmstrip visible-only + the current viewer page. */
  bumpTheme(): void;
  destroy(): void;
}

const ZOOMS = ["Fit", "100%", "150%"] as const;
type Zoom = (typeof ZOOMS)[number];
const ZOOM_SCALE: Record<Zoom, number> = { Fit: 1, "100%": 1.18, "150%": 1.68 };
const DPR_CAP = 2;

/**
 * A px-valued CSS token read off `:root`. The reader's relayout has to subtract
 * exactly the width a docked side panel takes from the stage — and that width is
 * a token now (`--panel-w`, `--panel-w-wide`, `--panel-gap` in 00-tokens.css). So
 * the JS reads the very same value the stylesheet uses rather than duplicating it
 * as a hand-synced constant that quietly drifts. `fallback` matches the token's
 * authored value for any environment where the property is not yet resolvable.
 */
function tokenPx(name: string, fallback: number): number {
  if (typeof getComputedStyle !== "function" || typeof document === "undefined") return fallback;
  const n = Number.parseInt(getComputedStyle(document.documentElement).getPropertyValue(name), 10);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * The reader's second line. The folder is prepended EXACTLY WHEN Back is not
 * already carrying it: from a search result or the bin the note's folder is new
 * information, and from the folder itself it would be the duplication that
 * hiding the library topbar exists to remove.
 */
function subtitle(origin: ReaderOrigin, rest: string): string {
  if (origin.kind === "folder" || origin.folderPath === null) return rest;
  return `${origin.folderPath} · ${rest}`;
}

export function createReader(deps: ReaderDeps): Reader {
  const { api, renderer, cache, getTheme } = deps;

  // --- DOM -----------------------------------------------------------------
  // The page-index thumbnail rail. It is the BODY of the "Pages" side panel now
  // (built below), so it carries no `aria-label` of its own — the panel's aside
  // is the named "Pages" region. Still the lazy IntersectionObserver engine's
  // target host and the source of the `.filmstrip__page` buttons.
  const filmstrip = el("div", { class: "filmstrip" });
  // Back + title — the shared viewer header, keeping the reader's LEGACY class set
  // (`.backbtn`/`.reader__title`) so migrating it is not pure CSS/e2e churn.
  const header = createViewerHeader({
    classes: { back: "backbtn", backLabel: "backbtn__label", title: "reader__title" },
    onBack: () => deps.onBack(),
  });
  const back = header.back;
  const pagerCount = el("span", { class: "pager__count", text: "1 / 1" });
  const pageCanvas = el("canvas");
  // The focused page's PER-LAYER canvas stack (pages/noteLayers.ts) — mounted
  // over the composite canvas and shown INSTEAD of it whenever the page's meta
  // carries layers and every record decodes. Any failure keeps the composite:
  // the stack degrades, the reader never breaks.
  const noteLayerCtl = createNoteLayersController({ getTemplate: createTemplateProvider(api) });
  const pageEl = el("div", { class: "page" }, pageCanvas, noteLayerCtl.el);

  // The recognized-text aside sits BESIDE the page inside .page-wrap (per the
  // mockup), which is what makes opening it narrow the page rather than overlay
  // it. It rides the SHARED side-panel primitive (src/ui/sidePanel.ts) — the same
  // chrome the layers panel uses — with the `ocr` hook namespace, so the card,
  // head and open/hide are one implementation across both panels. `ocrBody` IS
  // the primitive's body (class `side-panel__body ocr__body`); the `.ocr__body`
  // text treatment (07-find-in-note.css) still selects it.
  const ocrPanel = createSidePanel({
    ariaLabel: "Recognized text",
    icon: svg(VIEWER_IC.text, 1.7),
    label: "Recognized text",
    hookPrefix: "ocr",
  });
  const ocrBody = ocrPanel.body;
  // The SHARED layers panel (pages/layersPanel.ts), fed from the live stack.
  // The `.note` side supplies: the hook namespace (`note-layers`/`note-layer__…`),
  // the toggle callback mapping onto the canvas stack (`style.display` — the
  // spd mechanism), and the thumb painter drawing from the layer's own decoded
  // canvas. NO `onOpacity` and no `opacity` on the rows: `.note` layers carry
  // none (device-confirmed), which is exactly what keeps the stepper off.
  const layersPanel = createLayersPanel({
    id: "note-layers-panel",
    hookPrefix: "note",
    onToggle: (id, visible) => {
      noteLayerCtl.setVisible(id, visible);
      // The Original-view export group turns on once a layer's live state differs
      // from the device-authored one — this toggle may be exactly that change, so
      // reconcile it now (without rebuilding the panel's rows).
      refreshExportGroups();
    },
    paintThumb: (pl) => {
      const v = noteLayerCtl.stack()?.views.find((x) => x.index === pl.id);
      if (!v) return el("div", { "aria-hidden": "true" });
      return buildNoteLayerThumb(v);
    },
  });
  // The PAGE INDEX, now a member of the SAME docked side-panel family as Layers
  // and OCR (src/ui/sidePanel.ts) — one chrome, one show/hide mechanism — rather
  // than a bespoke left rail in the reader grid. Two things set it apart, both
  // expressed through the shared component: it docks on the LEFT (it is inserted
  // ahead of the page in `.page-wrap`), and it is OPEN BY DEFAULT (it is the
  // reader's primary navigation, not an on-demand tool). Its body IS the existing
  // `filmstrip` rail, unchanged — so the lazy thumbnails, the current-page
  // highlight, click-to-jump, the find badges and keyboard nav all carry over.
  const pageIndexPanel = createSidePanel({
    id: "note-pages-panel",
    ariaLabel: "Pages",
    icon: svg(VIEWER_IC.pages, 1.7),
    label: "Pages",
    hookPrefix: "pages",
  });
  pageIndexPanel.body.append(filmstrip);

  // Docked beside the page like the recognized-text aside — same `.page-wrap`
  // slot, same "the panel's width is not the page's" sizing rule in showPage. The
  // page index leads on the LEFT; OCR and Layers dock on the RIGHT.
  const pageWrap = el("div", { class: "page-wrap" }, pageIndexPanel.el, pageEl, ocrPanel.el, layersPanel.el);
  const stage = el(
    "div",
    { class: "stage" },
    pageWrap,
  );

  // --- the non-`.note` stage ------------------------------------------------
  // A second stage, shown INSTEAD of the canvas one, covering both of the other
  // two outcomes: an `<img>` for a previewable image, and an honest "no preview"
  // block for everything else. One element rather than two because they are the
  // same slot in the layout and never coexist.
  const fileImg = el("img", { class: "filestage__img", alt: "" }) as HTMLImageElement;
  // `naturalWidth` is 0 until the bytes land, so a zoom step applied to a
  // not-yet-loaded image would compute a width of 0 and silently do nothing.
  // Re-apply once the real dimensions exist.
  fileImg.addEventListener("load", () => sizeImage());
  const fileBody = el("div", { class: "empty filestage__empty" });
  const fileStage = el("div", { class: "filestage", hidden: true }, fileImg, fileBody);

  const prev = el("button", { class: "icon-btn", type: "button", "aria-label": "Previous page", html: svg(VIEWER_IC.prev, 1.8) });
  const next = el("button", { class: "icon-btn", type: "button", "aria-label": "Next page", html: svg(VIEWER_IC.next, 1.8) });
  // The zoom stepper (`− [Fit] +`). `onStep` walks the fixed ZOOMS ladder,
  // mutating the reader's own `zoom` state (read by `sizeImage`/`showPage`) and
  // re-rendering the affected surface — the image is CSS-resized, a note page
  // re-decoded at the new scale. Bare `.zoom` readout class (the reader is the
  // only viewer using it) — the others keep `.spd-zoom`/`.txt-zoom` apart.
  const zoomStepper = createZoomStepper({
    readoutClass: "zoom",
    initial: "Fit" as Zoom,
    format: (z: Zoom) => z,
    onStep: (dir) => {
      const i = Math.max(0, Math.min(ZOOMS.length - 1, ZOOMS.indexOf(zoom) + dir));
      zoom = ZOOMS[i]!;
      if (mode === "image") sizeImage();
      else void showPage(pageIndex);
      return zoom;
    },
  });
  const zoomEl = zoomStepper.el;
  // "Download", not "Export": the verb a user knows for "get this file onto my
  // machine" (`toolbar.md`). It opens the same export menu — only the label
  // changed — so the internal `export*` names stay, and the non-note modes' plain
  // `downloadLink` below is the same action for a file with no menu to offer.
  //
  // The Download control is the SHARED in-flow export menu (viewerChrome.ts): the
  // trigger + popover + the menu-item/guard/outside-click+Escape mechanics. The
  // reader keeps `aria-haspopup="true"` (not the default "menu"); the content —
  // per-page current/original groups plus the whole-notebook group — is injected
  // into `exportMenu.pop` below.
  //
  // ICON-ONLY, deliberately overriding `toolbar.md`'s "icon+label for the
  // consequential" default: the user's explicit call. The trigger's `aria-label`
  // and `title` carry "Download"; the pressed/active look while the menu is open
  // is driven off `aria-expanded` in CSS (see `10-toolbar.css`). Do not "fix" the
  // label back in.
  const exportMenu = createViewerExportMenu({ toast: deps.toast, haspopup: "true" });
  // ICON-ONLY too, same explicit override as Download above — the visible "Text"
  // label is dropped, the `aria-label`, `title` and the `aria-pressed` toggle
  // state stay. Its active look while the recognised-text panel is open rides on
  // the same `aria-pressed` CSS the find toggle uses. Don't restore the label.
  const ocrToggle = el("button", {
    class: "btn",
    type: "button",
    "aria-pressed": "false",
    "aria-label": "Recognized text",
    title: "Recognized text",
    html: svg(VIEWER_IC.text, 1.7),
  });
  // The layers-panel toggle — the spd viewer's exact treatment (icon-only
  // `.btn`, `aria-pressed`/`aria-expanded`/`aria-controls`, the open-panel
  // active look off its own state — see spdViewer.ts `layersToggle`). Enabled
  // only while the FOCUSED page has a live layer stack: layers are per-page in
  // a `.note`, so the control follows the page rather than the file.
  const layersToggle = el("button", {
    class: "btn",
    type: "button",
    "aria-pressed": "false",
    "aria-expanded": "false",
    "aria-controls": "note-layers-panel",
    "aria-label": "Layers",
    title: "Layers",
    html: svg(VIEWER_IC.layers, 1.7),
  }) as HTMLButtonElement;
  // The PAGE-INDEX toggle — the same panel-toggle treatment as Layers/OCR (icon-
  // only `.btn`, `aria-pressed`/`aria-expanded`/`aria-controls`, the open-panel
  // active look off its own state). PRESSED BY DEFAULT: the page index opens with
  // the note, unlike the on-demand right-hand panels. It gives the user a way back
  // after the narrow-stage reflow auto-collapses it (see `relieveDoubleSqueeze`).
  const pagesToggle = el("button", {
    class: "btn",
    type: "button",
    "aria-pressed": "true",
    "aria-expanded": "true",
    "aria-controls": "note-pages-panel",
    "aria-label": "Pages",
    title: "Pages",
    html: svg(VIEWER_IC.pages, 1.7),
  }) as HTMLButtonElement;
  // "Move to bin" — a UNIVERSAL file action (right zone), beside Download.
  // QUIET AND NEUTRAL, never red (`toolbar.md`: "adopt the wording, drop the
  // red"): trashing is recoverable and red is reserved for purge, so this is a
  // plain `.btn` (`--ink`), not `is-danger`. LABELLED, not icon-only: a bare
  // trash glyph reads as danger, the exact signal this must not send. Wired to
  // the library's ONE trash path via `deps.onMoveToBin` — same undo toast, same
  // U6 device line as the card delete.
  const moveBin = el("button", {
    class: "btn",
    type: "button",
    "aria-label": "Move to bin",
    title: "Move to bin",
    html: svg(VIEWER_IC.trash, 1.8) + "Move to bin",
  });
  // "Versions" — the reader's entry point to the file's version history, the same
  // panel the library card's ⋯ menu opens (routed through the shell's `onVersions`
  // → the one history controller, never a second panel). ICON-ONLY like the other
  // reader affordances, carrying the SAME `restore` glyph the ⋯ menu uses (an
  // anticlockwise return arrow — "go back to a past version", not a delete).
  // Shown only for a LIVE `.note` open, gated exactly as the card menu is (see
  // `open()`): absent for images/PDFs (no history UI), while previewing a past
  // version (the banner already owns that context), and from the recycle bin.
  const versionsBtn = el("button", {
    class: "btn",
    type: "button",
    "aria-label": "Version history",
    title: "Version history",
    html: svg(VIEWER_IC.restore, 1.7),
  });
  // The BIN-ORIGIN controls, swapped in for Move to bin when the note is open
  // from the recycle bin (`toolbar.md`'s context swap, wired in `open()`). No
  // longer two bare buttons: a trashed file gets the SAME `|— retention —| ⋯`
  // cluster the bin ROW shows, so its controls are identical in either place —
  // the shared `createBinViewerActions` builds the countdown + the "…" menu
  // (Restore neutral, Delete permanently the one red item, its confirm carried
  // through `onPurge`). Hidden by default; a live file never shows it.
  const binActions = createBinViewerActions({
    getMeta: () => meta,
    onRestore: deps.onRestore,
    onPurge: deps.onPurge,
    // Card parity: the bin's "Version history" row opens the SAME view-only panel
    // the Versions toolbar button does, anchored to the "…" trigger. Only wired
    // when the shell can open history at all — no dead row otherwise.
    onHistory: deps.onVersions ? (m, anchor) => deps.onVersions!(m, anchor, undefined) : undefined,
  });

  // --- the "previewing an older version" banner (history mode) --------------
  // Shown ONLY for a `history` origin: a full-width strip under the toolbar that
  // says this is a past version (not the live note) and offers the one action
  // that is safe here — Restore. Read-only otherwise: paging, find, export all
  // work over the version, but nothing on this surface mutates the note except
  // Restore, which is confirmed and undoable (the shell owns that).
  const versionBannerText = el("span", { class: "version-banner__text" });
  const restoreVersionBtn = el("button", {
    class: "btn version-banner__restore",
    type: "button",
    text: "Restore this version",
  }) as HTMLButtonElement;
  const versionBanner = el(
    "div",
    { class: "version-banner", role: "status", hidden: true },
    el("span", { class: "version-banner__badge", "aria-hidden": "true", html: svg(VIEWER_IC.restore, 1.6) }),
    versionBannerText,
    restoreVersionBtn,
  );

  // --- the find bar ---------------------------------------------------------
  // Costs nothing until used, and has room for the counter and the stepping
  // controls a bare field would not.
  const findToggle = el("button", {
    class: "btn",
    type: "button",
    "aria-pressed": "false",
    "aria-label": "Find in this note",
    title: "Find in this note (Ctrl+F)",
    html: svg(VIEWER_IC.find, 1.8),
  });
  const findInput = el("input", {
    type: "text",
    autocomplete: "off",
    placeholder: "Find in this note",
    "aria-label": "Find in this note",
  }) as HTMLInputElement;
  const findCount = el("span", { class: "findbar__count", role: "status", "aria-live": "polite" });
  // Shown only when the ovals CANNOT be drawn: the device's millimetre scale is
  // unverified (`NoteMeta.pxPerMm === null`, the common case) or disagrees with
  // this page. The counter still works — matches are counted server-side from
  // the transcript — so saying nothing would leave a correct count beside a page
  // with no marks on it and no explanation.
  const findNote = el("span", {
    class: "findbar__note",
    hidden: true,
    text: "Match positions aren't available for this device.",
  });
  // Said ONCE, beside the counter, never on each match — the same rule universal
  // search's banner follows. The claim it prevents is the one an approximate
  // answer makes by staying quiet: presenting "witches" as a match for "witchez"
  // as though it were what was asked for.
  const findFuzzy = el("span", {
    class: "findbar__fuzzy",
    role: "status",
    hidden: true,
    text: "No exact match — showing close matches.",
  });
  // The MANUAL-FUZZY OPT-IN affordance (in-doc-search Phase 3, route 2). When the
  // exact find is empty but a typo-tolerant search would find close matches, the
  // bar offers this instead of silently substituting them — a deep link from a
  // global fuzzy hit already carries the resolved term and runs exact, so this is
  // only ever the "I typed a word this note doesn't have" case. Clicking runs the
  // fuzzy result the server already returned (held, not re-fetched).
  const findAsk = el("button", {
    class: "findbar__ask",
    type: "button",
    hidden: true,
    text: "Search similar",
  }) as HTMLButtonElement;
  const findPrev = el("button", {
    class: "icon-btn",
    type: "button",
    "aria-label": "Previous match",
    title: "Previous match",
    html: svg(VIEWER_IC.prev, 1.9),
  }) as HTMLButtonElement;
  const findNext = el("button", {
    class: "icon-btn",
    type: "button",
    "aria-label": "Next match",
    title: "Next match",
    html: svg(VIEWER_IC.next, 1.9),
  }) as HTMLButtonElement;
  const findClose = el("button", {
    class: "icon-btn",
    type: "button",
    "aria-label": "Close find",
    title: "Close find",
    html: svg(VIEWER_IC.close, 1.9),
  });
  const findBar = el(
    "div",
    { class: "findbar" },
    el("span", { class: "findbar__field", html: svg(VIEWER_IC.find, 1.8) }, findInput),
    findCount,
    findAsk,
    findFuzzy,
    findNote,
    findPrev,
    findNext,
    findClose,
  );

  // The toolbar's note-only controls, held as a group so the non-note modes can
  // hide exactly them. A pager over a single image, or a "Recognized text" toggle
  // on a PDF, would be chrome that does nothing — the same species of lie as the
  // blank canvas this change removes.
  const pagerEl = el("div", { class: "pager" }, prev, pagerCount, next);
  // Find reads the RECOGNITION of a `.note`, so it is meaningless over a PDF or
  // an image — absent there rather than present and dead.
  // Zoom is deliberately NOT in here. A scanned page or a screenshot is exactly
  // the thing someone wants to enlarge, and the control already exists — it was
  // hidden only because it lived in the note-only group.
  const noteOnly: HTMLElement[] = [findToggle, ocrToggle, layersToggle, pagesToggle, pagerEl, exportMenu.el];

  // Present only in the non-note modes (image, no-preview). An `<a download>`
  // rather than a button: the browser already knows how to save a URL, and the
  // server answers this one with `Content-Disposition: attachment` regardless of
  // type. ICON-ONLY like the note-mode Download menu trigger above — the label is
  // dropped and `aria-label` + `title` carry the name (without them an icon-only
  // control has no accessible name at all).
  const downloadLink = el("a", {
    class: "btn",
    hidden: true,
    "aria-label": "Download",
    title: "Download",
    html: svg(VIEWER_IC.down, 1.8),
  }) as HTMLAnchorElement;
  downloadLink.download = "";

  const title = header.title;

  // The bar, painted from the shared viewer toolbar (see `pages/toolbar.ts`) so a
  // future `.spd`/`.txt`/image viewer reuses its skeleton and semantics. Back and
  // the title are LEADING — navigation, outside the two zones. The contextual zone
  // maps the reader's view controls in `toolbar.md`'s order (paging, the zoom
  // slot, find, recognised text); the universal zone holds Download — the export
  // menu in note mode, the plain `downloadLink` in the others, mutually hidden by
  // `setMode` — and "Move to bin" beside it. Move to bin is UNIVERSAL (any file
  // type can be trashed), hidden only in the recycle-bin context where the file
  // is already trashed (see `open()`). A future `.spd`/`.txt`/image viewer that
  // shares this bar gets the same two right-zone actions by handing the same
  // `file` array.
  const toolbar = createToolbar({
    label: "Reader controls",
    // "Reading controls", not "View controls": the library's topbar carries a
    // group literally named "View" (the grid/list toggle), and Playwright's
    // accessible-name matching is substring — a zone named "View controls" would
    // collide with the reader tests that assert that topbar group is hidden.
    viewLabel: "Reading controls",
    fileLabel: "File actions",
    className: "reader__bar",
    leading: [{ el: back, focus: [back] }, { el: title }],
    view: [
      { kind: "custom", key: "pager", el: pagerEl, focus: [prev, next] },
      { kind: "custom", key: "zoom", el: zoomStepper.el, focus: zoomStepper.focus },
      { kind: "custom", key: "find", el: findToggle, focus: [findToggle] },
      { kind: "custom", key: "ocr", el: ocrToggle, focus: [ocrToggle] },
      { kind: "custom", key: "layers", el: layersToggle, focus: [layersToggle] },
      // Last in the reading zone, clustered with the other panel toggles (it is a
      // panel toggle, not paging); its panel docks LEFT rather than right.
      { kind: "custom", key: "pages", el: pagesToggle, focus: [pagesToggle] },
    ],
    file: [
      { kind: "custom", key: "versions", el: versionsBtn, focus: [versionsBtn] },
      { kind: "custom", key: "download", el: exportMenu.el, focus: [exportMenu.trigger] },
      { kind: "custom", key: "download-file", el: downloadLink, focus: [downloadLink] },
      { kind: "custom", key: "move-bin", el: moveBin, focus: [moveBin] },
      // The bin-origin cluster (mutually exclusive with Move to bin — see
      // `open()`): the retention countdown then the "…" menu, whose one
      // focusable is its trigger.
      { kind: "custom", key: "bin-actions", el: binActions.el, focus: [binActions.trigger] },
    ],
  });
  const bar = toolbar.el;

  // The bar and the find bar are the reader's HEADER, so they span the whole
  // reader and sit ABOVE the page strip. They used to live inside `reader__main`
  // and therefore began 128px in — starting after the strip rather than over it.
  const root = el(
    "section",
    { class: "reader", "aria-label": "Reader", "aria-hidden": "true" },
    bar,
    versionBanner,
    findBar,
    // The filmstrip is no longer a top-level reader column — it lives inside the
    // "Pages" side panel, docked in `.page-wrap` beside the page (see `stage`).
    el("div", { class: "reader__main" }, stage, fileStage),
  );

  // --- state ---------------------------------------------------------------
  let meta: NoteMeta | null = null;
  /**
   * Which of the three outcomes is on screen. Everything note-shaped — paging,
   * zoom, the filmstrip, the OCR panel, theme repaints — is gated on this, so a
   * stray keypress or a resize can never drive the canvas pipeline over a file
   * that has no pages.
   */
  let mode: FileKind = "note";
  let pageIndex = 0;
  let zoom: Zoom = "Fit";
  let open = false;
  let paintToken = 0;
  /**
   * The file was opened FROM the recycle bin. Held because the raw-bytes URL has
   * to keep saying so after `open()` returns — the image `onerror` fallback and
   * every download href mint the bin-scoped route for a trashed file, whose live
   * twin 404s (see `rawFileUrl`'s `bin` option).
   */
  let fromBin = false;
  /**
   * The retained version being PREVIEWED (history mode), or null on a live open.
   * Held because the Restore button needs its md5 after `open()` returns, and the
   * banner/read-only chrome is gated on it being non-null.
   */
  let previewVersion: { md5: string; createdAt: number } | null = null;
  /**
   * Whether the current history preview is VIEW-ONLY (its file is trashed): the
   * banner's Restore is hidden and the version's raw bytes come from the bin-scoped
   * history route. Set alongside `previewVersion` in `open()`, cleared on close.
   */
  let previewViewOnly = false;
  /**
   * Whether the user WANTS the layers panel open. Kept apart from whether it
   * IS open — the panel shows only while the focused page has a live stack, so
   * paging across a layerless page hides it and paging back restores it,
   * without the toggle forgetting what was asked for. View-only, per file.
   */
  let layersPanelOpen = false;
  /**
   * Whether the user WANTS the page index open. Distinct from the panel's actual
   * visibility (which also needs `mode === "note"`), exactly like `layersPanelOpen`.
   * Defaults to OPEN — the page index is the reader's primary navigation — and is
   * only forced shut by {@link relieveDoubleSqueeze} on a stage too narrow to hold
   * both docks. A different note reopens it (see `open()`), the panel-family rule
   * that each file starts in its default panel state.
   */
  let pageIndexOpen = true;

  /**
   * Stale hashes already acted on. A STALE_PAGE refetch produces a *new* set of
   * hashes; if the server is still 404ing them we must not spin — one metadata
   * refetch per stale hash is the whole loop guard.
   */
  const staleHandled = new Set<Hash>();

  // --- the URL, which describes where you are ------------------------------
  //
  // The page on screen and the find query are both in the route, and both are
  // written with `replaceState` (the shell's `onPosition` does the writing — see
  // `router.replaceNotePosition`). Reading is not navigating: the URL follows the
  // reader so a reload, a copy or a re-dispatch lands here, but Back stays one
  // step out of the note however far you read.
  //
  // SUSPENDED THROUGH `open()`. That method rebuilds the world in a fixed order —
  // `find.reset()`, then the page list, then the query it was asked to prime —
  // and each of those steps would otherwise report an intermediate position. The
  // one that bites is `find.reset()`: it would publish an empty query for a note
  // whose route carries `?q=`, wiping the search a moment before priming it.
  let urlSuspended = false;
  let urlTimer: ReturnType<typeof setTimeout> | undefined;

  /** What the URL should say the search is: nothing at all while the bar is shut. */
  function urlQuery(): string {
    return find.isOpen() ? findInput.value.trim() : "";
  }

  /**
   * A route's `?q=` as find will actually treat it — trimmed, so `?q=%20` is "no
   * search" rather than a search for a space. Sharing the trim with
   * {@link urlQuery} is what keeps a primed reader from immediately rewriting the
   * URL it was opened with.
   */
  function findQuery(raw: string): string {
    return raw.trim();
  }

  function syncUrl(): void {
    if (urlTimer !== undefined) {
      clearTimeout(urlTimer);
      urlTimer = undefined;
    }
    if (!open || urlSuspended || !meta) return;
    // NOTE mode publishes the page. A BIN-origin open publishes the deep
    // `#/bin/note/:id/page/:n` form (the `bin` flag) — its blob is NOT at the live
    // `#/note/:id` route, so writing that address would make a reload 404 to the
    // library; the bin URL makes a reload reopen the SAME trashed file at its page.
    // No find query rides a bin URL. Otherwise: a history preview rides the
    // version's md5 (the `#/note/:id/version/:short` form); a live open passes
    // neither flag and gets the bare note URL + `?q=`.
    if (mode === "note") {
      if (fromBin) {
        deps.onPosition?.(meta.id, pageIndex, "", undefined, true);
        return;
      }
      deps.onPosition?.(meta.id, pageIndex, urlQuery(), previewVersion?.md5);
      return;
    }
    // An IMAGE has no page or query to publish — but a trashed image opened from
    // the bin still owns a `#/bin/note/:id` address (page 0, the `bin` flag), and
    // an image opened as a history PREVIEW owns a `#/note/:id/version/:short` one
    // (the version md5). A LIVE image has nothing to sync and keeps the bare note
    // URL the route already carries.
    if (mode === "image") {
      if (fromBin) {
        deps.onPosition?.(meta.id, 0, "", undefined, true);
        return;
      }
      if (previewVersion) deps.onPosition?.(meta.id, 0, "", previewVersion.md5);
    }
  }

  /**
   * The same sync, DEBOUNCED — for the find field only. Typing "witches" is one
   * intent, and rewriting the address bar seven times for it is thrash. It cannot
   * pollute history either way (replace, not push); the debounce is about the
   * URL settling on what was meant rather than on every prefix of it.
   */
  function queueUrlSync(): void {
    if (urlTimer !== undefined) clearTimeout(urlTimer);
    urlTimer = setTimeout(() => {
      urlTimer = undefined;
      syncUrl();
    }, VIEWER_DEBOUNCE_MS);
  }

  /**
   * A versioned page URL 404'd: the note changed under us and our `?v=` hashes
   * are history. Refetch the metadata (the client contract's promised response to
   * STALE_PAGE) and rebuild off the fresh hashes.
   */
  async function refetchMeta(noteId: Id, page: PageRef): Promise<void> {
    if (staleHandled.has(page.hash)) return;
    staleHandled.add(page.hash);
    let fresh: NoteMeta;
    try {
      fresh = await api.getNoteMeta(noteId);
    } catch (e) {
      dispatchApiFailure({ onSessionExpired: deps.onSessionExpired }, e);
      return;
    }
    if (!open || meta?.id !== noteId) return; // closed / moved on while fetching
    meta = fresh;
    // New hashes mean the cached word boxes are history — `setNote` drops them.
    find.setNote(fresh.id, fresh.pages);
    buildFilmstrip();
    void showPage(pageIndex);
  }

  const failures: ApiFailureSink = {
    onSessionExpired: () => deps.onSessionExpired(),
    onStalePage: (noteId, page) => void refetchMeta(noteId, page),
  };

  // --- recognized text ------------------------------------------------------
  // The controller owns the fetch/race/state logic (see ocrPanel.ts); this view
  // is only the DOM half of it.
  const OCR_MESSAGE: Record<Exclude<OcrState["kind"], "text">, string> = {
    loading: "Loading recognized text…",
    empty: "No recognized text on this page.",
    error: "Couldn't load the recognized text. Change page to try again.",
  };

  const ocr = createOcrController({
    api,
    // The same sink the filmstrip and the viewer use: an expired session reaches
    // the shell, a stale `?v=` refetches the note metadata. Never a bare catch.
    failures,
    view: {
      setOpen(isOpen) {
        ocrPanel.setOpen(isOpen);
        ocrToggle.setAttribute("aria-pressed", String(isOpen));
      },
      setToggleEnabled(enabled) {
        ocrToggle.disabled = !enabled;
        ocrToggle.title = enabled ? "Recognized text" : "This page has no recognized text";
      },
      setState(state) {
        if (state.kind === "text") {
          // `.ocr__body` is `white-space: pre-wrap`, so the transcript's own line
          // breaks survive. textContent (not innerHTML) — the transcript is user
          // content off a device, never markup.
          ocrBody.textContent = state.text;
          return;
        }
        // The SHARED state line (loading / empty / error) — the same "still
        // loading / nothing here / that failed" treatment every docked panel
        // speaks (src/ui/sidePanel.ts), only the wording is the OCR panel's.
        ocrBody.replaceChildren(sidePanelState(state.kind, OCR_MESSAGE[state.kind]));
      },
      // Opening/closing the panel changes the stage width the page is sized
      // against, so the canvas has to be re-measured and repainted.
      relayout: () => void showPage(pageIndex),
    },
  });

  // --- find in note ---------------------------------------------------------
  // The controller owns the two-phase fetch/race/state logic (see findInNote.ts);
  // this is only the DOM half of it — the counter's words, the ovals, and the
  // filmstrip badges.

  /**
   * What the counter says. THE TWO COPY DECISIONS THIS FEATURE TURNS ON LIVE
   * HERE, and neither is interchangeable with the other:
   *
   *  - `unrecognised` says "Not recognised on the device", NEVER "No matches".
   *    A word the device never recognised is invisible to find even though it is
   *    plainly on the page; "no matches" would assert that a search happened.
   *  - `counting` shows NO TOTAL. `1 of 12` is a claim about the whole note, and
   *    a total that quietly revises itself is how a search loses trust — so it
   *    says what it actually knows, which is this page plus "still counting".
   */
  function countText(state: FindState): string {
    switch (state.kind) {
      case "idle":
        return "";
      case "unrecognised":
        return "Not recognised on the device";
      case "counting": {
        const n = state.recognisedPages;
        const here = state.onThisPage > 0 ? `${state.onThisPage} on this page · ` : "";
        return `${here}searching ${n} ${n === 1 ? "page" : "pages"}…`;
      }
      case "streaming":
        // A FLOOR while the note is still draining — "3 of 20+", the browser
        // Ctrl+F shape. It settles to the exact `${at+1} of ${total}` the moment
        // the last batch lands (a finite note always reaches exact).
        return `${state.at + 1} of ${state.total}+`;
      case "settled":
        return `${state.at + 1} of ${state.total}`;
      case "fuzzyPrompt":
        return "No matches";
      case "empty":
        return "No matches";
      case "error":
        return "Couldn't search this note. Keep typing to retry.";
    }
  }

  /** The dimmer treatment: every state that is not a live count of matches. A
   *  streaming floor IS a live count, so it reads at full weight like a settle. */
  function countIsNone(state: FindState): boolean {
    return state.kind !== "settled" && state.kind !== "streaming" && state.kind !== "idle";
  }

  /**
   * Draw the ovals over the page. Always rebuilt rather than diffed: a repaint
   * follows a re-measure, and the previous set's pixel positions belong to the
   * page's previous size.
   *
   * THE OVALS ARE PER-PAGE, AND THAT IS NOT AN OVERSIGHT. Find is note-wide
   * everywhere it is cheap to be: the counter spans the note, prev/next step
   * across page boundaries, and the filmstrip badges show the distribution
   * through the whole notebook — all from ONE note-scoped query. The ink marks
   * are the other half of the two-phase cost model: a rectangle needs
   * `getPageText`, so drawing them "everywhere" would be one request per page and
   * a 200-page notebook would fire 200 of them at a server that serialises on a
   * coarse `db_lock` — a find starving the pages being read. So the counter and
   * the badges describe the note; the ovals describe the page in front of you.
   *
   * Making the search addressable does not change this. `?q=` restores which
   * search is running, not a note's worth of rectangles.
   */
  function paintOvals(words: WordBox[], current: number): void {
    for (const old of Array.from(pageEl.querySelectorAll(".findbox"))) old.remove();
    const m = meta;
    if (!m) return;
    const page = m.pages[pageIndex];
    if (!page) return;

    const ovals = ovalsFor(words, m.pxPerMm, page.width, pageEl.clientWidth, pageEl.clientHeight);
    // NULL = the millimetre scale is unverified (the common case) or disagrees
    // with this page. Drawing anyway would put loops confidently round the wrong
    // words, so nothing is drawn — and because the COUNTER still works (matches
    // are counted server-side, from the transcript), the bar has to say why the
    // page carries no marks. Evaluated even for an empty match set, so the
    // explanation does not blink in and out as you page.
    findNote.hidden = ovals !== null;
    if (ovals === null) return;

    for (const [i, oval] of ovals.entries()) {
      const box = el("div", {
        class: i === current ? "findbox is-current" : "findbox",
        html: `<svg viewBox="${OVAL_VIEWBOX}" preserveAspectRatio="none" aria-hidden="true"><path d="${oval.path}"/></svg>`,
      });
      box.style.left = `${oval.left}px`;
      box.style.top = `${oval.top}px`;
      box.style.width = `${oval.width}px`;
      box.style.height = `${oval.height}px`;
      box.style.transform = `rotate(${oval.rotateDeg}deg)`;
      pageEl.append(box);
    }
  }

  /**
   * The filmstrip badges — the distribution of matches through the notebook, at
   * a glance, on UI that already exists.
   *
   * They anchor to `.filmstrip__page`, which is `position: relative` in the
   * stylesheet FOR THIS REASON. Without it they resolve against a distant
   * positioned ancestor and stack in the window corner: correct counts in the
   * DOM, nothing visible where they belong.
   */
  function paintBadges(counts: ReadonlyMap<number, number>): void {
    if (!filmVirtualList) return;
    for (const [i, btn] of filmVirtualList.getRenderedItems()) {
      btn.querySelector(".filmstrip__hits")?.remove();
      const n = counts.get(i);
      if (!n) continue;
      const label = `${n} ${n === 1 ? "match" : "matches"} on page ${i + 1}`;
      btn.append(el("span", { class: "filmstrip__hits", text: String(n), title: label }));
    }
  }

  /**
   * The counts currently on the filmstrip. Held because `buildFilmstrip`
   * REPLACES every button — on open, and on a STALE_PAGE metadata refetch that
   * can land mid-find — and the badges hang off the buttons it threw away.
   */
  let lastBadges: ReadonlyMap<number, number> = new Map();

  const find = createFindController({
    api,
    // The same sink everything else in this reader uses: an expired session
    // reaches the shell, a stale `?v=` refetches the note metadata.
    failures,
    view: {
      setOpen(isOpen) {
        root.classList.toggle("is-finding", isOpen);
        findToggle.setAttribute("aria-pressed", String(isOpen));
      },
      setState(state) {
        findCount.textContent = countText(state);
        findCount.classList.toggle("is-none", countIsNone(state));
        // Only a settled answer can be an approximate one. `empty`/`fuzzyPrompt`
        // deliberately do not say it: "No matches" is the whole answer there, and
        // adding "these are close matches" to a result set of nothing is noise.
        findFuzzy.hidden = !(state.kind === "settled" && state.fuzzy);
        // The opt-in affordance appears in exactly one state: the exact find is
        // empty AND a typo-tolerant one would find something. Clicking it reveals
        // the held fuzzy result (no re-fetch).
        findAsk.hidden = state.kind !== "fuzzyPrompt";
        // The "no verified scale" aside only ever applies while something is
        // being looked for.
        if (state.kind === "idle" || state.kind === "unrecognised") findNote.hidden = true;
      },
      setPageMatches: paintOvals,
      setPageCounts(counts) {
        lastBadges = counts;
        paintBadges(counts);
      },
      showPage: (index) => goToPage(index),
      setStepEnabled(enabled) {
        findPrev.disabled = !enabled;
        findNext.disabled = !enabled;
      },
      focusField() {
        findInput.focus();
        findInput.select();
      },
    },
  });

  // --- the Export menu ------------------------------------------------------
  //
  // The mockup's four entries, one of which cannot be produced honestly yet and
  // is therefore rendered DISABLED WITH A REASON rather than omitted or, worse,
  // wired to something that fakes the format. A disabled entry that says why is
  // information; an entry that produces a raster and calls it a vector is not.
  const exporter: Exporter = createExporter({ api, renderer });

  /** An enabled menu row (label + ext) — the shared mechanics close the menu and
   *  run it disabled-meanwhile, toasting on failure. */
  const menuItem = exportMenu.item;

  async function exportDocumentPdf(): Promise<void> {
    const m = meta;
    if (!m || m.pages.length === 0) return;
    // PROGRESS THAT ONLY CLAIMS WHAT IT KNOWS: which page is being decoded, out
    // of how many. No percentage of *time* and no spinner pretending to move —
    // the per-page cost varies with the ink on it, and the compression step is
    // not something this can see inside.
    const { blob, filename, kind } = await exporter.documentPdf(m, (done, total) =>
      deps.toast(`Exporting ${m.name} — page ${done} of ${total}…`),
    );
    download(filename, blob);
    deps.toast(
      kind === "searchable"
        ? `Saved ${filename} — ${m.pages.length} pages, text on recognised pages is selectable`
        : `Saved ${filename} — ${m.pages.length} pages, image only (no verified text placement for this device)`,
    );
  }

  // THE PER-VIEW EXPORTS of the current page — Flat PNG, Layered ORA and (new)
  // per-page PDF, each in a `current` or `original` view. The model is decoded
  // FRESH in light form (`exportModel`) so a dark-themed screen never inverts an
  // export; `current` reads the panel's live visibility, `original` the
  // device-authored state — a device-hidden layer rides an "original" export with
  // full pixels, marked invisible. Where a page has NO layer stack (a v1 or
  // single-composite page) "current view" IS the composite, so PNG and PDF fall
  // back to the plain page export; the layered-only ORA is not offered there (its
  // row hides), and "original" is never offered without a stack (its whole menu
  // group hides), so only "current" ever reaches a fallback.

  async function exportViewPng(which: ExportWhich): Promise<void> {
    const m = meta;
    const page = currentPage();
    if (!m || !page) return;
    const snapshot = await noteLayerCtl.exportModel();
    if (!snapshot) {
      const { blob, filename } = await exporter.pagePng(m, page);
      download(filename, blob);
      deps.toast(`Saved ${filename}`);
      return;
    }
    try {
      const blob = await exportFlatPng(snapshot.model, which);
      const filename = noteLayerExportFilename(m.name, page.index, which, "png");
      download(filename, blob);
      deps.toast(`Saved ${filename}`);
    } finally {
      snapshot.release();
    }
  }

  async function exportViewOra(which: ExportWhich): Promise<void> {
    const m = meta;
    const page = currentPage();
    if (!m || !page) return;
    const snapshot = await noteLayerCtl.exportModel();
    if (!snapshot) return; // ORA needs a stack; its row is hidden without one
    try {
      const blob = await exportOra(snapshot.model, which);
      const filename = noteLayerExportFilename(m.name, page.index, which, "ora");
      download(filename, blob);
      deps.toast(`Saved ${filename}`);
    } finally {
      snapshot.release();
    }
  }

  /**
   * The per-page PDF — NEW. It reuses the whole PDF pipeline (export/pdf.ts: the
   * raster plus the INVISIBLE searchable OCR layer) scoped to ONE page. With a
   * stack it flattens the chosen view onto a WHITE sheet (PDF has no alpha, so an
   * unfilled transparent flatten would gray to black) at the model's EFFECTIVE
   * dims — a landscape page's model is 1872×1404, so the PDF is wide, not sheared
   * — and hands that image to `pagePdfFromImage`. The OCR text layer is
   * positional, so `current` and `original` carry the SAME selectable words over
   * different pixels. With no stack it is the composite page PDF (current ==
   * composite).
   */
  async function exportViewPdf(which: ExportWhich): Promise<void> {
    const m = meta;
    const page = currentPage();
    if (!m || !page) return;
    const say = (filename: string, kind: "searchable" | "raster") =>
      // SAY WHICH ONE THEY GOT. A searchable PDF and a raster-only one look
      // identical until someone tries to select text, and the difference is
      // decided by whether this device's millimetre scale has been verified.
      deps.toast(
        kind === "searchable"
          ? `Saved ${filename} — text is selectable`
          : `Saved ${filename} — image only (no verified text placement for this device)`,
      );
    const snapshot = await noteLayerCtl.exportModel();
    if (!snapshot) {
      const { blob, filename, kind } = await exporter.pagePdf(m, page);
      download(filename, blob);
      say(filename, kind);
      return;
    }
    try {
      const image = flattenLayers(snapshot.model, which, { background: "#ffffff" });
      const { blob, kind } = await exporter.pagePdfFromImage(m, page, image);
      const filename = noteLayerExportFilename(m.name, page.index, which, "pdf");
      download(filename, blob);
      say(filename, kind);
    } finally {
      snapshot.release();
    }
  }

  // THE DOWNLOAD MENU — three groups (the settled structure):
  //   THIS PAGE — CURRENT VIEW · THIS PAGE — ORIGINAL VIEW · WHOLE NOTEBOOK
  // `.menu__head` uppercases in CSS, so the natural-case text here renders as the
  // headers shown. The per-page rows adapt to the focused page (see the export
  // functions above): with a live stack they flatten the chosen VIEW; with none,
  // "current view" is the composite and the layered-only rows fold away.

  // The layered-only CURRENT row (ORA). Held apart from its group because it — and
  // it alone in the CURRENT group — hides on a page with no stack: an ORA of a
  // single composite has nothing to layer, whereas the Flat PNG and PDF beside it
  // fall back to the composite and stay.
  const currentOraItem = menuItem("Layered image", ".ora", () => exportViewOra("current"));
  const currentGroup = el(
    "div",
    {},
    el("div", { class: "menu__head", text: "This page — Current view" }),
    menuItem("Flattened image", ".png", () => exportViewPng("current")),
    currentOraItem,
    menuItem("PDF document", ".pdf", () => exportViewPdf("current")),
  );

  // The WHOLE ORIGINAL group hides unless a layer's live visibility differs from
  // its device-authored state (refreshExportGroups flips it): with nothing toggled
  // current view == original view and the exports would be byte-identical, so a
  // second header over duplicate rows is noise.
  const originalGroup = el(
    "div",
    { hidden: true },
    el("div", { class: "menu__sep" }),
    el("div", { class: "menu__head", text: "This page — Original view" }),
    menuItem("Flattened image", ".png", () => exportViewPng("original")),
    menuItem("Layered image", ".ora", () => exportViewOra("original")),
    menuItem("PDF document", ".pdf", () => exportViewPdf("original")),
  );

  // The raw ".note" download — the one non-transformed option, like the
  // `.spd`/`.txt` viewers' raw row. The shared mechanics navigate to the href
  // (its Content-Disposition names it); the href is minted per open (bin-scoped
  // for a trashed file), and `null` disables the row.
  const rawNoteItem = exportMenu.rawItem("Supernote", ".note");

  const wholeGroup = el(
    "div",
    {},
    el("div", { class: "menu__sep" }),
    el("div", { class: "menu__head", text: "Whole notebook" }),
    menuItem("PDF document", ".pdf", exportDocumentPdf),
    rawNoteItem.el,
  );

  exportMenu.pop.append(currentGroup, originalGroup, wholeGroup);

  const filmEngine: LazyEngine = createLazyEngine({
    api,
    renderer,
    cache,
    getTheme,
    // The SCROLL container is the panel now (`.side-panel` owns the overflow), so
    // the IntersectionObserver root is the panel, not the inner rail — otherwise a
    // non-scrolling rail would report every thumbnail on screen at once and defeat
    // the lazy paint. The rail's `.filmstrip__page` targets sit inside it.
    root: pageIndexPanel.el,
    failures,
  });

  function currentPage(): PageRef | undefined {
    return meta?.pages[pageIndex];
  }

  // --- the two non-note stages ---------------------------------------------

  /** Point the toolbar's download control at `url` (hidden when there is none). */
  function setDownload(url: string | null): void {
    downloadLink.hidden = url === null;
    if (url !== null) downloadLink.href = url;
  }

  /**
   * The honest "no preview" state: what the file is, how big it is, and a way to
   * get it. `title`/`body` vary so a failed image load says so rather than
   * pretending the type was never previewable.
   */
  function showNoPreview(m: NoteMeta, title: string, body: string): void {
    fileImg.hidden = true;
    fileImg.removeAttribute("src"); // stop a pending load painting over this
    fileBody.hidden = false;
    const download = rawFileUrl(m.id, m.fileHash, { download: true, bin: fromBin });
    fileBody.replaceChildren(
      el("div", { class: "empty__mark", text: m.fileType.toUpperCase() }),
      // Device-authored: textContent, like every other name on this surface.
      el("h3", { text: title }),
      el("p", { text: body }),
      ...(download
        ? [el("a", { class: "btn filestage__download", href: download, download: "", html: svg(VIEWER_IC.down, 1.8) + "Download" })]
        : []),
    );
  }

  /** Image mode: hand the bytes to the browser and let it do the work. */
  function showImage(m: NoteMeta, url: string): void {
    fileBody.hidden = true;
    fileBody.replaceChildren();
    fileImg.hidden = false;
    // Empty alt: the file's name is already the reader's heading, so announcing
    // it again here would be a duplicate rather than a description. The image is
    // the content, not an illustration of it.
    fileImg.alt = "";
    fileImg.src = url;
    // An <img> error carries no status and throws no ApiError, so there is
    // nothing for `dispatchApiFailure` to classify — this is not a swallowed
    // failure, it is the one failure on this surface the sink cannot type. Fall
    // back to the same honest state the other files get, which still offers the
    // download, rather than leaving a broken-image glyph.
    fileImg.onerror = () => {
      if (meta?.id !== m.id) return; // moved on while loading
      showNoPreview(m, m.name, "Couldn't load a preview of this image. You can still download it.");
    };
  }

  /** Enter (or leave) a non-note mode: swap stages and prune the toolbar. */
  function setMode(next: FileKind): void {
    mode = next;
    const isNote = next === "note";
    stage.hidden = !isNote;
    fileStage.hidden = isNote;
    // The page index rides inside the stage now, so hiding the stage already
    // removes it; this keeps the toggle's pressed/expanded state honest and the
    // panel shut for a non-note (it has no pages to index).
    refreshPageIndexUi();
    for (const control of noteOnly) control.hidden = !isNote;
    // Shown for a note and for an image; a file with no preview has nothing to
    // scale, so it stays hidden there.
    zoomEl.hidden = !(isNote || next === "image");
    if (next === "image") sizeImage();

    // A non-note mode has no layers; drop the stack and let the affordances
    // follow (the toggle is already hidden with the rest of `noteOnly`).
    if (!isNote) noteLayerCtl.release();
    refreshLayersUi();

    // Find searches the DEVICE's recognition, so a note carrying none cannot be
    // searched at all and the control would promise a search that can only
    // answer "nothing". `textHash !== null` is that signal and it rides on the
    // page list, so this costs no request. Note-wide, unlike the transcript
    // toggle, which is per page.
    const searchable = isNote && (meta?.pages.some((pg) => pg.textHash !== null) ?? false);
    findToggle.disabled = !searchable;
    findToggle.title = searchable ? "Find in this note" : "This note has no recognised text to search";
  }

  // --- the page-index panel (docked LEFT, open by default) ------------------

  /**
   * The minimum page width the two-sided layout must leave. Below it, opening a
   * right-hand tool collapses the left page index rather than squeeze the page
   * from both sides. Tuned to the stage's own sizes: at the ~1048px stage of a
   * default desktop a single dock plus the page index leaves ~412px and they
   * coexist; on the ~960px stage of a smaller window that drops to ~324px, below
   * this floor, so the page index yields to the tool the user just opened. Two
   * docks always trip it.
   */
  const MIN_PAGE_W = 360;

  /** The width one open RIGHT dock (OCR) or the wider Layers dock takes, gap
   *  included — the same tokens `showPage` subtracts, so nothing is hand-synced. */
  function rightPanelsWidth(): number {
    const gap = tokenPx("--panel-gap", 22);
    const ocrW = ocr.isOpen() ? tokenPx("--panel-w", 268) + gap : 0;
    const layersW =
      layersPanelOpen && noteLayerCtl.stack() !== null ? tokenPx("--panel-w-wide", 320) + gap : 0;
    return ocrW + layersW;
  }

  /** True when the page index plus the currently-open right dock(s) would leave
   *  the page below {@link MIN_PAGE_W}. */
  function bothSidesTooTight(): boolean {
    const leftW = tokenPx("--panel-w-narrow", 180) + tokenPx("--panel-gap", 22);
    return stage.getBoundingClientRect().width - 56 - leftW - rightPanelsWidth() < MIN_PAGE_W;
  }

  /**
   * Reconcile the page-index toggle + panel visibility with the open intent and
   * the mode — the mirror of {@link refreshLayersUi} for this panel. The panel
   * shows only for a `.note`; a non-note mode has no pages to index.
   */
  function refreshPageIndexUi(): void {
    const shown = mode === "note" && pageIndexOpen;
    pageIndexPanel.setOpen(shown);
    pagesToggle.setAttribute("aria-pressed", String(shown));
    pagesToggle.setAttribute("aria-expanded", String(shown));
  }

  /** Set the page-index open intent and relay out (the panel takes stage width,
   *  so the page is re-measured — the same rule the right panels follow). */
  function setPageIndexOpen(next: boolean): void {
    if (pageIndexOpen === next) return;
    pageIndexOpen = next;
    refreshPageIndexUi();
    void showPage(pageIndex);
  }

  /** Never squeeze the page from both sides: when a RIGHT tool has just opened on
   *  a stage too narrow to hold both docks, collapse the LEFT page index. */
  function relieveDoubleSqueeze(): void {
    if (pageIndexOpen && mode === "note" && bothSidesTooTight()) setPageIndexOpen(false);
  }

  /** Close whatever right dock is open — the symmetric half of the one-open-per-
   *  side rule, used when the page index is re-opened on a narrow stage so it too
   *  never leaves the page squeezed between both. */
  function collapseRightPanels(): void {
    if (ocr.isOpen()) ocr.toggle();
    if (layersPanelOpen) {
      layersPanelOpen = false;
      refreshLayersUi();
    }
  }

  // --- the layers panel + stack (see pages/noteLayers.ts) -------------------

  /**
   * Reconcile every layers-affordance with the live stack: the toggle's
   * enabled/pressed state, the panel's rows and visibility, the export menu's
   * layered matrix. Called from every path that can change the stack — a page
   * turn, a decode failure's fallback, a mode change, teardown — so the
   * affordances can never describe a stack that is not on screen.
   */
  function refreshLayersUi(): void {
    const stack = noteLayerCtl.stack();
    const has = stack !== null && mode === "note";
    layersToggle.disabled = !has;
    layersToggle.title = has ? "Layers" : "This page has no layers";
    if (has) layersPanel.setLayers(toPanelLayers(stack.views));
    const open = has && layersPanelOpen;
    layersPanel.el.hidden = !open;
    layersToggle.setAttribute("aria-pressed", String(open));
    layersToggle.setAttribute("aria-expanded", String(open));
    refreshExportGroups();
  }

  /**
   * Reconcile the download menu's per-page groups with the live stack — split out
   * from {@link refreshLayersUi} because a LAYER TOGGLE (the panel's eye) must
   * update the Original group's visibility WITHOUT rebuilding the panel's own rows.
   *
   *  - the CURRENT group's ORA row needs a stack (nothing to layer in a composite),
   *    so it hides without one; the Flat PNG / PDF rows stay (composite fallback);
   *  - the ORIGINAL group appears only once a layer's live visibility differs from
   *    its device-authored state — until then current == original and its exports
   *    would be byte-identical.
   */
  function refreshExportGroups(): void {
    const stack = noteLayerCtl.stack();
    const has = stack !== null && mode === "note";
    currentOraItem.hidden = !has;
    const toggled = stack !== null && mode === "note" && stack.views.some((v) => v.visible !== v.authoredVisible);
    originalGroup.hidden = !toggled;
  }

  /**
   * Try the per-layer stacked path for the focused page. True = the stack is
   * up (composite paint skipped); false = degrade to the composite — for a
   * hostile payload, a slot mismatch, a stale wasm, any decode failure. The
   * same-key-same-theme short-circuit is what makes zoom/panel relayouts and
   * repeat showPage calls free: the native-res canvases scale in CSS.
   */
  async function presentLayers(noteId: Id, page: PageRef, vos: PageLayer[], token: number): Promise<boolean> {
    const theme = getTheme();
    if (noteLayerCtl.isPresented(page.hash, theme)) {
      refreshLayersUi();
      return true;
    }
    try {
      const bytes = await api.getPageBytes(noteId, page);
      if (token !== paintToken) return false;
      const stack = await noteLayerCtl.present(noteId, page.hash, bytes, vos, theme);
      if (token !== paintToken) return false;
      if (stack) {
        refreshLayersUi();
        return true;
      }
    } catch (e) {
      // An expired session / stale `?v=` still reaches the shell — the layered
      // path must not swallow the signals the composite path reports.
      dispatchApiFailure(failures, e, noteId, page);
    }
    noteLayerCtl.release();
    refreshLayersUi();
    return false;
  }

  async function showPage(index: number): Promise<void> {
    if (!meta || mode !== "note") return;
    pageIndex = Math.max(0, Math.min(meta.pages.length - 1, index));
    const page = meta.pages[pageIndex];
    if (!page) return;

    if (filmVirtualList) {
      for (const [i, btn] of filmVirtualList.getRenderedItems()) {
        btn.setAttribute("aria-current", String(i === pageIndex));
      }
    }
    pagerCount.textContent = `${pageIndex + 1} / ${meta.pages.length}`;

    // Size the page: fit the stage height (or a zoom step), clamp to width.
    const rect = stage.getBoundingClientRect();
    const aspect = page.width / page.height;
    let h = Math.min(Math.max(rect.height - 56, 120), 1000);
    if (zoom !== "Fit") h = 640 * ZOOM_SCALE[zoom];
    let w = h * aspect;
    // The recognized-text aside shares the stage, so its width is not the page's
    // — and the layers panel, when open over a live stack, takes its slice too.
    // Both widths and the gap are read straight off the layout's own tokens, so
    // this can never subtract a stale number (see `tokenPx`).
    const gap = tokenPx("--panel-gap", 22);
    const ocrW = ocr.isOpen() ? tokenPx("--panel-w", 268) + gap : 0;
    const layersW =
      layersPanelOpen && noteLayerCtl.stack() !== null ? tokenPx("--panel-w-wide", 320) + gap : 0;
    // The page index docks on the LEFT and takes its slice too — the NARROW track
    // (a thumbnail column, not a text panel), read off the live layout (see
    // `tokenPx`), so nothing is hand-synced.
    const pagesW = pageIndexOpen ? tokenPx("--panel-w-narrow", 180) + gap : 0;
    const maxW = Math.max(rect.width - 56 - ocrW - layersW - pagesW, 80);
    if (w > maxW) {
      w = maxW;
      h = w / aspect;
    }
    pageEl.style.width = `${Math.round(w)}px`;
    pageEl.style.height = `${Math.round(h)}px`;
    pageWrap.style.height = `${Math.round(h)}px`;

    // Refresh the toggle's enabled state and, while the panel is open, its body.
    // Doing it here means every path that changes page — pager, filmstrip,
    // keyboard, a STALE_PAGE refetch — keeps the panel in sync for free.
    ocr.setPage(meta.id, page);
    // Same reasoning for find: every path that changes page routes through here,
    // so the ovals follow the page for free. It is called AFTER `pageEl` has been
    // resized above, because the boxes are laid out in the page's current pixels.
    find.setPage(pageIndex);

    const token = ++paintToken;
    const noteId: Id = meta.id;

    // Immediately draw the thumbnail (if available) stretched and blurred,
    // or clear the canvas so the previous page doesn't linger.
    let thumbDrawn = false;
    if (filmVirtualList) {
      let btn: HTMLElement | undefined;
      for (const [i, el] of filmVirtualList.getRenderedItems()) {
        if (i === pageIndex) {
          btn = el;
          break;
        }
      }
      if (btn) {
        const thumbCanvas = btn.querySelector("canvas");
        if (thumbCanvas && thumbCanvas.width > 0 && thumbCanvas.height > 0) {
          const dpr = Math.min(typeof devicePixelRatio !== "undefined" ? devicePixelRatio : 1, DPR_CAP);
          pageCanvas.width = Math.round(w * dpr);
          pageCanvas.height = Math.round(h * dpr);
          const ctx = pageCanvas.getContext("2d");
          if (ctx) {
            ctx.drawImage(thumbCanvas, 0, 0, pageCanvas.width, pageCanvas.height);
            pageCanvas.classList.add("is-loading");
            thumbDrawn = true;
          }
        }
      }
    }
    if (!thumbDrawn) {
      pageCanvas.classList.remove("is-loading");
      const ctx = pageCanvas.getContext("2d");
      if (ctx) ctx.clearRect(0, 0, pageCanvas.width, pageCanvas.height);
    }

    // THE LAYERED PATH — only for a page whose meta carries layers, and only
    // for THE focused page (filmstrip/thumbnails/neighbours keep the composite,
    // by scope pin). On success the stack replaces the composite canvas; on ANY
    // failure the composite below paints exactly as it always has.
    const vos = page.layers ?? null;
    let layeredUp = false;
    if (page.hash !== "" && vos !== null && vos.length > 0) {
      layeredUp = await presentLayers(noteId, page, vos, token);
      if (token !== paintToken) return; // a newer showPage superseded us
    } else {
      noteLayerCtl.release();
      refreshLayersUi();
    }
    // One of the two paints owns the page; `hidden` keeps the other out of the
    // way without dropping its element (the stack host hides itself when empty).
    pageCanvas.hidden = layeredUp;
    if (layeredUp) pageCanvas.classList.remove("is-loading");

    if (!layeredUp && page.hash !== "") {
      try {
        const bitmap = await renderPage({ api, renderer, cache, theme: getTheme() }, noteId, page, "full");
        if (token !== paintToken) return; // a newer showPage superseded us
        const dpr = Math.min(typeof devicePixelRatio !== "undefined" ? devicePixelRatio : 1, DPR_CAP);
        pageCanvas.width = Math.round(w * dpr);
        pageCanvas.height = Math.round(h * dpr);
        const ctx = pageCanvas.getContext("2d");
        if (ctx) {
          ctx.drawImage(bitmap, 0, 0, pageCanvas.width, pageCanvas.height);
          pageCanvas.classList.remove("is-loading");
        }
      } catch (e) {
        // Leave the previous paint; the cache is never a source of truth. An
        // expired session or a stale `?v=` is not a paint failure though — those
        // go to the sink so the shell re-auths / we refetch the note metadata.
        dispatchApiFailure(failures, e, noteId, page);
      }
    }

    // Warm the neighbours so paging is instant.
    for (const j of [pageIndex - 1, pageIndex + 1]) {
      const neighbour = meta.pages[j];
      if (neighbour) filmEngine.prefetch(noteId, neighbour, "full");
    }

    filmVirtualList?.scrollIntoView(pageIndex);
  }

  /**
   * Every path that changes page funnels through `showPage`, so publishing the
   * position from ONE place after it — rather than from the pager, the filmstrip,
   * the keyboard, a step across a page boundary and a STALE_PAGE repaint
   * separately — is what keeps the URL and the screen from drifting apart.
   *
   * Wrapped rather than folded into `showPage` because `showPage` is async and
   * awaits a bitmap: the URL should follow the page turn, not the paint.
   */
  function goToPage(index: number): void {
    void showPage(index);
    syncUrl();
  }

  let filmVirtualList: VirtualList | null = null;

  function buildFilmstrip(): void {
    filmEngine.reset();
    if (filmVirtualList) {
      filmVirtualList.destroy();
      filmVirtualList = null;
    }
    if (!meta) {
      filmstrip.replaceChildren();
      return;
    }
    
    filmVirtualList = new VirtualList({
      scrollContainer: pageIndexPanel.el,
      hostContainer: pageIndexPanel.body,
      contentContainer: filmstrip,
      totalItems: meta.pages.length,
      itemHeight: 124, // --preview-h-panel (101) + gap/border/text
      renderItem: (index) => {
        const page = meta!.pages[index];
        const canvas = el("canvas");
        const thumb = el("div", { class: "filmstrip__thumb" }, canvas);
        if (page && page.hash === "") {
          thumb.classList.add("is-loading");
        }
        if (page && page.width && page.height) {
          const aspect = Math.min(page.width / page.height, 2.5);
          thumb.style.aspectRatio = String(aspect);
        }
        const btn = el(
          "button",
          {
            class: "filmstrip__page",
            type: "button",
            "aria-current": String(index === pageIndex),
            "aria-label": `Page ${index + 1}`,
          },
          thumb,
          el("span", { class: "filmstrip__num", text: String(index + 1) }),
        );
        btn.addEventListener("click", () => goToPage(index));
        
        const n = lastBadges.get(index);
        if (n) {
          const label = `${n} ${n === 1 ? "match" : "matches"} on page ${index + 1}`;
          btn.append(el("span", { class: "filmstrip__hits", text: String(n), title: label }));
        }

        if (page && page.hash !== "") {
          filmEngine.add({ target: canvas, noteId: meta!.id, page, size: "thumb" });
        }
        return btn;
      },
      recycleItem: (_index, btn) => {
        const canvas = btn.querySelector("canvas");
        if (canvas) {
          filmEngine.remove(canvas as HTMLCanvasElement);
          canvas.width = 0;
          canvas.height = 0;
        }
      },
      overscan: 1,
    });
    
    // We don't need to call paintBadges(lastBadges) here, because renderItem handles it for new items.
  }

  // --- keyboard (only while open) ------------------------------------------
  function onKey(e: KeyboardEvent): void {
    if (!open) return;
    // Escape closes in every mode; paging only means something over pages. An
    // open export menu takes the first Escape and stops it there (the shared menu
    // owns its own document handler, which `stopImmediatePropagation`s so this one
    // never runs for that keystroke) — so it never closes the whole reader out
    // from under someone who only meant to dismiss a dropdown. The find bar takes
    // Escape BEFORE the reader does, for the same reason.
    if (e.key === "Escape") {
      if (find.isOpen()) {
        find.close();
        // Closing find clears `?q=` — the URL stops claiming a search that is
        // no longer running.
        syncUrl();
        return;
      }
      return deps.onBack();
    }
    if (mode !== "note") return;

    // Ctrl/Cmd+F IS CLAIMED ONLY HERE — while a note is open, in note mode. The
    // browser's own find still works everywhere else in the app, which is the
    // whole reason this is not a global listener.
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === "f" || e.key === "F")) {
      e.preventDefault();
      find.open();
      return;
    }

    // Paging keys belong to the page, not to the field someone is typing in.
    if (e.target instanceof HTMLInputElement) return;
    if (e.key === "ArrowRight") goToPage(pageIndex + 1);
    else if (e.key === "ArrowLeft") goToPage(pageIndex - 1);
  }

  /** Apply the current zoom step to the image preview. */
  function sizeImage(): void {
    if (zoom === "Fit") {
      // Back to the CSS rule: fit the stage in both axes.
      fileImg.style.width = "";
      fileImg.style.maxWidth = "";
      fileImg.style.maxHeight = "";
      return;
    }
    // Past Fit the image may exceed the stage, which is what `overflow: auto` on
    // `.filestage` is for — so the max-* clamps have to be lifted or the step
    // would silently do nothing.
    fileImg.style.maxWidth = "none";
    fileImg.style.maxHeight = "none";
    // NOT `ZOOM_SCALE`: those factors are tuned for a note page, whose height is
    // derived from a 640px heuristic, so "100%" there is 1.18. An image has real
    // pixel dimensions, so the label has to mean what it says — 100% is natural
    // size — or the control reports a number the picture does not have.
    const factor = Number.parseInt(zoom, 10) / 100;
    const natural = fileImg.naturalWidth || fileImg.clientWidth;
    if (natural > 0 && Number.isFinite(factor)) {
      fileImg.style.width = `${Math.round(natural * factor)}px`;
    }
  }

  prev.addEventListener("click", () => goToPage(pageIndex - 1));
  next.addEventListener("click", () => goToPage(pageIndex + 1));
  ocrToggle.addEventListener("click", () => {
    ocr.toggle();
    // A right dock just opened; on a narrow stage collapse the page index so the
    // page is never squeezed from both sides (the reflow rule, one-per-side).
    if (ocr.isOpen()) relieveDoubleSqueeze();
  });
  layersToggle.addEventListener("click", () => {
    layersPanelOpen = !layersPanelOpen;
    refreshLayersUi();
    if (layersPanelOpen) relieveDoubleSqueeze();
    // The panel takes stage width, so the page has to be re-measured — same
    // relayout rule as the recognized-text aside. The stack itself is already
    // presented, so this repaint is a CSS resize, not a re-decode.
    void showPage(pageIndex);
  });
  pagesToggle.addEventListener("click", () => {
    // Re-opening the page index on a stage too narrow for both docks closes the
    // right one first — the symmetric half of the never-squeeze-both rule.
    if (!pageIndexOpen && bothSidesTooTight()) collapseRightPanels();
    setPageIndexOpen(!pageIndexOpen);
  });
  // Hand the shell the open note; it owns the trash + undo + navigation. Guarded
  // on `meta` so a stray click between files can't trash nothing.
  moveBin.addEventListener("click", () => {
    if (meta) deps.onMoveToBin?.(meta);
  });
  // Open the version history — the shell reuses the ONE history panel (`onVersions`
  // → the same controller the card ⋯ menu drives), so the two entry points cannot
  // drift. Guarded on `meta`; the button is only ever visible for a live `.note`.
  versionsBtn.addEventListener("click", () => {
    // Anchor the floating panel to the Versions button; pass the previewed
    // version's md5 (history mode) so its row shows `Viewing`, or nothing on a
    // live-note open.
    if (meta) deps.onVersions?.(meta, versionsBtn, previewVersion?.md5);
  });
  // Restore the previewed version. Guarded on both `meta` and `previewVersion` so
  // a stray click outside history mode does nothing; the shell owns the confirm,
  // the quota error, the refresh and the toast.
  restoreVersionBtn.addEventListener("click", () => {
    if (meta && previewVersion) deps.onRestoreVersion?.(meta, previewVersion);
  });
  // The bin-origin Restore/Delete permanently are wired inside `binActions`
  // (identity out via `getMeta`, the shell does the rest — the bin controller's
  // restore/purge, confirm/toast/refresh, then the route back to the bin).
  findToggle.addEventListener("click", () => {
    find.toggle();
    syncUrl();
  });
  findClose.addEventListener("click", () => {
    find.close();
    syncUrl();
  });
  findInput.addEventListener("input", () => {
    find.setQuery(findInput.value);
    // Debounced, so the address bar settles on "witches" rather than stepping
    // through `w`, `wi`, `wit`. It is a REPLACE either way (see `router.ts`), so
    // this is about thrash, not about history.
    queueUrlSync();
  });
  findPrev.addEventListener("click", () => find.step(-1));
  findNext.addEventListener("click", () => find.step(1));
  // The opt-in: reveal the typo-tolerant matches the exact search did not find.
  // No URL change — the query the user typed is unchanged; only the display of
  // the fuzzy fallback is being unlocked.
  findAsk.addEventListener("click", () => find.searchSimilar());
  // Enter steps forward, which is what a find bar does. Explicitly, rather than
  // by putting the bar in a <form>: a stray form submit inside a hash-routed SPA
  // reloads the page.
  findInput.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    find.step(e.shiftKey ? -1 : 1);
  });

  /**
   * The teardown behind both {@link Reader.close} and {@link Reader.hide}: drop
   * the decoded preview, reset find/OCR, unhook the keyboard, and stop describing
   * a note in the URL. One function so "route away" and "switch viewer" cannot
   * tear the reader down two different ways.
   */
  function closeReader(): void {
    open = false;
    // A debounced URL write scheduled by a keystroke must not land after the
    // reader is gone. `syncUrl` would refuse it anyway (and `replaceNotePosition`
    // refuses again, on the route), but the timer is ours to drop.
    if (urlTimer !== undefined) {
      clearTimeout(urlTimer);
      urlTimer = undefined;
    }
    exportMenu.setOpen(false);
    ocr.reset();
    find.reset();
    findInput.value = "";
    // Drop the layer stack — a closed reader holds no decoded RGBA (the same
    // discipline as the composite preview below, ~10 MB per layer at stake).
    layersPanelOpen = false;
    noteLayerCtl.release();
    refreshLayersUi();
    // Leave history mode: a closed reader holds no preview, and reopening a live
    // note must not flash the banner.
    previewVersion = null;
    previewViewOnly = false;
    restoreVersionBtn.hidden = false;
    versionBanner.hidden = true;
    root.classList.remove("is-previewing");
    root.classList.remove("is-open");
    root.setAttribute("aria-hidden", "true");
    document.removeEventListener("keydown", onKey);
    filmEngine.reset();
    // Drop the preview so a closed reader isn't holding a decoded image, and so
    // reopening a different file can't flash the previous one.
    fileImg.onerror = null;
    fileImg.removeAttribute("src");
    fileBody.replaceChildren();
    meta = null;
  }

  return {
    el: root,

    async open(summary: NoteSummary, metaPromise: Promise<NoteMeta>, startPage = 0, origin: ReaderOrigin = LIBRARY_ORIGIN, query = ""): Promise<void> {
      // The route is being APPLIED here, so nothing in this method may write back
      // to it. Without the suspension the `find.reset()` below would publish an
      // empty query for a note whose route carries `?q=`, wiping the search a few
      // lines before priming it. Lifted, and published once, at the end.
      urlSuspended = true;
      // Close a menu left open over a DIFFERENT file — but only then. `open()`
      // is also how a background freshness refresh re-announces the note already
      // on screen, and shutting the dropdown someone just opened because a poll
      // landed would be a UI that fidgets under its own maintenance.
      const changedFile = meta?.id !== summary.id;
      
      // A skeleton meta so the viewer paints instantly while the real metadata is
      // still in flight: page 0 is the summary's known first page, the rest are
      // placeholders (empty hash = "don't render") shaped by the summary's aspect.
      const aspect = summary.thumbAspect ?? DEFAULT_PAGE_DIMS;
      const skeletonMeta: NoteMeta = {
        id: summary.id,
        name: summary.name,
        fileType: summary.fileType,
        fileHash: summary.fileHash,
        size: 0,
        pxPerMm: null,
        pages: Array.from({ length: summary.pageCount }, (_, i) =>
          i === 0 ? summary.firstPage : skeletonPage(i, aspect),
        ),
      };
      meta = skeletonMeta;
      
      if (changedFile) exportMenu.setOpen(false);
      const kind = fileKind(summary.fileType);

      // Shared chrome first — the overlay, the title, the Back affordance are the
      // same in all three modes.
      header.setName(meta.name);
      // BACK NAMES ITS DESTINATION. `folder` with no known path is the whole
      // library, which is where `onBack` actually goes.
      header.setBackWord(backWord(origin));
      // THE CONTEXT SWAP (`toolbar.md`): a LIVE file's one file action is Move
      // to bin; a file open FROM the recycle bin is already trashed — re-trashing
      // it is nonsense and would call the control-plane on a deleted id — so its
      // two actions are Restore and Delete permanently instead. `hidden` drops
      // whichever side is off from the roving tabindex for free.
      fromBin = origin.kind === "bin";
      // PREVIEWING A PAST VERSION (history mode) is a THIRD file-zone context,
      // mutually exclusive with the live and bin ones: no Move to bin, no bin
      // Restore/Delete — the only action is Restore-this-version, on the banner.
      previewVersion = origin.kind === "history" ? (origin.version ?? null) : null;
      const previewing = previewVersion !== null;
      // A VIEW-ONLY history preview is one of a TRASHED file: per-version restore
      // is suppressed (restore the file first), and the raw address is bin-scoped.
      previewViewOnly = previewing && origin.viewOnly === true;
      moveBin.hidden = fromBin || previewing;
      // "Versions" — reopen the file's version list. Shown for a real `.note`
      // (`fileType === "note"`, not merely note-shaped, mirroring the card ⋯ menu's
      // gate) whether LIVE or open from the BIN — a trashed note's history is
      // view-only but fully browsable (bin-parity.md) — AND in a history preview of
      // ANY previewable kind, so you can pick another version without leaving.
      // Hidden on a LIVE non-note (its history entry point is the card menu, not a
      // reader toolbar it never opens live). The `fromBin` gate is deliberately
      // GONE: the bin no longer blocks the version list, only per-version restore.
      const isRealNote = meta.fileType.trim().toLowerCase() === "note";
      versionsBtn.hidden = !isRealNote && !previewing;
      binActions.setBinMode(fromBin, fromBin ? origin.retention ?? null : null);
      // The banner announces WHEN this version is from and carries Restore — EXCEPT
      // in a view-only (trashed) preview, where Restore is suppressed and the strip
      // is the WHEN alone. Its absolute stamp rides `title=` so the exact instant is
      // one hover away.
      versionBanner.hidden = !previewing;
      restoreVersionBtn.hidden = previewViewOnly;
      root.classList.toggle("is-previewing", previewing);
      if (previewing && previewVersion) {
        versionBannerText.textContent = `You're viewing a version from ${relativeTime(previewVersion.createdAt)} — this is not the current note.`;
        versionBannerText.title = absoluteTime(previewVersion.createdAt);
      }
      // A new file starts with the panel closed and no transcript carried over.
      ocr.reset();
      // …and with find closed and its field empty. Carrying a query across files
      // would show one note's counter over another note's pages.
      if (changedFile) {
        find.reset();
        findInput.value = "";
        // A different file starts with the layers panel closed and no stack
        // carried over — one file's layers must never label another's pixels.
        // A same-file re-announce (a freshness poll) keeps both, same rule as
        // the export menu above.
        layersPanelOpen = false;
        noteLayerCtl.release();
        refreshLayersUi();
        // …and with the page index back to its default OPEN — but only across a
        // real file change, so a freshness poll does not reopen a panel the user
        // collapsed. `setMode` below repaints its toggle/visibility.
        pageIndexOpen = true;
      }
      setMode(kind);
      root.classList.add("is-open");
      root.setAttribute("aria-hidden", "false");
      open = true;
      document.addEventListener("keydown", onKey);

      if (kind === "note") {
        // Clamped here, once, so every later consumer (the filmstrip's
        // `aria-current`, the pager count, the first paint) agrees from the outset.
        // A deep link to a page that no longer exists — the note was edited since
        // the transcript was indexed — lands on the last page rather than nowhere.
        pageIndex = Math.max(0, Math.min(meta.pages.length - 1, Math.floor(startPage)));
        zoom = "Fit";
        zoomStepper.set("Fit");
        header.setSubtitle(
          subtitle(origin, `${meta.pages.length} ${meta.pages.length === 1 ? "page" : "pages"}`),
        );
        setDownload(null);
        // The whole-notebook raw ".note" download lives in the menu (note mode has
        // no plain download link). Bin origin mints the bin-scoped route — the live
        // one 404s for a trashed file; a null href disables the row. In a version
        // PREVIEW the LIVE raw route would hand back the current blob, not the
        // version on screen — but `historyFileUrl` serves the version's own bytes
        // (the same route the image/PDF branch below and `spd`/`txt` viewers use),
        // so point the row at that and the user saves the ".note" they're looking at.
        rawNoteItem.setHref(
          previewing
            ? historyFileUrl(meta.id, previewVersion!.md5, { download: true, bin: previewViewOnly })
            : rawFileUrl(meta.id, meta.fileHash, { download: true, bin: fromBin }),
        );
        // Before the filmstrip, so a badge repaint has the page list it needs.
        find.setNote(meta.id, meta.pages);
        buildFilmstrip();
        // PRIMING FIND FROM THE ROUTE, through the one path that exists: open the
        // bar, fill the field, hand the controller the query. Landing on the first
        // match is then `runCounts`\' settle-and-navigate rule doing what it
        // already does when the page on screen has no match — no second path, and
        // nothing here that a keystroke does not also go through.
        //
        // Idempotent on a re-dispatch of the same route: `find.setQuery` drops a
        // query equal to the one already active, so a stray second dispatch
        // re-primes nothing and steps nowhere.
        const primed = findQuery(query);
        if (primed) {
          findInput.value = primed;
          find.open();
          find.setQuery(primed);
        }
        // Paint after the overlay has laid out so the stage has real dimensions.
        requestAnimationFrame(() => void showPage(pageIndex));
      } else {
        // No pages to page through — `startPage` is meaningless here and is
        // ignored rather than clamped into a range that does not exist.
        pageIndex = 0;
        // Nothing to find in a PDF or an image: no recognition, no word boxes.
        find.reset();
        findInput.value = "";
        filmEngine.reset();
        filmstrip.replaceChildren();
        if (filmVirtualList) {
          filmVirtualList.destroy();
          filmVirtualList = null;
        }
        header.setSubtitle(subtitle(origin, `${meta.fileType.toUpperCase()} · ${formatBytes(meta.size)}`));
        // Bin origin mints the bin-scoped route — the live one 404s for trashed; a
        // history preview mints the version-scoped route (its md5), since the live
        // `/file/:id?v=` would hand back the CURRENT blob, not the version on screen.
        setDownload(
          previewing
            ? historyFileUrl(meta.id, previewVersion!.md5, { download: true, bin: previewViewOnly })
            : rawFileUrl(meta.id, meta.fileHash, { download: true, bin: fromBin }),
        );

        const preview = previewing
          ? historyFileUrl(meta.id, previewVersion!.md5, { bin: previewViewOnly })
          : rawFileUrl(meta.id, meta.fileHash, { bin: fromBin });
        if (kind === "image" && preview) {
          showImage(meta, preview);
        } else {
          showNoPreview(
            meta,
            meta.name,
            preview === null
              ? "This file has no stored contents to preview or download yet."
              : "There's no preview for this file type. Download it to open it in another app.",
          );
        }
      }

      // The find field keeps focus when the route asked for a search: a link that
      // opens a note mid-search should leave the caret where the search is, not on
      // the way out of it.
      if (!(kind === "note" && findQuery(query))) back.focus();

      urlSuspended = false;
      // One publish, from the settled state. Normally a no-op — the route we were
      // handed usually already says this — but it CANONICALISES: a page clamped
      // into range (a deep link past the end of an edited note) or a query that
      // trimmed to nothing leaves the URL describing what actually happened rather
      // than what was asked for.
      syncUrl();

      // Wait for the full metadata to arrive in the background
      const realMeta = await metaPromise;
      if (!open || meta?.id !== realMeta.id) return;
      meta = realMeta;
      
      if (kind === "note") {
        find.setNote(meta.id, meta.pages);
        buildFilmstrip();
        // Always re-trigger showPage. If it was page 0, layers might have arrived.
        // If it was > 0, it was skipped previously due to empty hash.
        void showPage(pageIndex);
      } else {
        header.setSubtitle(subtitle(origin, `${meta.fileType.toUpperCase()} · ${formatBytes(meta.size)}`));
      }
    },

    close: closeReader,

    // Switching to another viewer is a full close (see the doc on {@link Reader.hide}).
    hide: closeReader,

    isOpen(): boolean {
      return open;
    },

    bumpTheme(): void {
      // Nothing to repaint outside note mode: an `<img>` and the "no preview"
      // block are ordinary themed DOM, not canvases painted for one theme.
      if (mode !== "note") return;
      filmEngine.bumpTheme();
      if (open && currentPage()) void showPage(pageIndex);
    },

    destroy(): void {
      document.removeEventListener("keydown", onKey);
      exportMenu.destroy();
      filmEngine.destroy();
      noteLayerCtl.release();
    },
  };
}
