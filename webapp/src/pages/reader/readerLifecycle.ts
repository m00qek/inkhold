// The reader's lifecycle: opening a note (live, from the bin or as a version preview), and closing it.

import type { NoteMeta, NoteSummary, PageRef } from "../../core/types";
import { type LazyEngine } from "../../render/lazy";
import { dispatchApiFailure, type ApiFailureSink } from "../../api/client";
import { fileKind, formatBytes, rawFileUrl, historyFileUrl } from "../../core/fileKind";
import { createOcrController } from "../ocrPanel";
import { createFindController } from "../findInNote";
import { createReaderExports } from "./readerExports";
import { type FileStage } from "../fileStage";
import { createFindBarView, createVersionBanner } from "./readerBars";
import { createZoomStepper, FIT_PAGE } from "../viewer/viewerControls";
import { createViewerExportMenu } from "../viewer/viewerExportMenu";
import { backWord, createViewerHeader } from "../viewer/viewerChrome";
import { createBinViewerActions } from "../../ui/binViewerActions";
import { relativeTime, absoluteTime } from "../../ui/relativeTime";
import { createPageIndex } from "../pageIndex";
import { createLinkLayer } from "../linkLayer";
import type { PdfLink } from "../../core/types";
import { DEFAULT_PAGE_DIMS, skeletonPage } from "../../core/noteSkeleton";
import { createNoteLayersController } from "../noteLayers";
import type { ReaderState } from "./readerState";
import { createReaderNav } from "./readerNav";
import { createReaderPanels } from "./readerPanels";
import { createReaderPaint } from "./readerPaint";
import { type Reader, type ReaderOrigin, LIBRARY_ORIGIN, subtitle } from "./reader";

export interface ReaderLifecycleParts {
  currentPage: () => PageRef | undefined;
  setDownload: (url: string | null) => void;
  showNoPreview: (m: NoteMeta, title: string, body: string) => void;
  showImage: (m: NoteMeta, url: string) => void;
  header: () => ReturnType<typeof createViewerHeader>;
  back: () => HTMLElement;
  noteLayerCtl: () => ReturnType<typeof createNoteLayersController>;
  linkLayer: () => ReturnType<typeof createLinkLayer>;
  pageIndexPanel: () => ReturnType<typeof createPageIndex>;
  files: () => FileStage;
  zoomStepper: () => ReturnType<typeof createZoomStepper>;
  exportMenu: () => ReturnType<typeof createViewerExportMenu>;
  moveBin: () => HTMLElement;
  versionsBtn: () => HTMLElement;
  binActions: () => ReturnType<typeof createBinViewerActions>;
  versionBanner: () => ReturnType<typeof createVersionBanner>["el"];
  versionBannerText: () => ReturnType<typeof createVersionBanner>["text"];
  restoreVersionBtn: () => ReturnType<typeof createVersionBanner>["restore"];
  findInput: () => ReturnType<typeof createFindBarView>["input"];
  root: () => HTMLElement;
  showPage: () => ReturnType<typeof createReaderPaint>["showPage"];
  buildFilmstrip: () => ReturnType<typeof createReaderPaint>["buildFilmstrip"];
  setMode: () => ReturnType<typeof createReaderPanels>["setMode"];
  refreshFindUi: () => ReturnType<typeof createReaderPanels>["refreshFindUi"];
  refreshLayersUi: () => ReturnType<typeof createReaderPanels>["refreshLayersUi"];
  findQuery: () => ReturnType<typeof createReaderNav>["findQuery"];
  syncUrl: () => ReturnType<typeof createReaderNav>["syncUrl"];
  onKey: () => ReturnType<typeof createReaderNav>["onKey"];
  failures: () => ApiFailureSink;
  ocr: () => ReturnType<typeof createOcrController>;
  linksByPage: () => Map<string, readonly PdfLink[]>;
  find: () => ReturnType<typeof createFindController>;
  downloads: () => ReturnType<typeof createReaderExports>;
  filmEngine: () => LazyEngine;
}

