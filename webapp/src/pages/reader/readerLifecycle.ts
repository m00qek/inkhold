// The reader's lifecycle: opening a note (live, from the bin or as a version preview), and closing it.

import { isPhone } from "../../ui/breakpoints";
import type { NoteMeta, NoteSummary } from "../../core/types";
import { dispatchApiFailure } from "../../api/client";
import { fileKind, formatBytes, rawFileUrl, historyFileUrl, fileTypeLabel } from "../../core/fileKind";
import { FIT_PAGE } from "../viewer/viewerControls";
import { backWord } from "../viewer/viewerChrome";
import { relativeTime, absoluteTime } from "../../ui/relativeTime";
import { DEFAULT_PAGE_DIMS, skeletonPage } from "../../core/noteSkeleton";
import type { ReaderCtx } from "./readerContext";
import { type Reader, type ReaderOrigin, LIBRARY_ORIGIN, subtitle } from "./reader";

export function createReaderLifecycle(ctx: ReaderCtx): Reader {
  const { st } = ctx;
  /** Shared teardown for close and hide. */
  function closeReader(): void {
    st.open = false;
    if (st.urlTimer !== undefined) {
      clearTimeout(st.urlTimer);
      st.urlTimer = undefined;
    }
    ctx.exportMenu.setOpen(false);
    ctx.ocr.reset();
    ctx.find.reset();
    ctx.findBar.input.value = "";
    // A closed reader holds no decoded RGBA (~10 MB per layer).
    st.layersPanelOpen = false;
    st.layersAvail = "unknown";
    ctx.noteLayerCtl.release();
    ctx.panels.refreshLayersUi();
    st.digestsOpen = false;
    ctx.digests.reset();
    ctx.panels.refreshDigestsUi();
    st.previewVersion = null;
    st.previewViewOnly = false;
    ctx.banner.restore.hidden = false;
    ctx.banner.el.hidden = true;
    ctx.root.classList.remove("is-previewing");
    ctx.root.classList.remove("is-open");
    ctx.root.setAttribute("aria-hidden", "true");
    document.removeEventListener("keydown", ctx.nav.onKey);
    ctx.filmEngine.reset();
    // Also keeps a reopen from flashing the previous image.
    ctx.files.clear();
    ctx.linkLayer.clear();
    ctx.linksByPage.clear();
    st.meta = null;
  }

  return {
    el: ctx.root,

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
    
      if (changedFile) ctx.exportMenu.setOpen(false);
      const kind = fileKind(summary.fileType);

      ctx.header.setName(st.meta.name);
      ctx.header.setBackWord(backWord(origin));
      // A bin-origin file is already trashed: Restore/Delete replace Move to bin.
      st.fromBin = origin.kind === "bin";
      // A history preview is a third context: only Restore-this-version, on the banner.
      st.previewVersion = origin.kind === "history" ? (origin.version ?? null) : null;
      const previewing = st.previewVersion !== null;
      st.previewViewOnly = previewing && origin.viewOnly === true;
      ctx.buttons.moveBin.hidden = st.fromBin || previewing;
      // Versions: a real `.note` (live or bin), or any history preview.
      const isRealNote = st.meta.fileType.trim().toLowerCase() === "note";
      ctx.buttons.versionsBtn.hidden = !isRealNote && !previewing;
      ctx.binActions.setBinMode(st.fromBin, st.fromBin ? origin.retention ?? null : null);
      // The exact timestamp rides `title`.
      ctx.banner.el.hidden = !previewing;
      ctx.banner.restore.hidden = st.previewViewOnly;
      ctx.root.classList.toggle("is-previewing", previewing);
      if (previewing && st.previewVersion) {
        ctx.banner.text.textContent = `You're viewing a version from ${relativeTime(st.previewVersion.createdAt)} — this is not the current note.`;
        ctx.banner.text.title = absoluteTime(st.previewVersion.createdAt);
      }
      // A new file starts with the panel closed and no transcript carried over.
      ctx.ocr.reset();
      // A query carried across files would count one note over another's pages.
      if (changedFile) {
        ctx.find.reset();
        ctx.findBar.input.value = "";
        // One file's layers must never label another's pixels.
        st.layersPanelOpen = false;
        st.layersAvail = "unknown";
        ctx.noteLayerCtl.release();
        ctx.panels.refreshLayersUi();
        // One note's digests must never sit beside another's pages.
        st.digestsOpen = false;
        ctx.digests.reset();
        ctx.panels.refreshDigestsUi();
        // Page index back to default open, only on a real file change. Closed
        // on a phone, where it opens as a sheet over the page.
        st.pageIndexOpen = !isPhone();
      }
      ctx.panels.setMode(kind);
      ctx.root.classList.add("is-open");
      ctx.root.setAttribute("aria-hidden", "false");
      st.open = true;
      document.addEventListener("keydown", ctx.nav.onKey);
      // A pinch belongs to the file it was made on.
      st.pinch = null;

      if (kind === "note") {
        // Clamped once; a deep link past the end lands on the last page.
        st.pageIndex = Math.max(0, Math.min(st.meta.pages.length - 1, Math.floor(startPage)));
        st.zoom = FIT_PAGE;
        ctx.zoomStepper.set(FIT_PAGE);
        ctx.header.setSubtitle(
          subtitle(origin, `${st.meta.pages.length} ${st.meta.pages.length === 1 ? "page" : "pages"}`),
        );
        ctx.setDownload(null);
        // In a preview the live raw route would serve the current blob, so use the version's.
        ctx.downloads.setRawHref(
          previewing
            ? historyFileUrl(st.meta.id, st.previewVersion!.md5, { download: true, bin: st.previewViewOnly })
            : rawFileUrl(st.meta.id, st.meta.fileHash, { download: true, bin: st.fromBin }),
        );
        // Before the filmstrip (badges need the page list). The last argument:
        // the skeleton's `textHash: null`s are invented, so they count only when
        // the listing also says unrecognised.
        ctx.find.setNote(st.meta.id, st.meta.fileHash, st.meta.pages, st.metaResolved || !st.summaryRecognized);
        ctx.paint.buildFilmstrip();
        // Prime find through the normal path; `setQuery` ignores a repeated query.
        const primed = ctx.nav.findQuery(query);
        if (primed) {
          ctx.findBar.input.value = primed;
          ctx.find.open();
          ctx.find.setQuery(primed);
        }
        // A trashed note's digests are the live file's business, not the bin's.
        const id = st.meta.id;
        if (!st.fromBin) ctx.digests.load(id, st.pageIndex, () => !st.open || st.meta?.id !== id);
        // Paint after the overlay has laid out so the stage has real dimensions.
        requestAnimationFrame(() => void ctx.paint.showPage(st.pageIndex));
      } else {
        st.pageIndex = 0;
        // Nothing to find in a PDF or an image: no recognition, no word boxes.
        ctx.find.reset();
        ctx.findBar.input.value = "";
        ctx.filmEngine.reset();
        ctx.pageIndexPanel.clear();
        ctx.header.setSubtitle(subtitle(origin, `${fileTypeLabel(st.meta.fileType)} · ${formatBytes(st.meta.size)}`));
        // Bin and history previews need their own routes (see the note branch).
        ctx.setDownload(
          previewing
            ? historyFileUrl(st.meta.id, st.previewVersion!.md5, { download: true, bin: st.previewViewOnly })
            : rawFileUrl(st.meta.id, st.meta.fileHash, { download: true, bin: st.fromBin }),
        );

        const preview = previewing
          ? historyFileUrl(st.meta.id, st.previewVersion!.md5, { bin: st.previewViewOnly })
          : rawFileUrl(st.meta.id, st.meta.fileHash, { bin: st.fromBin });
        if (kind === "image" && preview) {
          ctx.showImage(st.meta, preview);
        } else {
          ctx.showNoPreview(
            st.meta,
            st.meta.name,
            preview === null
              ? "This file has no stored contents to preview or download yet."
              : "There's no preview for this file type. Download it to open it in another app.",
          );
        }
      }

      // Keep focus on the find field when the route asked for a search.
      if (!(kind === "note" && ctx.nav.findQuery(query))) ctx.header.back.focus();

      st.urlSuspended = false;
      // Publish once; this canonicalises a clamped page or a blank query.
      ctx.nav.syncUrl();

      // The real metadata. Must catch: the shell does not await `open`.
      let realMeta: NoteMeta;
      try {
        realMeta = await metaPromise;
      } catch (e) {
        if (!st.open || st.meta?.id !== summary.id) return;
        // Non-session failures leave the readable skeleton on screen.
        dispatchApiFailure(ctx.failures, e);
        return;
      }
      if (!st.open || st.meta?.id !== realMeta.id) return;

      const paintedPage = st.meta?.pages[st.pageIndex];
      st.meta = realMeta;
      st.metaResolved = true;
      // The page list is authoritative now.
      ctx.panels.refreshFindUi();

      if (kind === "note") {
        ctx.header.setSubtitle(
          subtitle(origin, `${st.meta.pages.length} ${st.meta.pages.length === 1 ? "page" : "pages"}`),
        );
        ctx.find.setNote(st.meta.id, st.meta.fileHash, st.meta.pages);
        ctx.paint.buildFilmstrip();
        // Repaint only if the page changed: `buildFilmstrip` just emptied the
        // blur-up source, so an unconditional repaint flashes white.
        const nextPage = st.meta.pages[st.pageIndex];
        const alreadyPainted = paintedPage?.hash !== "" && paintedPage?.hash === nextPage?.hash;
        // Also repaint when the page gains layers (synthesized summaries, skeleton pages).
        const gainedLayers = (nextPage?.layers?.length ?? 0) > 0 && !paintedPage?.layers?.length;
        if (!alreadyPainted || gainedLayers) void ctx.paint.showPage(st.pageIndex);
      } else {
        ctx.header.setSubtitle(subtitle(origin, `${fileTypeLabel(st.meta.fileType)} · ${formatBytes(st.meta.size)}`));
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
      ctx.filmEngine.bumpTheme();
      if (st.open && ctx.currentPage()) void ctx.paint.showPage(st.pageIndex);
    },

    destroy(): void {
      document.removeEventListener("keydown", ctx.nav.onKey);
      ctx.exportMenu.destroy();
      ctx.filmEngine.destroy();
      ctx.pageIndexPanel.destroy();
      ctx.noteLayerCtl.release();
    },
  };

}
