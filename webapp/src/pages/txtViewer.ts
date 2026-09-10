// The `.txt` viewer. A plain-text file has no pages and no decode step — it is
// bytes to be shown READABLY — so this viewer fetches the raw file, decodes it as
// UTF-8, and lays it out in a `<pre>`-style reading column. It conforms to
// {@link Viewer}, hosts the shared toolbar (Back + Download + Move to bin) exactly
// as the reader does, and adds TWO reading controls to the toolbar's `view` zone,
// both the shared `.pager` slot shape (see `10-toolbar.css`):
//
//   ZOOM — `−` [Fit ⇕] `+`, the reader/`.spd` viewer's exact control, scaling the
//   reading COLUMN's width (its measure). `Fit ⇕` is the default page fitted to
//   the stage — the same label those viewers give their own first rung; each step
//   widens the column, capped at the stage. This is the FRAME size.
//
//   FONT SIZE — `−` [16px] `+`, scaling the GLYPH size. Distinct knob: font size
//   reflows the column (how many words land on a line), zoom only changes how wide
//   the column they reflow into is. Both are persisted, each under its own key.
//
// TESTABLE WITHOUT A BROWSER. The two things that need a browser — the network
// fetch and localStorage — are behind {@link TxtSeam}, an optional second
// argument that defaults to the real thing. A unit test injects a fake seam and
// drives render + font-size/zoom persistence with no DOM network and no storage.

import { el } from "../ui/dom";
import type { NoteMeta, NoteSummary } from "../core/types";
import { formatBytes, rawFileUrl, historyFileUrl } from "../core/fileKind";
import { readLocal, writeLocal } from "../ui/storage";
import { bytesBudget, dispatchApiFailure } from "../api/client";
import { createToolbar } from "./toolbar";
import { svg, VIEWER_IC } from "./viewerIcons";
import { createZoomStepper, FIT_PAGE } from "./viewerControls";
import { VIEWER_DEBOUNCE_MS, backWord, createViewerHeader, createViewerBody, createVersionBanner } from "./viewerChrome";
import { createBinViewerActions } from "../ui/binViewerActions";
import type { ReaderOrigin, Viewer, ViewerDeps } from "./viewer";
import {
  buildFindContent,
  resolveFindSegments,
  totalMatches,
  txtCountText,
  TXT_SEARCHING,
  type FindSegment,
} from "./txtFind";

// --- font-size control ------------------------------------------------------
// The persisted preference, sensible bounds, and the default the PoC shows
// (`16px`). Bounds keep the reading column legible at either end; the step is
// even so the value stays round.
const FONT_KEY = "sn.txt.fontpx";
const FONT_MIN = 10;
const FONT_MAX = 32;
const FONT_STEP = 2;
const FONT_DEFAULT = 16;

function clampFont(px: number): number {
  if (!Number.isFinite(px)) return FONT_DEFAULT;
  return Math.max(FONT_MIN, Math.min(FONT_MAX, Math.round(px)));
}

// --- zoom (reading-column width) control -------------------------------------
// A SECOND knob, distinct from font size (see the header): font size sets the
// GLYPH size and reflows the column; zoom sets how WIDE the column is. Its own
// persistence key, mirroring the font stepper's. The ladder is a small fixed set
// of width multipliers applied to the default page, stepped by − / + exactly like
// the `.spd` viewer's zoom — index 0 is `Fit ⇕` (the default column, factor 1), the
// rest widen it, and `max-width:100%` (13-txt-viewer.css) caps them at the stage.
const ZOOM_KEY = "sn.txt.zoom";
const ZOOM_FACTORS = [1, 1.25, 1.5, 1.75, 2] as const;
const ZOOM_DEFAULT = 0; // Fit ⇕ — the default page, fitted to the stage

function clampZoomIdx(i: number): number {
  if (!Number.isFinite(i)) return ZOOM_DEFAULT;
  return Math.max(0, Math.min(ZOOM_FACTORS.length - 1, Math.round(i)));
}
/**
 * `Fit ⇕` at the default column, else the width multiplier as a percentage.
 *
 * The SAME label the note and `.spd` viewers put on their own first rung, and it
 * names the same thing: the sheet is `height: 100%` at the page's natural 3:4
 * (13-txt-viewer.css), so rung 0 is that page fitted to the stage.
 *
 * The rungs above stretch the measure PAST the natural page. They do NOT leave
 * the fit behind — height is what the sheet is sized from, so every rung still
 * fills the stage vertically (measured: 5/5 rungs) and what a step actually buys
 * is width alone. That is why the label names the PAGE rather than an axis.
 */
function zoomLabel(i: number): string {
  return i === ZOOM_DEFAULT ? FIT_PAGE : `${Math.round(ZOOM_FACTORS[i]! * 100)}%`;
}

/** The browser-facing side of the viewer — network + storage — injected so a
 *  unit test can drive render and persistence with neither. */
export interface TxtSeam {
  /** Fetch and UTF-8 decode the text at `url`, honouring `signal` (the viewer
   *  aborts a superseded load). Rejects with {@link TxtLoadError} on an HTTP
   *  error so the caller can tell "session expired" (401/403) from "unreadable". */
  fetchText(url: string, signal: AbortSignal): Promise<string>;
  /** The persisted font size in px, or null when none is stored. */
  loadFontSize(): number | null;
  /** Persist the font size (best-effort; a storage failure is silent). */
  saveFontSize(px: number): void;
  /** The persisted zoom step index, or null when none is stored. */
  loadZoom(): number | null;
  /** Persist the zoom step index (best-effort; a storage failure is silent). */
  saveZoom(idx: number): void;
}

