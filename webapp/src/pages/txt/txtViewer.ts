// The `.txt` viewer: fetches the raw file, decodes UTF-8 and lays it out in a
// `<pre>` reading column. Two persisted knobs: zoom sets the column's width,
// font size the glyph size (which reflows the column). Network and storage sit
// behind {@link TxtSeam} for unit tests.

import { el } from "../../ui/dom";
import type { NoteMeta, NoteSummary } from "../../core/types";
import { formatBytes, rawFileUrl, historyFileUrl } from "../../core/fileKind";
import { readLocal, writeLocal } from "../../ui/storage";
import { bytesBudget } from "../../api/client";
import { createToolbar } from "../toolbar";
import { createTxtFind } from "./txtFindController";
import { svg, VIEWER_IC } from "../viewer/viewerIcons";
import { createZoomStepper, FIT_PAGE, FIT_WIDTH } from "../viewer/viewerControls";
import { VIEWER_DEBOUNCE_MS, backWord, createViewerHeader, createViewerBody, createVersionBanner } from "../viewer/viewerChrome";
import { createBinViewerActions } from "../../ui/binViewerActions";
import type { ReaderOrigin, Viewer, ViewerDeps } from "../viewer/viewer";

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
function defaultTxtSeam(): TxtSeam {
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

  let loadedText: string | null = null;

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
    html: svg(VIEWER_IC.trash, 1.8) + '<span class="btn__label">Move to bin</span>',
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
      { kind: "custom", key: "zoom", el: zoomStepper.el, focus: zoomStepper.focus, fold: true },
      { kind: "custom", key: "font-size", el: fontStepper.el, focus: fontStepper.focus },
      { kind: "custom", key: "find", el: findToggle, focus: [findToggle], top: true },
    ],
    file: [
      { kind: "custom", key: "versions", el: versionsBtn, focus: [versionsBtn] },
      { kind: "custom", key: "download-file", el: downloadLink, focus: [downloadLink] },
      { kind: "custom", key: "move-bin", el: moveBin, focus: [moveBin] },
      { kind: "custom", key: "bin-actions", el: binActions.el, focus: [binActions.trigger] },
    ],
  });


  const find = createTxtFind({
    docSearch: deps.docSearch,
    onSessionExpired: deps.onSessionExpired,
    toggle: findToggle,
    root: () => root,
    textPre: () => textPre,
    loadedText: () => loadedText,
    fileHash: () => meta?.fileHash,
    syncUrl: () => syncUrl(),
    queueUrlSync: () => queueUrlSync(),
  });

  const viewerBody = createViewerBody({ mark: "TXT" });
  const main = viewerBody.main;
  const placeholder = viewerBody.placeholder;
  const root = el(
    "section",
    { class: "viewer viewer--txt", "aria-label": "Text viewer", hidden: true },
    toolbar.el,
    versionBanner.el,
    find.bar,
    main,
  );


  /** Drops find state and any pending URL publish. */
  function resetFind(): void {
    if (urlTimer !== undefined) {
      clearTimeout(urlTimer);
      urlTimer = undefined;
    }
    find.reset();
  }

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
    find.onTextShown();
  }


  // ---- URL ----
  // Query and current paragraph are kept in the URL via `deps.onPosition`.
  let urlTimer: ReturnType<typeof setTimeout> | undefined;
  function syncUrl(): void {
    if (urlTimer !== undefined) {
      clearTimeout(urlTimer);
      urlTimer = undefined;
    }
    if (!meta || root.hidden) return;
    const ordinal = find.currentSegment();
    // Bin opens use the `#/bin/note/:id/page/:n` form (no query); history previews
    // ride the version md5; live opens get the bare URL with `?q=`.
    if (fromBin) {
      deps.onPosition?.(meta.id, ordinal, "", undefined, true);
      return;
    }
    deps.onPosition?.(meta.id, ordinal, find.isOpen() ? find.query() : "", previewVersion?.md5);
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
      if (find.isOpen()) {
        find.close();
        return;
      }
      return deps.onBack();
    }
    // Claimed only while this viewer is up.
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === "f" || e.key === "F")) {
      e.preventDefault();
      find.open();
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
      if (q !== "") find.prime(q, page);
      else find.setOpen(false);

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
