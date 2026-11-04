// The library's engines: the thumbnail facade, the gallery's lazy engine, native image lazy-loading and library-wide search.

import { currentTheme } from "../../ui/theme";
import { createFolderCache } from "../folderCache";
import type { AppDeps } from "./library";
import type { Api } from "../../api/types";
import { type ApiFailureSink } from "../../api/client";
import { createLazyEngine, renderPage, type LazyEngine } from "../../render/lazy";
import {
  createThumbnails,
  createCanvasThumbPainter,
  createFetchThumbNet,
  type Thumbnails,
} from "../../render/thumbnails";
import { type PdfThumbs } from "../../render/pdfThumb";
import { createNoteSearch } from "../noteSearch";
import { createSearchService } from "../../search/searchService";
// The breadcrumb is painted here, but its flattening rule is the rail's.
import { type RailController } from "../rail";
// Paints into `gallery`; `renderGallery()` closes it, so no teardown hook.
// Static, unlike the console: small, and every user has one.
import type { LibraryState } from "./libraryState";
import { createLibraryRender } from "./libraryRender";

export interface LibraryEnginesParts {
  deps: AppDeps;
  renderer: () => AppDeps["renderer"];
  cache: () => AppDeps["cache"];
  api: () => Api;
  renderGallery: () => ReturnType<typeof createLibraryRender>["renderGallery"];
  failures: () => ApiFailureSink;
  folderCache: () => ReturnType<typeof createFolderCache>;
  rail: () => RailController;
  content: () => HTMLElementTagNameMap["div"];
  pdfThumbs: () => PdfThumbs;
  root: () => HTMLElement;
}

export function createLibraryEngines(st: LibraryState, p: LibraryEnginesParts) {
  const thumbnails: Thumbnails = createThumbnails({
    getTheme: currentTheme,
    net: createFetchThumbNet(),
    painter: createCanvasThumbPainter(),
    renderNote: (noteId, page, theme) => renderPage({ api: p.api(), renderer: p.renderer(), cache: p.cache(), theme }, noteId, page, "thumb"),
    renderPdfPage: p.pdfThumbs().renderPdfPage,
    persistent: p.deps.persistentThumbs,
  });

  const galleryEngine: LazyEngine = createLazyEngine({
    api: p.api(),
    renderer: p.renderer(),
    cache: p.cache(),
    getTheme: currentTheme,
    getThumbnail: thumbnails.getThumbnail,
    // Interim floor for a slow produce; see `PLACEHOLDER_AFTER_MS`.
    getGlyph: thumbnails.getGlyph,
    root: p.content(),
    failures: p.failures(),
  });

  // Native image tiles are lazy-loaded by us: Chromium never loads a
  // `loading="lazy"` `<img>` inserted already in the viewport during an SPA
  // re-render. `data-src` is promoted on approach.
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
          { root: p.content(), rootMargin: "200px" },
        )
      : null;

  const searchService = createSearchService({
    // Stands in for the manifest when this session never synced, so a full local
    // store stays searchable offline. Read fresh: the walk fills it later.
    listing: () =>
      [...p.folderCache().values()].flatMap((cached) =>
        cached.entries.flatMap((e) =>
          e.kind === "note" && e.fileHash
            // The numeric `fileId` is canonical; `gallerySearch` converts back.
            ? [{ md5: e.fileHash, fileId: Number(e.id), updatedAt: e.updatedAt }]
            : [],
        ),
      ),
  });

  const search = createNoteSearch({
    search: searchService,
    failures: p.failures(),
    view: {
      setState(next) {
        st.searchState = next;
        // Only engine-arrived states repaint here; `idle`/`searching` callers already render.
        if (next.kind !== "results" && next.kind !== "error") return;
        // One paint per answer: answers are whole. Drawn bitmaps come back off the
        // render cache.
        p.renderGallery()({ rail: false });
      },
    },
  });

  return { thumbnails, galleryEngine, imgLazy, searchService, search };
}