/** An HTTP failure fetching the text, carrying the status so the viewer can route
 *  401/403 to re-auth and everything else to the honest "couldn't read" state. */
export class TxtLoadError extends Error {
  constructor(readonly status: number | null) {
    super(status === null ? "text load failed" : `text load failed: HTTP ${status}`);
    this.name = "TxtLoadError";
  }
}

/** The real seam: a plain `fetch().text()` (a `.txt` is small — no Range needed)
 *  and `ui/storage.ts` for the font-size preference (the same guarded localStorage
 *  the gallery sort uses, so a locked-down browser degrades to no preference). */
export function defaultTxtSeam(): TxtSeam {
  return {
    async fetchText(url: string, signal: AbortSignal): Promise<string> {
      // `bytesBudget` folds the shared byte timeout into the caller's own signal,
      // so a STALLED transfer ends in the honest load error below rather than
      // leaving the viewer on "Opening this .txt file…" indefinitely.
      const budget = bytesBudget(signal);
      let res: Response;
      try {
        res = await fetch(url, { signal: budget.signal, credentials: "same-origin" });
      } catch (err) {
        // An abort rejects here too — rethrow so the caller's aborted-check drops
        // it silently rather than painting an error for a load it cancelled. A
        // TIMEOUT is not that: the caller did not cancel, so it must be reported.
        if (signal.aborted) throw err;
        throw new TxtLoadError(null);
      } finally {
        budget.done();
      }
      if (!res.ok) throw new TxtLoadError(res.status);
      return res.text(); // decodes UTF-8
    },
    loadFontSize(): number | null {
      const raw = readLocal(FONT_KEY);
      if (raw === null) return null;
      const n = Number.parseInt(raw, 10);
      return Number.isFinite(n) ? n : null;
    },
    saveFontSize(px: number): void {
      writeLocal(FONT_KEY, String(px));
    },
    loadZoom(): number | null {
      const raw = readLocal(ZOOM_KEY);
      if (raw === null) return null;
      const n = Number.parseInt(raw, 10);
      return Number.isFinite(n) ? n : null;
    },
    saveZoom(idx: number): void {
      writeLocal(ZOOM_KEY, String(idx));
    },
  };
}

