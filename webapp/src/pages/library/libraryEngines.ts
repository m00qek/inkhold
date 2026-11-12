// The library's engines: the thumbnail facade, the gallery's lazy engine, native image lazy-loading and library-wide search, with what it finds besides pages.

import { currentTheme } from "../../ui/theme";
import { createLazyEngine, renderPage } from "../../render/lazy";
import { createThumbnails, createCanvasThumbPainter, createFetchThumbNet } from "../../render/thumbnails";
import { createNoteSearch } from "../noteSearch";
import { createSearchService } from "../../search/searchService";
import type { LibraryCtx } from "./libraryContext";
import { createSearchItems, nameRows } from "./searchItems";
import { openItemStore } from "../../cache/itemStore";

/** Builds the thumbnail facade, the lazy engine, native image lazy-loading and library search onto `ctx`. */
export function installLibraryEngines(ctx: LibraryCtx): void {
  const { st } = ctx;
  ctx.thumbnails = createThumbnails({
    getTheme: currentTheme,
    net: createFetchThumbNet(),
    painter: createCanvasThumbPainter(),
    renderNote: (noteId, page, theme) => renderPage({ api: ctx.api, renderer: ctx.renderer, cache: ctx.cache, theme }, noteId, page, "thumb"),
    renderPdfPage: ctx.pdfThumbs.renderPdfPage,
    persistent: ctx.deps.persistentThumbs,
  });

  ctx.galleryEngine = createLazyEngine({
    api: ctx.api,
    renderer: ctx.renderer,
    cache: ctx.cache,
    getTheme: currentTheme,
    getThumbnail: ctx.thumbnails.getThumbnail,
    // Interim floor for a slow produce; see `PLACEHOLDER_AFTER_MS`.
    getGlyph: ctx.thumbnails.getGlyph,
    root: ctx.content,
    failures: ctx.failures,
  });

  // Native image tiles are lazy-loaded by us: Chromium never loads a
  // `loading="lazy"` `<img>` inserted already in the viewport during an SPA
  // re-render. `data-src` is promoted on approach.
  ctx.imgLazy =
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
          { root: ctx.content, rootMargin: "200px" },
        )
      : null;

  ctx.searchService = createSearchService({
    // Stands in for the manifest when this session never synced, so a full local
    // store stays searchable offline. Read fresh: the walk fills it later.
    listing: () =>
      [...ctx.folderCache.values()].flatMap((cached) =>
        cached.entries.flatMap((e) =>
          e.kind === "note" && e.fileHash
            // The numeric `fileId` is canonical; `gallerySearch` converts back.
            ? [{ md5: e.fileHash, fileId: Number(e.id), updatedAt: e.updatedAt }]
            : [],
        ),
      ),
  });

  // What search finds besides pages: names now, the apps' answers once their pages load.
  ctx.searchItems = createSearchItems({
    service: ctx.searchService,
    store: openItemStore(),
    names: () => nameRows(ctx.folderCache, (f) => ctx.rail.labelFor(f)),
    // Asked again at once while the results are on screen, else when they are painted next.
    onChanged: () => {
      ctx.search.stale();
      if (ctx.searchInView()) ctx.search.askIfStale();
    },
  });

  ctx.search = createNoteSearch({
    search: ctx.searchService,
    failures: ctx.failures,
    view: {
      setState(next) {
        st.searchState = next;
        // Only engine-arrived states repaint here; `idle`/`searching` callers already render.
        if (next.kind !== "results" && next.kind !== "error") return;
        // One paint per answer: answers are whole. Drawn bitmaps come back off the
        // render cache.
        ctx.render.renderGallery({ rail: false });
      },
    },
  });
}
