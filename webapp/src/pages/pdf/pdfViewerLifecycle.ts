// The PDF viewer's document lifecycle: open a file (with its `.mark`), and
// release it.

import type { Id, NoteMeta, NoteSummary } from "../../core/types";
import { formatBytes, rawFileUrl, fileTypeLabel } from "../../core/fileKind";
import { FIT_PAGE } from "../viewer/viewerControls";
import { backWord, originSubtitle } from "../viewer/viewerChrome";
import type { ReaderOrigin } from "../viewer/viewer";
import { PdfLoadError } from "../../render/pdfClient";
import type { PdfViewerCtx } from "./pdfViewerContext";
import type { Viewer } from "../viewer/viewer";

export interface PdfLifecycle {
  open: Viewer["open"];
  /** Drops the document, its session and every per-document view; idempotent. */
  release(): void;
}

export function createPdfLifecycle(ctx: PdfViewerCtx): PdfLifecycle {
  const { st, deps, seam, findBar, binActions, body, downloads, find, header, moveBin, outlinePanel, pagesPanel, renderer, root, thumbs, versionBanner, zoomStepper, docks, exportMenu, findLayer, layersToggle, linkLayer, markCtl, selectLayer, markPages, setVersionsAvailable, setOutlineAvailable } = ctx;

  /**
   * The strip's ink rail, from the mark. No mark page means `false` (known); a
   * mark page without `hasInk` is left out, which blanks the rail (the strip's
   * all-or-nothing rule). No mark at all gives an empty map.
   */
  function refreshInk(): void {
    const inked = new Map<number, boolean>();
    if (markPages.size > 0) {
      for (let p = 0; p < st.pageCount; p++) {
        const ref = markPages.get(p);
        if (!ref) inked.set(p, false);
        else if (ref.hasInk !== undefined) inked.set(p, ref.hasInk);
      }
    }
    pagesPanel.setInk(inked);
  }

  /**
   * Index the `.mark`'s pages by PDF page (`sourcePage` is 1-based). Pages without
   * one are skipped rather than guessed, or ink lands on the wrong page.
   */
  async function loadMark(id: Id, mine: number): Promise<void> {
    let mm: NoteMeta;
    try {
      mm = await deps.api.getNoteMeta(id);
    } catch {
      return; // no annotations is a fine state; the PDF is the document
    }
    if (mine !== st.generation) return;
    st.markId = id;
    markPages.clear();
    layersToggle.hidden = false;
    for (const ref of mm.pages) {
      if (ref.sourcePage !== null && ref.sourcePage > 0) markPages.set(ref.sourcePage - 1, ref);
    }
    // The whole-document export row learns about ink here, not on visiting the page.
    downloads.refreshGroups();
    if (st.open_ && markPages.has(st.pageIndex)) void renderer.paint();
    // And the strip, which was painted before the mark landed.
    thumbs.repaintInked();
    refreshInk();
  }

  function release(): void {
    st.generation++; // anything in flight stops before it touches the handle
    if (st.open_ && st.session) {
      // Fire and forget; the worker serialises, so a later `open` cannot overtake it.
      void st.session.close().catch(() => {});
    }
    st.open_ = false;
    st.pageCount = 0;
    st.pageIndex = 0;
    st.markId = null;
    st.annotationsId = null;
    markPages.clear();
    // Preview state too: `thumbKey` salts on `previewVersion`.
    st.previewVersion = null;
    st.previewViewOnly = false;
    setVersionsAvailable(false);
    versionBanner.setVersion(null);
    // Released, not hidden: only `release` zeroes the full-resolution canvases.
    // A page turn does not come through here, so the stack survives paging.
    markCtl.release();
    markCtl.el.hidden = true;
    linkLayer.clear();
    find.reset();
    findBar.input.value = "";
    findLayer.clear();
    selectLayer.clear();
    renderer.reset();
    layersToggle.hidden = true;
    // Through `setDocks` so `aria-pressed` stays correct.
    docks.set(docks.left(), false, null, false);
    // The file-zone controls outlive the document, so forget their target.
    st.meta = null;
    thumbs.reset();
    outlinePanel.clear();
    setOutlineAvailable(false); // …which also shuts the panel and un-presses it
    ctx.digests.reset();
    downloads.refreshGroups();
    exportMenu.setOpen(false);
    // The raw href is per open; left set it would offer the previous file until metadata lands.
    downloads.setRawHref(null);
  }

  async function open(
    summary: NoteSummary,
    metaPromise: Promise<NoteMeta>,
    page: number,
    origin: ReaderOrigin,
    query: string,
  ): Promise<void> {
    release();
    const mine = st.generation;
    root.hidden = false;
    st.fromBin = origin.kind === "bin";
    /**
     * An annotation preview is the live document with the `.mark` rerouted to a
     * past version; only the ink and the chrome differ.
     */
    st.previewVersion = origin.kind === "history" ? (origin.version ?? null) : null;
    const previewing = st.previewVersion !== null;
    st.previewViewOnly = previewing && origin.viewOnly === true;
    // Set before metadata lands so the wrong pair never shows. A preview drops Move to bin.
    moveBin.hidden = st.fromBin || previewing;
    binActions.setBinMode(st.fromBin, st.fromBin ? (origin.retention ?? null) : null);
    // Up from the first frame, since it qualifies the page.
    versionBanner.setVersion(st.previewVersion, st.previewViewOnly);
    // Dimmed until metadata says there is a mark.
    setVersionsAvailable(false);
    header.setName(summary.name);
    header.setBackWord(backWord(origin));
    // The subtitle fills in: folder path, then size, then page count.
    header.setSubtitle(originSubtitle(origin, fileTypeLabel(summary.fileType || "pdf")));
    st.zoom = FIT_PAGE;
    st.pinch = null;
    // The stepper keeps its own label, so reset the readout too.
    zoomStepper.set(FIT_PAGE);
    st.pageIndex = Math.max(0, page);
    body.showPlaceholder(summary.name, "Opening this PDF…");
    ctx.nav.syncPager();
    // As every viewer: focus on ‹ (a keyboard's way back out), unless the
    // route asked for a search, whose field then keeps it.
    if (query.trim() === "") header.back.focus();

    if (!seam.supported()) {
      // MuPDF's error handling needs wasm exception handling.
      body.showPlaceholder(
        summary.name,
        "This browser can't preview PDFs. Download it to read it, or try a newer browser.",
      );
      return;
    }

    let m: NoteMeta;
    try {
      m = await metaPromise;
    } catch {
      if (mine !== st.generation) return;
      body.showPlaceholder(summary.name, "Couldn't read this file.");
      return;
    }
    if (mine !== st.generation) return;
    st.meta = m;
    st.docHash = m.fileHash ?? "";
    // The `.mark` loads without blocking; `loadMark` repaints when it lands.
    st.annotationsId = m.annotationsId;
    // "Has handwriting" comes from the pairing; "can paint it" is `loadMark`'s question.
    setVersionsAvailable(st.annotationsId !== null);
    if (m.annotationsId) void loadMark(m.annotationsId, mine);
    if (m.size > 0) header.setSubtitle(originSubtitle(origin, formatBytes(m.size)));
    const url = rawFileUrl(m.id, m.fileHash, { download: false, bin: st.fromBin });
    // Decided off the URL, never a read-back `href` (an empty one resolves to the
    // app). `null` disables only the raw row.
    downloads.setRawHref(rawFileUrl(m.id, m.fileHash, { download: true, bin: st.fromBin }));

    if (!url) {
      body.showPlaceholder(summary.name, "This file has no readable address.");
      return;
    }

    // No size gate: with range-served blocks page 1 costs only its own blocks.
    const s = (st.session ??= seam.createSession());
    let pages: number;
    try {
      ({ pageCount: pages } = await s.open(url, m.size));
      st.open_ = true;
    } catch (err) {
      if (mine !== st.generation) return;
      if (err instanceof PdfLoadError && (err.status === 401 || err.status === 403)) {
        deps.onSessionExpired();
        return;
      }
      // MuPDF's message goes to the console. It cannot tell "encrypted" from "not
      // a PDF" (the shim never calls `fz_needs_password`), so the only distinction
      // shown is bytes not arriving versus not opening.
      if (err instanceof PdfLoadError) {
        body.showPlaceholder(summary.name, "Couldn't load this PDF.");
      } else {
        console.warn("[pdf] open failed:", (err as Error).message ?? err);
        body.showPlaceholder(summary.name, "Couldn't read this file.");
      }
      return;
    }
    if (mine !== st.generation) return;
    st.pageCount = pages;
    header.setSubtitle(
      originSubtitle(origin, `${st.pageCount} ${st.pageCount === 1 ? "page" : "pages"}`),
    );
    if (st.pageCount === 0) {
      body.showPlaceholder(summary.name, "This PDF has no pages.");
      release();
      return;
    }
    st.pageIndex = Math.min(st.pageIndex, st.pageCount - 1);
    // Prime find from a `?q=` deep link, after the clamp. Bin URLs carry no query.
    find.setDocument(m.id, m.fileHash);
    find.setPage(st.pageIndex);
    if (query !== "") {
      findBar.input.value = query;
      find.open();
      find.setQuery(query);
    }
    // Only now is the page count known, so the URL can reflect the clamped page.
    ctx.nav.syncUrl();

    // Reserve every row's shape from this page's aspect; other sizes self-correct.
    try {
      const first = await s.pageSize(st.pageIndex);
      if (mine !== st.generation) return;
      if (first.height > 0) thumbs.setFirstAspect(first.width / first.height);
    } catch {
      // Keep the default aspect.
    }
    // The outline, once per document and not awaited; failure only dims the opener.
    void s
      .outline()
      .then((entries) => {
        if (mine !== st.generation) return;
        outlinePanel.setEntries(entries);
        outlinePanel.setCurrent(st.pageIndex);
        setOutlineAvailable(entries.length > 0);
      })
      .catch(() => {
        if (mine !== st.generation) return;
        setOutlineAvailable(false);
      });
    // A trashed document's digests are the live file's business, not the bin's.
    if (!st.fromBin) ctx.digests.load(summary.id, st.pageIndex, () => mine !== st.generation);
    pagesPanel.setPages(st.pageCount);
    // The mark may have landed already, so compute the rail here as well as in `loadMark`.
    refreshInk();
    pagesPanel.setCurrent(st.pageIndex);
    // First moment the export menu knows `pageCount`.
    downloads.refreshGroups();

    await renderer.paint();
    // Logs first-page cost; see `lastPdfStats`.
    if (mine === st.generation) void s.stats().catch(() => {});
  }

  return { open, release };
}