export function createTxtViewer(deps: ViewerDeps, seam: TxtSeam = defaultTxtSeam()): Viewer {
  let meta: NoteMeta | null = null;
  /**
   * The file was opened as a PAST VERSION (history preview). Mirrors the bin
   * origin: the raw fetch and the download must then come off the version-scoped
   * `historyFileUrl` route (the version's md5), not the live `/file/:id?v=` one.
   * Carries the md5 + stamp the banner and Restore need after `open()` returns.
   */
  let previewVersion: { md5: string; createdAt: number } | null = null;
  /**
   * The previewed version's file is TRASHED (view-only): the banner's Restore is
   * suppressed and the version's raw bytes come off the BIN-scoped history route.
   */
  let previewViewOnly = false;
  /**
   * The file was opened FROM the recycle bin. Module-scoped (not just the `open()`
   * local) because `syncUrl` needs it on every paragraph turn: a bin open
   * publishes the deep `#/bin/note/:id/page/:n` URL, since a trashed file's blob
   * is not served at the live `#/note/:id` route.
   */
  let fromBin = false;
  // The current text element, when text is on screen — null while loading or in an
  // error state. The font-size control reaches through it to resize the live text.
  let textPre: HTMLPreElement | null = null;
  // The in-flight text load. THE ABORT HAZARD: the shell REUSES this one instance
  // across files, so a slow fetch from a prior `open()` (or a `hide()` mid-load)
  // could resolve after the next file's `open()` and paint stale text over it.
  // Every `open()`/`hide()`/`destroy()` aborts this first; the load's `.then`/
  // `.catch` also bail on `signal.aborted`, so a cancelled load never writes.
  let load: AbortController | null = null;

  let size = clampFont(seam.loadFontSize() ?? FONT_DEFAULT);
  let zoomIdx = clampZoomIdx(seam.loadZoom() ?? ZOOM_DEFAULT);

  // --- find state ----------------------------------------------------------
  // The whole file is loaded in the viewer, so find is a DOM/text operation over
  // `loadedText` — no per-page fetch, no rectangles. The browser's own index over
  // this file's `text/<md5>` (§1.1) names WHICH paragraphs
  // match, how many, and their BYTE RANGES; the viewer maps those ranges into the
  // string it holds, marks them and jumps between them.
  let loadedText: string | null = null;
  let findOpen = false;
  /** The trimmed query pending, in flight, or painted — makes the input idempotent. */
  let findActive: string | null = null;
  let findQuery = "";
  /** Bumped on every intent change; a response paints only if its token is still
   *  current — the same staleness guard the reader's find and search use. */
  let findToken = 0;
  let findTimer: ReturnType<typeof setTimeout> | undefined;
  /** The matching paragraphs, resolved into the loaded string's coordinates.
   *  Complete when it lands — one call, one answer. */
  let findSegs: FindSegment[] = [];
  /** Their `.txt__match` wrappers, aligned 1:1 with `findSegs` (ordinal order). */
  let findParas: HTMLElement[] = [];
  /** The current matching paragraph, indexing `findSegs`/`findParas`; -1 = none. */
  let findAt = -1;
  /** A query is out and nothing has come back — the counter shows no number.
   *  The FIRST find on a file pays `text/<md5>` plus an index build (55 ms for a
   *  1,483-segment novel, 363 ms for Les Misérables — §8.1); every find after it
   *  is the query alone. */
  let findSearching = false;
  /**
   * A typo-tolerant result computed but HELD, awaiting the opt-in — manual fuzzy
   * is opt-in. `null` unless the "search similar" affordance is showing. A deep
   * link from a global fuzzy hit carries the resolved term and runs exact, so it
   * never reaches this gate.
   */
  let heldFuzzySegs: FindSegment[] | null = null;
  /** The user opted in to fuzzy for the current query — clears on every new query. */
  let findOptedIn = false;
  /** Aborts the in-flight `text/<md5>` fetch when the query moves on. */
  let findAbort: AbortController | null = null;
  /**
   * A paragraph ordinal a deep link asked to open at, consumed once the results
   * land. The reader's "open at a page with `?q=`" adapted: the library hit
   * routes `#/note/:id/page/{ordinal+1}?q=`, so the viewer opens scrolled to
   * exactly the paragraph whose excerpt the user clicked, with find running.
   */
  let pendingTarget: number | null = null;

  // --- leading: Back + title (outside the two toolbar zones) ---------------
  const header = createViewerHeader({
    classes: { back: "viewer__back", backLabel: "viewer__back-label", title: "viewer__title" },
    onBack: () => deps.onBack(),
  });
  const back = header.back;
  const title = header.title;

  // --- view zone: the font-size stepper (`−` [16px] `+`) --------------------
  // The shared zoom-slot shape (`.pager` + `.icon-btn` steppers + a `.zoom` value),
  // so it gets the reader's exact geometry and the toolbar's roving tabindex for
  // free; the label is a px value because for text the size IS the font size.
  const fontStepper = createZoomStepper({
    readoutClass: "zoom",
    initial: size,
    format: (px: number) => `${px}px`,
    labels: { out: "Smaller text", in: "Larger text" },
    onStep: (dir) => {
      const next = clampFont(size + dir * FONT_STEP);
      if (next !== size) {
        // At a bound this is a no-op — clamp silently, persisting nothing.
        size = next;
        if (textPre) textPre.style.fontSize = `${size}px`;
        seam.saveFontSize(size);
      }
      return size;
    },
  });

  // --- view zone: the zoom control (`−` [Fit] `+`) --------------------------
  // The reader/`.spd` viewer's exact `.pager` shape, scaling the reading COLUMN's
  // width via a `--txt-zoom` factor the sheet's `aspect-ratio` multiplies
  // (13-txt-viewer.css). Its readout wears its OWN class (`.txt-zoom`), NOT the
  // font stepper's shared `.zoom`: both are `.pager`s in this one toolbar, and a
  // shared readout class would make a `.pager .zoom` locator resolve to two
  // elements — the same reason the `.spd` viewer keeps `.spd-zoom` apart.
  const zoomStepper = createZoomStepper({
    readoutClass: "txt-zoom",
    initial: zoomIdx,
    format: (i: number) => zoomLabel(i),
    onStep: (dir) => {
      const next = clampZoomIdx(zoomIdx + dir);
      if (next !== zoomIdx) {
        // At a bound this is a no-op — clamp silently, persisting nothing.
        zoomIdx = next;
        if (textPre) textPre.style.setProperty("--txt-zoom", String(ZOOM_FACTORS[zoomIdx]!));
        seam.saveZoom(zoomIdx);
      }
      return zoomIdx;
    },
  });

  // --- find toggle (view zone) ---------------------------------------------
  // The reader's find-toggle precedent, adapted: the icon-only `.btn` with
  // `aria-pressed`, its open look riding on that same state in CSS. Enabled for
  // every `.txt` — plain text is always searchable, unlike a `.note`, which find
  // gates on the device having recognised it (there is nothing to gate on here).
  const findToggle = el("button", {
    class: "btn",
    type: "button",
    "aria-pressed": "false",
    "aria-label": "Find in this file",
    title: "Find in this file (Ctrl+F)",
    html: svg(VIEWER_IC.find, 1.8),
  });

  // --- the universal (right) zone: Download + Move to bin ------------------
  // Download is the RAW `.txt` (no transformation): an `<a download>` at the
  // versioned raw-file URL, forced to attachment — the same wiring every viewer's
  // file zone carries.
  const downloadLink = el("a", {
    class: "btn",
    hidden: true,
    "aria-label": "Download",
    title: "Download",
    html: svg(VIEWER_IC.down, 1.8), // ICON-ONLY: aria-label + title carry the name.
  }) as HTMLAnchorElement;
  downloadLink.download = "";
  const moveBin = el("button", {
    class: "btn",
    type: "button",
    "aria-label": "Move to bin",
    title: "Move to bin",
    html: svg(VIEWER_IC.trash, 1.8) + "Move to bin",
  });
  moveBin.addEventListener("click", () => {
    if (meta) deps.onMoveToBin?.(meta);
  });
  // The BIN-ORIGIN controls, swapped in for Move to bin when the file is open
  // from the recycle bin (the toolbar's context swap — see `open()`; mirrors the
  // reader). The SAME `|— retention —| ⋯` cluster the bin ROW shows, built by the
  // shared `createBinViewerActions`: Restore neutral, Delete permanently the one
  // red item, its confirm carried through `onPurge` to the bin controller.
  const binActions = createBinViewerActions({
    getMeta: () => meta,
    onRestore: deps.onRestore,
    onPurge: deps.onPurge,
    // Card parity: the bin's "Version history" row opens the same view-only panel
    // the Versions control does, anchored to the "…" trigger. Only wired when the
    // shell can open history at all — no dead row otherwise.
    onHistory: deps.onVersions ? (m, anchor) => deps.onVersions!(m, anchor, undefined) : undefined,
  });
  // The "Versions" control, shown ONLY in a history preview — reopen the version
  // list to pick another version, routed through the SAME `deps.onVersions` the
  // reader and the card ⋯ menu use. Icon-only with the `restore` glyph.
  const versionsBtn = el("button", {
    class: "btn",
    type: "button",
    "aria-label": "Version history",
    title: "Version history",
    html: svg(VIEWER_IC.restore, 1.7),
  });
  versionsBtn.addEventListener("click", () => {
    // Shown only while previewing, so `previewVersion` is set — anchor the panel to
    // this button and mark the on-screen version's row `Viewing`.
    if (meta) deps.onVersions?.(meta, versionsBtn, previewVersion?.md5);
  });
  // The "previewing an older version" banner (history mode) — the shared chrome
  // the note reader uses; Restore routes through `deps.onRestoreVersion`, the one
  // confirm+restore path (`runRestore`/`confirmRestore`) shared with the reader
  // and the list.
  const versionBanner = createVersionBanner({
    onRestore: () => {
      if (meta && previewVersion) deps.onRestoreVersion?.(meta, previewVersion);
    },
  });

  const toolbar = createToolbar({
    label: "Text viewer",
    viewLabel: "Text controls",
    fileLabel: "File actions",
    className: "viewer__bar",
    leading: [{ el: back, focus: [back] }, { el: title }],
    view: [
      // Zoom leads the view zone, as it does in the reader and the `.spd` viewer —
      // the frame size before the glyph size. `focus` lists its two buttons so they
      // join the bar's roving tabindex in order (the readout carries no focus).
      { kind: "custom", key: "zoom", el: zoomStepper.el, focus: zoomStepper.focus },
      // The font-size stepper. `focus` lists its two buttons so they join the bar's
      // roving tabindex in order (the readout carries no focus of its own).
      { kind: "custom", key: "font-size", el: fontStepper.el, focus: fontStepper.focus },
      // Find — same seam the reader hands its find toggle: one control in the
      // view zone, the bar itself below the toolbar.
      { kind: "custom", key: "find", el: findToggle, focus: [findToggle] },
    ],
    file: [
      // Shown only in a history preview (mutually exclusive with Move to bin and
      // the bin cluster) — the reopen-the-list control, before the download.
      { kind: "custom", key: "versions", el: versionsBtn, focus: [versionsBtn] },
      { kind: "custom", key: "download-file", el: downloadLink, focus: [downloadLink] },
      { kind: "custom", key: "move-bin", el: moveBin, focus: [moveBin] },
      // The bin-origin cluster (mutually exclusive with Move to bin): the
      // retention countdown then the "…" menu, whose one focusable is its trigger.
      { kind: "custom", key: "bin-actions", el: binActions.el, focus: [binActions.trigger] },
    ],
  });

  // --- the find bar ---------------------------------------------------------
  // The reader's find bar, adapted to plain text: a field, the exact counter,
  // and prev/next stepping — here between MATCHING PARAGRAPHS rather than pages.
  // Hidden until the toggle (or Ctrl+F, or a `?q=` deep link) opens it; `.viewer--txt.is-finding`
  // reveals it.
  const findInput = el("input", {
    type: "text",
    autocomplete: "off",
    placeholder: "Find in this file",
    "aria-label": "Find in this file",
  }) as HTMLInputElement;
  const findCount = el("span", { class: "txtbar__count", role: "status", "aria-live": "polite" });
  // The MANUAL-FUZZY OPT-IN affordance (in-doc-search Phase 3). When the exact
  // find is empty but a typo-tolerant one would find close matches, the bar offers
  // this rather than silently substituting them; clicking reveals the held result
  // (already fetched, not re-run). A deep-link fuzzy hit carries the resolved term
  // and runs exact, so this is only ever the "I typed a word this file lacks" case.
  const findAsk = el("button", {
    class: "txtbar__ask",
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
  // Its OWN class, not the reader's `.findbar`: both viewers are mounted at once,
  // so a shared class would put two `.findbar`s in the DOM and the reader's find
  // tests (which query `.findbar` globally) would see this one too. Same LOOK,
  // via `.txtbar` styles that reuse the shared tokens (13-txt-viewer.css).
  const findBar = el(
    "div",
    { class: "txtbar", hidden: true },
    el("span", { class: "txtbar__field", html: svg(VIEWER_IC.find, 1.8) }, findInput),
    findCount,
    findAsk,
    findPrev,
    findNext,
    findClose,
  );

  // --- the body: placeholder (loading / error) or the text column ----------
  // The shared `.viewer__main`/`.viewer__placeholder` card (viewerChrome.ts); the
  // rendered TEXT swaps `main`'s children to the `<pre>` (and adds `--text`).
  const viewerBody = createViewerBody({ mark: "TXT" });
  const main = viewerBody.main;
  const placeholder = viewerBody.placeholder;
  const root = el(
    "section",
    { class: "viewer viewer--txt", "aria-label": "Text viewer", hidden: true },
    toolbar.el,
    versionBanner.el,
    findBar,
    main,
  );

  /** Show a centred placeholder (loading / error) and drop any text on screen. */
  function showPlaceholder(title: string, body: string): void {
    textPre = null;
    loadedText = null;
    main.classList.remove("viewer__main--text");
    viewerBody.showPlaceholder(title, body);
  }

  /** Lay the decoded text out in a readable column at the current font size. */
  function showText(text: string): void {
    // Device-authored content: textContent, NEVER innerHTML. `<pre>` preserves the
    // file's line breaks and whitespace; the CSS wraps long lines to a measure.
    const pre = el("pre", { class: "txt__sheet", text }) as HTMLPreElement;
    pre.style.fontSize = `${size}px`;
    // The reading column's width factor — the sheet's `aspect-ratio` multiplies it
    // (13-txt-viewer.css); absent/`Fit` leaves the default page. Set here so text
    // opened later inherits the current zoom, exactly as it inherits the font size.
    pre.style.setProperty("--txt-zoom", String(ZOOM_FACTORS[zoomIdx]!));
    textPre = pre;
    loadedText = text;
    main.classList.add("viewer__main--text");
    main.replaceChildren(pre);
    // A `?q=` deep link primed find before the bytes arrived — now that the text
    // is here, run it (which will scroll to `pendingTarget` when the results land).
    if (findOpen && findQuery !== "") runFind(findQuery, findToken);
  }

  // --- find ----------------------------------------------------------------

  /** Repaint the counter — no number while the answer is still coming, the exact
   *  "N in M" once it lands — and enable prev/next only when there is more than
   *  one matching paragraph to step between (stepping a set of one is a no-op). */
  function paintFindCount(): void {
    findCount.textContent =
      findQuery === ""
        ? ""
        : findSearching
          ? TXT_SEARCHING
          : txtCountText(totalMatches(findSegs), findSegs.length);
    const canStep = findSegs.length > 1;
    findPrev.disabled = !canStep;
    findNext.disabled = !canStep;
  }

  /** Restore the plain, unmarked text — find closed, query emptied, or a fresh
   *  file with nothing found. Keeps the SAME `<pre>` so the font size persists. */
  function clearFindMarks(): void {
    findSegs = [];
    findParas = [];
    findAt = -1;
    findSearching = false;
    findAsk.hidden = true;
    if (textPre && loadedText !== null) textPre.replaceChildren(document.createTextNode(loadedText));
  }

  /** Mark the current matching paragraph, and optionally scroll it into view.
   *  Scrolling only happens on a LANDING or a step — not on every streamed batch,
   *  which would yank the reader around as the file drains. */
  function focusCurrent(scroll = true): void {
    for (const [i, p] of findParas.entries()) p.classList.toggle("is-current", i === findAt);
    const cur = findParas[findAt];
    // `scrollIntoView` is absent under the test DOM — guarded, since the mark and
    // the current-class are the behaviour under test, the scroll a browser nicety.
    if (cur && scroll) cur.scrollIntoView?.({ block: "center", inline: "nearest" });
  }

  /**
   * Paint the matches into the loaded text. On a LANDING it settles on one
   * paragraph — the deep link's target when it named a matching one, else the
   * first match — and scrolls there; otherwise it keeps the current paragraph and
   * does NOT scroll, so revealing a held fuzzy answer does not steal the reader's
   * place. Rebuilds the `<pre>`'s children in place (font size kept).
   */
  function renderFind(landing: boolean): void {
    if (!textPre || loadedText === null) return;
    const built = buildFindContent(loadedText, findSegs);
    textPre.replaceChildren(...built.nodes);
    findParas = built.paras;
    if (landing) {
      // WHERE FIND LANDS: the paragraph the deep link asked for if it matched,
      // otherwise the first — the `.txt` analog of the reader settling on the hit
      // page, or the first match when the page you are on has none.
      let at = findSegs.length > 0 ? 0 : -1;
      if (pendingTarget !== null) {
        const idx = findSegs.findIndex((s) => s.segment === pendingTarget);
        if (idx >= 0) at = idx;
      }
      findAt = at;
      pendingTarget = null;
    } else if (findAt >= findSegs.length) {
      findAt = findSegs.length - 1;
    }
    focusCurrent(landing);
    paintFindCount();
    // The URL follows the paragraph find actually landed on (the target when it
    // matched, else the first) — so a reload lands here, not on the ordinal that
    // turned out to have no match.
    syncUrl();
  }

  /** The opt-in: reveal the held typo-tolerant matches as the answer. Nothing is
   *  asked again — the ladder's answer was already computed, only held back. */
  function searchSimilar(): void {
    if (heldFuzzySegs === null || loadedText === null) return;
    findOptedIn = true;
    findSegs = heldFuzzySegs;
    heldFuzzySegs = null;
    findSearching = false;
    findAsk.hidden = true;
    findAt = -1;
    renderFind(true);
  }

  /**
   * The document-scoped search: the browser's own index over this file's
   * `text/<md5>` (§1.1), which carries each paragraph's BYTE RANGE — the `o`/`l`
   * fields — so `resolveFindSegments` can map the answer into the string already
   * on screen. One call, one complete answer; the fuzzy fallback is gated behind
   * the opt-in, and a superseded answer is dropped by its token.
   *
   * The abort covers the fetch only. The build and the query are not abortable
   * and should not be: they are the same work the next keystroke needs.
   */
  async function runFind(query: string, mine: number): Promise<void> {
    if (loadedText === null || !meta?.fileHash) return; // nothing loaded, or no address
    // Said here as well as in `setFindQuery`, because a `?q=` deep link reaches
    // this function DIRECTLY once the blob lands — it never went through the
    // field, so nothing else would have put the counter into its waiting state.
    findSearching = true;
    paintFindCount();
    const ac = new AbortController();
    findAbort = ac;
    try {
      const result = await deps.docSearch.search(meta.fileHash, query, ac.signal);
      if (mine !== findToken || loadedText === null) return;
      // A `.note` or `.pdf` segment carries no byte range because its ordinal IS
      // the address; a `.txt` one always does. A segment without one cannot be
      // placed in the string, so it is dropped rather than marked from byte 0.
      const located = result.segments.flatMap((s) =>
        s.offset === null || s.length === null
          ? []
          : [{ segment: s.segment, offset: s.offset, length: s.length, matches: s.matches, terms: s.terms }],
      );
      // THE MANUAL-FUZZY OPT-IN. A fuzzy fallback that FOUND something is held,
      // not shown — the affordance offers it; one that found NOTHING is a genuine
      // absence. The ladder has already run (`idx_fuzzy` fires it only on a total
      // of 0), so this gates the DISPLAY and nothing else.
      if (result.usedFuzzy && !findOptedIn) {
        const segs = resolveFindSegments(loadedText, located);
        clearFindMarks(); // drop any exact marks; hides the ask
        findCount.textContent = "No matches";
        heldFuzzySegs = segs.length > 0 ? segs : null;
        findAsk.hidden = segs.length === 0;
        return;
      }
      findSearching = false;
      findSegs = resolveFindSegments(loadedText, located);
      renderFind(true);
    } catch (e) {
      if (mine !== findToken) return;
      // A dead session belongs to the shell, exactly as it does for the page
      // load — never a swallowed "no matches".
      if (dispatchApiFailure({ onSessionExpired: deps.onSessionExpired }, e)) return;
      // Any other failure — including a 404 from a file whose text is not derived
      // yet — leaves the text readable and unmarked; the next keystroke retries
      // for free.
      clearFindMarks();
      paintFindCount();
    }
  }

  /** The field changed. Cheap, idempotent, safe per keystroke — the same debounce
   *  + staleness shape the reader's find and the library search use. */
  function setFindQuery(raw: string): void {
    const q = raw.trim();
    if (q === findActive) return; // same question; leave the answer alone
    findActive = q;
    findQuery = q;
    findToken++;
    // A new intent: stop draining the superseded stream, and drop any held fuzzy
    // result and opt-in so the gate re-arms for this query.
    findAbort?.abort();
    findAbort = null;
    findSearching = q !== "";
    heldFuzzySegs = null;
    findOptedIn = false;
    findAsk.hidden = true;
    if (findTimer !== undefined) {
      clearTimeout(findTimer);
      findTimer = undefined;
    }
    if (q === "") {
      clearFindMarks();
      paintFindCount();
      syncUrl();
      return;
    }
    // The waiting state starts at the KEYSTROKE, not at the request: the debounce
    // is part of the wait, and a counter still showing the previous query's exact
    // number would be describing an answer to a question nobody is asking.
    paintFindCount();
    const mine = findToken;
    findTimer = setTimeout(() => {
      findTimer = undefined;
      void runFind(q, mine);
    }, VIEWER_DEBOUNCE_MS);
  }

  /** Step to the next (+1) / previous (-1) matching paragraph — keyboard and
   *  buttons both land here, mirroring the reader's `find.step`. Wraps
   *  unconditionally: the answer is complete when it lands, so there is no floor
   *  to step off the end of. */
  function stepFind(dir: 1 | -1): void {
    const n = findSegs.length;
    if (n === 0) return;
    findAt = (findAt + dir + n) % n;
    focusCurrent();
    // Stepping moves which paragraph the URL points at, so the address bar keeps
    // describing where you are — the reader's page-step behaviour, adapted.
    syncUrl();
  }

  /** Drop every find affordance and close the bar — a new file, or the viewer
   *  hiding. `open()` re-primes from the route before the viewer is seen again. */
  function resetFind(): void {
    if (findTimer !== undefined) {
      clearTimeout(findTimer);
      findTimer = undefined;
    }
    if (urlTimer !== undefined) {
      clearTimeout(urlTimer);
      urlTimer = undefined;
    }
    findAbort?.abort();
    findAbort = null;
    findToken++;
    findActive = null;
    findQuery = "";
    findAt = -1;
    findSegs = [];
    findParas = [];
    findSearching = false;
    heldFuzzySegs = null;
    findOptedIn = false;
    findAsk.hidden = true;
    pendingTarget = null;
    findInput.value = "";
    setFindOpen(false);
    paintFindCount();
  }

  function setFindOpen(open: boolean): void {
    findOpen = open;
    findBar.hidden = !open;
    root.classList.toggle("is-finding", open);
    findToggle.setAttribute("aria-pressed", String(open));
  }

  function openFind(): void {
    setFindOpen(true);
    findInput.focus();
    findInput.select();
  }

  function closeFind(): void {
    if (!findOpen) return;
    setFindOpen(false);
    if (findTimer !== undefined) {
      clearTimeout(findTimer);
      findTimer = undefined;
    }
    findAbort?.abort();
    findAbort = null;
    findToken++;
    findActive = null;
    findQuery = "";
    findSearching = false;
    heldFuzzySegs = null;
    findOptedIn = false;
    findInput.value = "";
    clearFindMarks();
    paintFindCount();
    syncUrl();
  }

  findToggle.addEventListener("click", () => (findOpen ? closeFind() : openFind()));
  findClose.addEventListener("click", () => closeFind());
  // The opt-in: reveal the typo-tolerant matches the exact search did not find.
  // No URL change — the typed query is unchanged; only the fuzzy display unlocks.
  findAsk.addEventListener("click", () => searchSimilar());
  findInput.addEventListener("input", () => {
    setFindQuery(findInput.value);
    queueUrlSync();
  });
  findInput.addEventListener("keydown", (e) => {
    // Enter steps forward (Shift+Enter back), explicitly rather than via a <form>
    // whose stray submit would reload a hash-routed SPA — the reader's rule.
    if (e.key !== "Enter") return;
    e.preventDefault();
    stepFind(e.shiftKey ? -1 : 1);
  });
  findPrev.addEventListener("click", () => stepFind(-1));
  findNext.addEventListener("click", () => stepFind(1));

  // --- the URL, which describes where you are ------------------------------
  // Mirrors the reader: the file's find query and the current matching paragraph
  // are addressable via `replaceState` (`deps.onPosition`), so a reload or a
  // shared link lands on the same search scrolled to the same place, while Back
  // stays one step out of the file.
  let urlTimer: ReturnType<typeof setTimeout> | undefined;
  function syncUrl(): void {
    if (urlTimer !== undefined) {
      clearTimeout(urlTimer);
      urlTimer = undefined;
    }
    if (!meta || root.hidden) return;
    // The paragraph the URL points at: the current match when one is settled,
    // else the file's start. The query is what find is actually running.
    const ordinal = findOpen && findAt >= 0 && findSegs[findAt] ? findSegs[findAt]!.segment : 0;
    // A BIN-origin open publishes the deep `#/bin/note/:id/page/:n` form (the `bin`
    // flag), tracking the paragraph but dropping the query: a trashed file's blob is
    // not at the live `#/note/:id` route, so a reload of that would 404 to the
    // library. In a history PREVIEW the position rides the version's md5
    // (`#/note/:id/version/:short`, query likewise dropped). A live open passes
    // neither flag and gets the bare note URL with its `?q=`.
    if (fromBin) {
      deps.onPosition?.(meta.id, ordinal, "", undefined, true);
      return;
    }
    deps.onPosition?.(meta.id, ordinal, findOpen ? findQuery : "", previewVersion?.md5);
  }
  function queueUrlSync(): void {
    if (urlTimer !== undefined) clearTimeout(urlTimer);
    urlTimer = setTimeout(() => {
      urlTimer = undefined;
      syncUrl();
    }, VIEWER_DEBOUNCE_MS);
  }

  // --- keyboard (only while the viewer is on screen) ------------------------
  function onKey(e: KeyboardEvent): void {
    if (root.hidden) return;
    if (e.key === "Escape") {
      if (findOpen) {
        closeFind();
        return;
      }
      return deps.onBack();
    }
    // Ctrl/Cmd+F claimed ONLY while this viewer is up — the browser's own find
    // still works everywhere else in the app (the reader's rule).
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === "f" || e.key === "F")) {
      e.preventDefault();
      openFind();
      return;
    }
  }
  document.addEventListener("keydown", onKey);

  return {
    el: root,

    async open(summary: NoteSummary, metaPromise: Promise<NoteMeta>, page: number, origin: ReaderOrigin, query: string): Promise<void> {
      // Abort a prior load before starting this one (THE ABORT HAZARD, above).
      load?.abort();
      // A new file: drop the previous file's find entirely before priming this
      // one's, so a stale query, its marks, or its debounce can never carry over.
      resetFind();

      // Create abort controller first so we can cancel even during the metaPromise await
      const ctl = new AbortController();
      load = ctl;

      // A NEW FILE MEANS NO FILE, until this one's metadata lands. The toolbar's
      // Move to bin and the bin cluster act on `meta`, and the shell does not
      // call `hide()` when you move between two files of the SAME type — so
      // without this the controls stayed pointed at the file you just left for
      // the whole of the `metaPromise` round trip below, and clicking Move to
      // bin there trashed THAT one.
      meta = null;

      root.hidden = false;
      header.setName(summary.name);
      header.setSubtitle(summary.fileType.toUpperCase());
      header.setBackWord(backWord(origin));
      // THE CONTEXT SWAP: a live file's file action is Move to
      // bin; one open FROM the bin is already trashed, so it gets Restore and
      // Delete permanently instead; a HISTORY preview is read-only with just
      // Restore-this-version on the banner and a Versions control to reopen the
      // list. `hidden` drops whichever sides are off from the roving tabindex.
      fromBin = origin.kind === "bin";
      previewVersion = origin.kind === "history" ? (origin.version ?? null) : null;
      const previewing = previewVersion !== null;
      // A view-only (trashed) history preview: no per-version Restore, and the raw
      // bytes come off the bin-scoped history route.
      previewViewOnly = previewing && origin.viewOnly === true;
      moveBin.hidden = fromBin || previewing;
      // Versions — shown in a history PREVIEW and, now, from the BIN: a trashed
      // `.txt`'s version history is view-only but browsable. Still
      // hidden on a plain live open (its entry point is the card ⋯ menu).
      versionsBtn.hidden = !previewing && !fromBin;
      binActions.setBinMode(fromBin, fromBin ? origin.retention ?? null : null);
      // The banner carries Restore EXCEPT in a view-only (trashed) preview.
      versionBanner.setVersion(previewVersion, previewViewOnly);
      // Bin origin mints the bin-scoped raw route — the live one 404s for trashed;
      // a history preview mints the version-scoped route so the download is the
      // VERSION's bytes, not the current blob — and a TRASHED file's version off
      // the bin-scoped history route.
      const download = previewing
        ? historyFileUrl(summary.id, previewVersion!.md5, { download: true, bin: previewViewOnly })
        : rawFileUrl(summary.id, summary.fileHash, { download: true, bin: fromBin });
      downloadLink.hidden = download === null;
      if (download !== null) downloadLink.href = download;

      // A `?q=` DEEP LINK primes find before the bytes land: the bar opens, the
      // field is filled, and `page` (the paragraph ordinal the library hit
      // routed with) is remembered as the scroll target. The request itself
      // fires from `showText`, once there is text to mark — one mechanism serves
      // both "open at the paragraph containing the word" and standalone find,
      // exactly as the reader's `?q=` primes find-in-note and nothing else.
      const q = (query ?? "").trim();
      if (q !== "") {
        findQuery = q;
        findActive = q;
        findInput.value = q;
        pendingTarget = page;
        setFindOpen(true);
      } else {
        setFindOpen(false);
      }

      // Loading state first — synchronous, so the placeholder names the file before
      // any bytes land (and a not-yet-resolved load never blanks the view).
      showPlaceholder(summary.name, "Opening this .txt file…");

      let next: NoteMeta;
      try {
        next = await metaPromise;
      } catch (e) {
        if (ctl.signal.aborted) return;
        showPlaceholder("Couldn’t read this file", "The file metadata couldn’t be loaded.");
        return;
      }
      
      if (ctl.signal.aborted) return;
      meta = next;
      header.setSubtitle(`${next.fileType.toUpperCase()} · ${formatBytes(next.size)}`);

      // The INLINE raw URL (no `download` flag) is what we fetch; null when the
      // entry has no content hash, which is an honest "couldn't read", not a fetch.
      // A history preview fetches the VERSION's bytes off its md5, not the live
      // `/file/:id?v=` (which serves the current blob).
      const url = previewing
        ? historyFileUrl(next.id, previewVersion!.md5, { bin: previewViewOnly })
        : rawFileUrl(next.id, next.fileHash, { bin: fromBin });
      if (url === null) {
        showPlaceholder("Couldn’t read this file", "This text file has no stored content to show.");
        back.focus();
        return;
      }

      seam
        .fetchText(url, ctl.signal)
        .then((text) => {
          if (ctl.signal.aborted) return; // superseded by a newer open() / hidden — drop it
          showText(text);
        })
        .catch((err) => {
          if (ctl.signal.aborted) return; // cancelled — say nothing
          // A page fetch that 401/403'd is a session problem, not a broken file —
          // hand it to the shell, which re-authenticates (same policy as the reader).
          if (err instanceof TxtLoadError && (err.status === 401 || err.status === 403)) {
            deps.onSessionExpired();
            return;
          }
          showPlaceholder("Couldn’t read this file", "The text couldn’t be loaded. You can still download the original.");
        });

      back.focus();
      // Assert the address from the settled state — the reader's open-end canonical
      // sync, adapted. A history PREVIEW without a `?q=` never touches find, so this
      // is what publishes its `#/note/:id/version/:short` address; a `?q=` link's
      // find re-publishes the landed paragraph once the text arrives. A live open
      // re-states its bare note URL (a no-op the route already carries).
      syncUrl();
    },

    hide(): void {
      // Stop and clear: abort any in-flight load and drop the text, so the shell
      // can reuse this instance for the next file with no stale text and no leaked
      // fetch. `open()` re-primes everything before this viewer is seen again.
      load?.abort();
      load = null;
      resetFind();
      textPre = null;
      loadedText = null;
      // Leave history mode: a reused instance opening a LIVE file next must not
      // carry over the version banner or the version-scoped raw route.
      previewVersion = null;
      previewViewOnly = false;
      main.classList.remove("viewer__main--text");
      main.replaceChildren(placeholder);
      root.hidden = true;
      meta = null;
    },

    destroy(): void {
      // Free the in-flight load for good, and drop the document keydown listener
      // this viewer owns (the find shortcut) — a hidden viewer must keep none.
      load?.abort();
      load = null;
      resetFind();
      document.removeEventListener("keydown", onKey);
    },
  };
}
