// The `.txt` viewer: fetches the raw file, decodes UTF-8 and lays it out in a
// `<pre>` reading column. Two persisted knobs: zoom sets the column's width,
// font size the glyph size (which reflows the column). Network and storage sit
// behind {@link TxtSeam} for unit tests.

import { el } from "../ui/dom";
import type { NoteMeta, NoteSummary } from "../core/types";
import { formatBytes, rawFileUrl, historyFileUrl } from "../core/fileKind";
import { readLocal, writeLocal } from "../ui/storage";
import { bytesBudget, dispatchApiFailure } from "../api/client";
import { createToolbar } from "./toolbar";
import { svg, VIEWER_IC } from "./viewerIcons";
import { createZoomStepper, FIT_PAGE, FIT_WIDTH } from "./viewerControls";
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

// ---- font size ----
const FONT_KEY = "sn.txt.fontpx";
const FONT_MIN = 10;
const FONT_MAX = 32;
const FONT_STEP = 2;
const FONT_DEFAULT = 16;

function clampFont(px: number): number {
  if (!Number.isFinite(px)) return FONT_DEFAULT;
  return Math.max(FONT_MIN, Math.min(FONT_MAX, Math.round(px)));
}

// ---- zoom (column width) ----
// Rung 0 is `Fit ⇕` (factor 1), the middle rungs widen the measure, and the
// last is `Fit ⇔`, which spans the stage.
const ZOOM_KEY = "sn.txt.zoom";
const ZOOM_FACTORS = [1, 1.25, 1.5, 1.75] as const;
const ZOOM_DEFAULT = 0;
/**
 * The top rung has no factor: the column spans the stage. A multiplier would
 * stop at the stage edge only by accident of the stage's proportions.
 */
const ZOOM_FIT_WIDTH = ZOOM_FACTORS.length;

function clampZoomIdx(i: number): number {
  if (!Number.isFinite(i)) return ZOOM_DEFAULT;
  return Math.max(0, Math.min(ZOOM_FIT_WIDTH, Math.round(i)));
}
/**
 * The sheet is `height: 100%` at a natural 3:4, so every rung fills the stage
 * vertically and only width changes; rung 0 is therefore labelled as a page fit.
 */
function zoomLabel(i: number): string {
  if (i === ZOOM_DEFAULT) return FIT_PAGE;
  if (i === ZOOM_FIT_WIDTH) return FIT_WIDTH;
  return `${Math.round(ZOOM_FACTORS[i]! * 100)}%`;
}

/**
 * The one place a rung becomes layout: multipliers set `--txt-zoom` (read by the
 * sheet's `aspect-ratio`); fit-width drops the aspect and takes the stage width.
 */
function applyZoom(pre: HTMLElement, i: number): void {
  const wide = i === ZOOM_FIT_WIDTH;
  pre.classList.toggle("txt__sheet--wide", wide);
  if (wide) pre.style.removeProperty("--txt-zoom");
  else pre.style.setProperty("--txt-zoom", String(ZOOM_FACTORS[i]!));
}

/** Network and storage, injected so unit tests need neither. */
export interface TxtSeam {
  /** Rejects with {@link TxtLoadError} on HTTP errors so 401/403 can be told apart. */
  fetchText(url: string, signal: AbortSignal): Promise<string>;
  loadFontSize(): number | null;
  /** Best-effort; storage failures are silent. */
  saveFontSize(px: number): void;
  loadZoom(): number | null;
  saveZoom(idx: number): void;
}

export class TxtLoadError extends Error {
  constructor(readonly status: number | null) {
    super(status === null ? "text load failed" : `text load failed: HTTP ${status}`);
    this.name = "TxtLoadError";
  }
}