export function createReaderLifecycle(st: ReaderState, p: ReaderLifecycleParts) {
  /** Shared teardown for close and hide. */
  function closeReader(): void {
    st.open = false;
    if (st.urlTimer !== undefined) {
      clearTimeout(st.urlTimer);
      st.urlTimer = undefined;
    }
    p.exportMenu().setOpen(false);
    p.ocr().reset();
    p.find().reset();
    p.findInput().value = "";
    // A closed reader holds no decoded RGBA (~10 MB per layer).
    st.layersPanelOpen = false;
    st.layersAvail = "unknown";
    p.noteLayerCtl().release();
    p.refreshLayersUi()();
    st.previewVersion = null;
    st.previewViewOnly = false;
    p.restoreVersionBtn().hidden = false;
    p.versionBanner().hidden = true;
    p.root().classList.remove("is-previewing");
    p.root().classList.remove("is-open");
    p.root().setAttribute("aria-hidden", "true");
    document.removeEventListener("keydown", p.onKey());
    p.filmEngine().reset();
    // Also keeps a reopen from flashing the previous image.
    p.files().clear();
    p.linkLayer().clear();
    p.linksByPage().clear();
    st.meta = null;
  }

  const readerApi: Reader = {
    el: p.root(),

    async open(summary: NoteSummary, metaPromise: Promise<NoteMeta>, startPage = 0, origin: ReaderOrigin = LIBRARY_ORIGIN, query = ""): Promise<void> {
      // Applying the route: no URL writes until the end (see `urlSuspended`).
      st.urlSuspended = true;
      // Background freshness refreshes re-call `open()` for the same file; only
      // a different file resets menus, find and panels.
      const changedFile = st.meta?.id !== summary.id;

      // Never replace a resolved meta with a skeleton on a same-file re-open.
      const keepResolved = !changedFile && st.metaResolved && st.meta !== null;
      st.summaryRecognized = summary.hasRecognizedText;
      // Skeleton: page 0 from the summary, the rest placeholders (empty hash).
      const aspect = summary.thumbAspect ?? DEFAULT_PAGE_DIMS;
      const skeletonMeta: NoteMeta = {
        id: summary.id,
        name: summary.name,
        fileType: summary.fileType,
        fileHash: summary.fileHash,
        // Listing rows don't carry the pairing.
        annotationsId: null,
        size: 0,
        pxPerMm: null,
        pages: Array.from({ length: summary.pageCount }, (_, i) =>
          i === 0 ? summary.firstPage : skeletonPage(i, aspect),
        ),
      };
      if (!keepResolved) st.metaResolved = false;
      // ONE assignment, so `meta` is provably non-null for the rest of `open`.
      st.meta = keepResolved && st.meta ? st.meta : skeletonMeta;
    
      if (changedFile) p.exportMenu().setOpen(false);
      const kind = fileKind(summary.fileType);

      p.header().setName(st.meta.name);
      p.header().setBackWord(backWord(origin));
      // A bin-origin file is already trashed: Restore/Delete replace Move to bin.
      st.fromBin = origin.kind === "bin";
      // A history preview is a third context: only Restore-this-version, on the banner.
      st.previewVersion = origin.kind === "history" ? (origin.version ?? null) : null;
      const previewing = st.previewVersion !== null;
      st.previewViewOnly = previewing && origin.viewOnly === true;
      p.moveBin().hidden = st.fromBin || previewing;
      // Versions: a real `.note` (live or bin), or any history preview.
      const isRealNote = st.meta.fileType.trim().toLowerCase() === "note";
      p.versionsBtn().hidden = !isRealNote && !previewing;
      p.binActions().setBinMode(st.fromBin, st.fromBin ? origin.retention ?? null : null);
      // The exact timestamp rides `title`.
      p.versionBanner().hidden = !previewing;
      p.restoreVersionBtn().hidden = st.previewViewOnly;
      p.root().classList.toggle("is-previewing", previewing);
      if (previewing && st.previewVersion) {
        p.versionBannerText().textContent = `You're viewing a version from ${relativeTime(st.previewVersion.createdAt)} — this is not the current note.`;
        p.versionBannerText().title = absoluteTime(st.previewVersion.createdAt);
      }
      // A new file starts with the panel closed and no transcript carried over.
      p.ocr().reset();
      // A query carried across files would count one note over another's pages.
      if (changedFile) {
        p.find().reset();
        p.findInput().value = "";
        // One file's layers must never label another's pixels.
        st.layersPanelOpen = false;
        st.layersAvail = "unknown";
        p.noteLayerCtl().release();
        p.refreshLayersUi()();
        // Page index back to default open, only on a real file change.
        st.pageIndexOpen = true;
      }
      p.setMode()(kind);
      p.root().classList.add("is-open");
      p.root().setAttribute("aria-hidden", "false");
      st.open = true;
      document.addEventListener("keydown", p.onKey());

      if (kind === "note") {
        // Clamped once; a deep link past the end lands on the last page.
        st.pageIndex = Math.max(0, Math.min(st.meta.pages.length - 1, Math.floor(startPage)));
        st.zoom = FIT_PAGE;
        p.zoomStepper().set(FIT_PAGE);
        p.header().setSubtitle(
          subtitle(origin, `${st.meta.pages.length} ${st.meta.pages.length === 1 ? "page" : "pages"}`),
        );
        p.setDownload(null);
        // In a preview the live raw route would serve the current blob, so use the version's.
        p.downloads().setRawHref(
          previewing
            ? historyFileUrl(st.meta.id, st.previewVersion!.md5, { download: true, bin: st.previewViewOnly })
            : rawFileUrl(st.meta.id, st.meta.fileHash, { download: true, bin: st.fromBin }),
        );
        // Before the filmstrip (badges need the page list). The last argument:
        // the skeleton's `textHash: null`s are invented, so they count only when
        // the listing also says unrecognised.
        p.find().setNote(st.meta.id, st.meta.fileHash, st.meta.pages, st.metaResolved || !st.summaryRecognized);
        p.buildFilmstrip()();
        // Prime find through the normal path; `setQuery` ignores a repeated query.
        const primed = p.findQuery()(query);
        if (primed) {
          p.findInput().value = primed;
          p.find().open();
          p.find().setQuery(primed);
        }
        // Paint after the overlay has laid out so the stage has real dimensions.
        requestAnimationFrame(() => void p.showPage()(st.pageIndex));
      } else {
        st.pageIndex = 0;
        // Nothing to find in a PDF or an image: no recognition, no word boxes.
        p.find().reset();
        p.findInput().value = "";
        p.filmEngine().reset();
        p.pageIndexPanel().clear();
        p.header().setSubtitle(subtitle(origin, `${st.meta.fileType.toUpperCase()} · ${formatBytes(st.meta.size)}`));
        // Bin and history previews need their own routes (see the note branch).
        p.setDownload(
          previewing
            ? historyFileUrl(st.meta.id, st.previewVersion!.md5, { download: true, bin: st.previewViewOnly })
            : rawFileUrl(st.meta.id, st.meta.fileHash, { download: true, bin: st.fromBin }),
        );

        const preview = previewing
          ? historyFileUrl(st.meta.id, st.previewVersion!.md5, { bin: st.previewViewOnly })
          : rawFileUrl(st.meta.id, st.meta.fileHash, { bin: st.fromBin });
        if (kind === "image" && preview) {
          p.showImage(st.meta, preview);
        } else {
          p.showNoPreview(
            st.meta,
            st.meta.name,
            preview === null
              ? "This file has no stored contents to preview or download yet."
              : "There's no preview for this file type. Download it to open it in another app.",
          );
        }
      }

      // Keep focus on the find field when the route asked for a search.
      if (!(kind === "note" && p.findQuery()(query))) p.back().focus();

      st.urlSuspended = false;
      // Publish once; this canonicalises a clamped page or a blank query.
      p.syncUrl()();

      // The real metadata. Must catch: the shell does not await `open`.
      let realMeta: NoteMeta;
      try {
        realMeta = await metaPromise;
      } catch (e) {
        if (!st.open || st.meta?.id !== summary.id) return;
        // Non-session failures leave the readable skeleton on screen.
        dispatchApiFailure(p.failures(), e);
        return;
      }
      if (!st.open || st.meta?.id !== realMeta.id) return;

      const paintedPage = st.meta?.pages[st.pageIndex];
      st.meta = realMeta;
      st.metaResolved = true;
      // The page list is authoritative now.
      p.refreshFindUi()();

      if (kind === "note") {
        p.header().setSubtitle(
          subtitle(origin, `${st.meta.pages.length} ${st.meta.pages.length === 1 ? "page" : "pages"}`),
        );
        p.find().setNote(st.meta.id, st.meta.fileHash, st.meta.pages);
        p.buildFilmstrip()();
        // Repaint only if the page changed: `buildFilmstrip` just emptied the
        // blur-up source, so an unconditional repaint flashes white.
        const nextPage = st.meta.pages[st.pageIndex];
        const alreadyPainted = paintedPage?.hash !== "" && paintedPage?.hash === nextPage?.hash;
        // Also repaint when the page gains layers (synthesized summaries, skeleton pages).
        const gainedLayers = (nextPage?.layers?.length ?? 0) > 0 && !paintedPage?.layers?.length;
        if (!alreadyPainted || gainedLayers) void p.showPage()(st.pageIndex);
      } else {
        p.header().setSubtitle(subtitle(origin, `${st.meta.fileType.toUpperCase()} · ${formatBytes(st.meta.size)}`));
      }
    },

    close: closeReader,

    // Switching to another viewer is a full close (see the doc on {@link Reader.hide}).
    hide: closeReader,

    isOpen(): boolean {
      return st.open;
    },

    bumpTheme(): void {
      // Non-note modes are ordinary themed DOM.
      if (st.mode !== "note") return;
      p.filmEngine().bumpTheme();
      if (st.open && p.currentPage()) void p.showPage()(st.pageIndex);
    },

    destroy(): void {
      document.removeEventListener("keydown", p.onKey());
      p.exportMenu().destroy();
      p.filmEngine().destroy();
      p.pageIndexPanel().destroy();
      p.noteLayerCtl().release();
    },
  };

  return { closeReader, readerApi };
}