/** A `.txt` is small, so a plain `fetch().text()`; preferences via guarded `ui/storage.ts`. */
export function defaultTxtSeam(): TxtSeam {
  return {
    async fetchText(url: string, signal: AbortSignal): Promise<string> {
      // `bytesBudget` adds the stall timeout to the caller's signal.
      const budget = bytesBudget(signal);
      let res: Response;
      try {
        res = await fetch(url, { signal: budget.signal, credentials: "same-origin" });
      } catch (err) {
        // Rethrow an abort so the caller drops it silently; a timeout is reported.
        if (signal.aborted) throw err;
        throw new TxtLoadError(null);
      } finally {
        budget.done();
      }
      if (!res.ok) throw new TxtLoadError(res.status);
      return res.text();
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
  /** History preview: bytes come off the version-scoped `historyFileUrl`. */
  let previewVersion: { md5: string; createdAt: number } | null = null;
  /** Trashed version preview: no Restore, bytes off the bin-scoped history route. */
  let previewViewOnly = false;
  /** Read by `syncUrl` on every paragraph turn to publish the bin URL form. */
  let fromBin = false;
  let textPre: HTMLPreElement | null = null;
  // The shell reuses this instance across files, so every open/hide/destroy aborts
  // the in-flight load, and its handlers bail on `signal.aborted`.
  let load: AbortController | null = null;

  let size = clampFont(seam.loadFontSize() ?? FONT_DEFAULT);
  let zoomIdx = clampZoomIdx(seam.loadZoom() ?? ZOOM_DEFAULT);

  // ---- find ----
  // The whole file is loaded, so find is text/DOM work: the index names matching
  // paragraphs with byte ranges, which are mapped into the loaded string.
  let loadedText: string | null = null;
  let findOpen = false;
  /** The trimmed query pending, in flight, or painted; makes input idempotent. */
  let findActive: string | null = null;
  let findQuery = "";
  /** Bumped on every intent change; stale responses are dropped. */
  let findToken = 0;
  let findTimer: ReturnType<typeof setTimeout> | undefined;
  let findSegs: FindSegment[] = [];
  /** Aligned 1:1 with `findSegs`. */
  let findParas: HTMLElement[] = [];
  /** Index into `findSegs`/`findParas`; -1 = none. */
  let findAt = -1;
  /** The first find on a file pays the `text/<md5>` fetch and an index build. */
  let findSearching = false;
  /**
   * A fuzzy result held until the user opts in. A deep link from a global fuzzy
   * hit carries the resolved term and runs exact, so it never reaches this.
   */
  let heldFuzzySegs: FindSegment[] | null = null;
  let findOptedIn = false;
  let findAbort: AbortController | null = null;
  /** Paragraph ordinal a `?q=` deep link targets, consumed when results land. */
  let pendingTarget: number | null = null;

  const header = createViewerHeader({
    classes: { back: "viewer__back", backLabel: "viewer__back-label", title: "viewer__title" },
    onBack: () => deps.onBack(),
  });
  const back = header.back;
  const title = header.title;

  // Font readout keeps `.zoom`; the zoom stepper below takes `.txt-zoom` so a
  // `.pager .zoom` locator matches one element.
  const fontStepper = createZoomStepper({
    readoutClass: "zoom",
    initial: size,
    format: (px: number) => `${px}px`,
    labels: { out: "Smaller text", in: "Larger text" },
    onStep: (dir) => {
      const next = clampFont(size + dir * FONT_STEP);
      if (next !== size) {
        size = next;
        if (textPre) textPre.style.fontSize = `${size}px`;
        seam.saveFontSize(size);
      }
      return size;
    },
  });

  const zoomStepper = createZoomStepper({
    readoutClass: "txt-zoom",
    initial: zoomIdx,
    format: (i: number) => zoomLabel(i),
    onStep: (dir) => {
      const next = clampZoomIdx(zoomIdx + dir);
      if (next !== zoomIdx) {
        zoomIdx = next;
        if (textPre) applyZoom(textPre, zoomIdx);
        seam.saveZoom(zoomIdx);
      }
      return zoomIdx;
    },
  });

  // Always enabled: plain text is always searchable.
  const findToggle = el("button", {
    class: "btn",
    type: "button",
    "aria-pressed": "false",
    "aria-label": "Find in this file",
    title: "Find in this file (Ctrl+F)",
    html: svg(VIEWER_IC.find, 1.8),
  });

  // Download is the raw `.txt`.
  const downloadLink = el("a", {
    class: "btn",
    hidden: true,
    "aria-label": "Download",
    title: "Download",
    html: svg(VIEWER_IC.down, 1.8),
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
  // Shown instead of Move to bin for a bin-origin open.
  const binActions = createBinViewerActions({
    getMeta: () => meta,
    onRestore: deps.onRestore,
    onPurge: deps.onPurge,
    onHistory: deps.onVersions ? (m, anchor) => deps.onVersions!(m, anchor, undefined) : undefined,
  });
  // Shown only in a history preview (and from the bin).
  const versionsBtn = el("button", {
    class: "btn",
    type: "button",
    "aria-label": "Version history",
    title: "Version history",
    html: svg(VIEWER_IC.restore, 1.7),
  });
  versionsBtn.addEventListener("click", () => {
    if (meta) deps.onVersions?.(meta, versionsBtn, previewVersion?.md5);
  });
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
      { kind: "custom", key: "zoom", el: zoomStepper.el, focus: zoomStepper.focus },
      { kind: "custom", key: "font-size", el: fontStepper.el, focus: fontStepper.focus },
      { kind: "custom", key: "find", el: findToggle, focus: [findToggle] },
    ],
    file: [
      { kind: "custom", key: "versions", el: versionsBtn, focus: [versionsBtn] },
      { kind: "custom", key: "download-file", el: downloadLink, focus: [downloadLink] },
      { kind: "custom", key: "move-bin", el: moveBin, focus: [moveBin] },
      { kind: "custom", key: "bin-actions", el: binActions.el, focus: [binActions.trigger] },
    ],
  });

  // ---- find bar ----
  // Steps between matching paragraphs rather than pages.
  const findInput = el("input", {
    type: "text",
    autocomplete: "off",
    placeholder: "Find in this file",
    "aria-label": "Find in this file",
  }) as HTMLInputElement;
  const findCount = el("span", { class: "txtbar__count", role: "status", "aria-live": "polite" });
  // The manual-fuzzy opt-in: offered when exact find is empty but fuzzy found
  // matches; reveals the already-computed held result.
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
  // Own class, not `.findbar`: both viewers are mounted and the reader's tests
  // query `.findbar` globally.
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

  function showPlaceholder(title: string, body: string): void {
    textPre = null;
    loadedText = null;
    main.classList.remove("viewer__main--text");
    viewerBody.showPlaceholder(title, body);
  }

  function showText(text: string): void {
    // Device-authored content: textContent, never innerHTML.
    const pre = el("pre", { class: "txt__sheet", text }) as HTMLPreElement;
    pre.style.fontSize = `${size}px`;
    applyZoom(pre, zoomIdx);
    textPre = pre;
    loadedText = text;
    main.classList.add("viewer__main--text");
    main.replaceChildren(pre);
    // A `?q=` deep link primed find before the bytes arrived; run it now.
    if (findOpen && findQuery !== "") runFind(findQuery, findToken);
  }

  // ---- find ----

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

  /** Keeps the same `<pre>` so the font size persists. */
  function clearFindMarks(): void {
    findSegs = [];
    findParas = [];
    findAt = -1;
    findSearching = false;
    findAsk.hidden = true;
    if (textPre && loadedText !== null) textPre.replaceChildren(document.createTextNode(loadedText));
  }

  /** Scrolls only on a landing or a step. */
  function focusCurrent(scroll = true): void {
    for (const [i, p] of findParas.entries()) p.classList.toggle("is-current", i === findAt);
    const cur = findParas[findAt];
    // `scrollIntoView` is absent under the test DOM.
    if (cur && scroll) cur.scrollIntoView?.({ block: "center", inline: "nearest" });
  }

  /**
   * On a landing, settle on the deep link's target if it matched, else the first
   * match, and scroll there; otherwise keep the current paragraph and do not
   * scroll (so revealing a held fuzzy answer keeps the reader's place).
   */
  function renderFind(landing: boolean): void {
    if (!textPre || loadedText === null) return;
    const built = buildFindContent(loadedText, findSegs);
    textPre.replaceChildren(...built.nodes);
    findParas = built.paras;
    if (landing) {
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
    // The URL follows where find actually landed.
    syncUrl();
  }

  /** Reveal the held fuzzy matches; nothing is re-queried. */
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
   * One call, one complete answer. The abort covers only the fetch; the index
   * build and query are the work the next keystroke needs anyway.
   */
  async function runFind(query: string, mine: number): Promise<void> {
    if (loadedText === null || !meta?.fileHash) return;
    // Also set here because a `?q=` deep link calls this directly, bypassing `setFindQuery`.
    findSearching = true;
    paintFindCount();
    const ac = new AbortController();
    findAbort = ac;
    try {
      const result = await deps.docSearch.search(meta.fileHash, query, ac.signal);
      if (mine !== findToken || loadedText === null) return;
      // A segment without a byte range cannot be placed, so it is dropped.
      const located = result.segments.flatMap((s) =>
        s.offset === null || s.length === null
          ? []
          : [{ segment: s.segment, offset: s.offset, length: s.length, matches: s.matches, terms: s.terms }],
      );
      // A fuzzy fallback that found something is held for the opt-in; the
      // fallback itself only ran because exact found 0.
      if (result.usedFuzzy && !findOptedIn) {
        const segs = resolveFindSegments(loadedText, located);
        clearFindMarks();
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
      if (dispatchApiFailure({ onSessionExpired: deps.onSessionExpired }, e)) return;
      // Anything else (e.g. text not derived yet) leaves the text unmarked; the
      // next keystroke retries.
      clearFindMarks();
      paintFindCount();
    }
  }

  function setFindQuery(raw: string): void {
    const q = raw.trim();
    if (q === findActive) return;
    findActive = q;
    findQuery = q;
    findToken++;
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
    // The waiting state starts at the keystroke, so the old count is never shown.
    paintFindCount();
    const mine = findToken;
    findTimer = setTimeout(() => {
      findTimer = undefined;
      void runFind(q, mine);
    }, VIEWER_DEBOUNCE_MS);
  }

  /** Wraps unconditionally: the answer is complete when it lands. */
  function stepFind(dir: 1 | -1): void {
    const n = findSegs.length;
    if (n === 0) return;
    findAt = (findAt + dir + n) % n;
    focusCurrent();
    syncUrl();
  }

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
  findAsk.addEventListener("click", () => searchSimilar());
  findInput.addEventListener("input", () => {
    setFindQuery(findInput.value);
    queueUrlSync();
  });
  findInput.addEventListener("keydown", (e) => {
    // Handled explicitly: a stray `<form>` submit would reload the hash-routed SPA.
    if (e.key !== "Enter") return;
    e.preventDefault();
    stepFind(e.shiftKey ? -1 : 1);
  });
  findPrev.addEventListener("click", () => stepFind(-1));
  findNext.addEventListener("click", () => stepFind(1));

  // ---- URL ----
  // Query and current paragraph are kept in the URL via `deps.onPosition`.
  let urlTimer: ReturnType<typeof setTimeout> | undefined;
  function syncUrl(): void {
    if (urlTimer !== undefined) {
      clearTimeout(urlTimer);
      urlTimer = undefined;
    }
    if (!meta || root.hidden) return;
    const ordinal = findOpen && findAt >= 0 && findSegs[findAt] ? findSegs[findAt]!.segment : 0;
    // Bin opens use the `#/bin/note/:id/page/:n` form (no query); history previews
    // ride the version md5; live opens get the bare URL with `?q=`.
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

  function onKey(e: KeyboardEvent): void {
    if (root.hidden) return;
    if (e.key === "Escape") {
      if (findOpen) {
        closeFind();
        return;
      }
      return deps.onBack();
    }
    // Claimed only while this viewer is up.
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
      load?.abort();
      resetFind();

      // Before the `metaPromise` await, so a re-open during it cancels this one.
      const ctl = new AbortController();
      load = ctl;

      // Clear `meta` until the new one lands: the shell skips `hide()` between two
      // files of the same type, and Move to bin would otherwise trash the old file.
      meta = null;

      root.hidden = false;
      header.setName(summary.name);
      header.setSubtitle(summary.fileType.toUpperCase());
      header.setBackWord(backWord(origin));
      fromBin = origin.kind === "bin";
      previewVersion = origin.kind === "history" ? (origin.version ?? null) : null;
      const previewing = previewVersion !== null;
      previewViewOnly = previewing && origin.viewOnly === true;
      moveBin.hidden = fromBin || previewing;
      versionsBtn.hidden = !previewing && !fromBin;
      binActions.setBinMode(fromBin, fromBin ? origin.retention ?? null : null);
      versionBanner.setVersion(previewVersion, previewViewOnly);
      const download = previewing
        ? historyFileUrl(summary.id, previewVersion!.md5, { download: true, bin: previewViewOnly })
        : rawFileUrl(summary.id, summary.fileHash, { download: true, bin: fromBin });
      downloadLink.hidden = download === null;
      if (download !== null) downloadLink.href = download;

      // A `?q=` deep link primes find; the query fires from `showText` and
      // `page` (the paragraph ordinal) is the scroll target.
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

      // Null when the entry has no content hash.
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
          if (ctl.signal.aborted) return;
          showText(text);
        })
        .catch((err) => {
          if (ctl.signal.aborted) return;
          if (err instanceof TxtLoadError && (err.status === 401 || err.status === 403)) {
            deps.onSessionExpired();
            return;
          }
          showPlaceholder("Couldn’t read this file", "The text couldn’t be loaded. You can still download the original.");
        });

      back.focus();
      // Publishes a history preview's version URL when no `?q=` will.
      syncUrl();
    },

    hide(): void {
      load?.abort();
      load = null;
      resetFind();
      textPre = null;
      loadedText = null;
      previewVersion = null;
      previewViewOnly = false;
      main.classList.remove("viewer__main--text");
      main.replaceChildren(placeholder);
      root.hidden = true;
      meta = null;
    },

    destroy(): void {
      load?.abort();
      load = null;
      resetFind();
      document.removeEventListener("keydown", onKey);
    },
  };
}
