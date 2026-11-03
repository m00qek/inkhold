// Paints the PDF page index's thumbnails. A PDF thumbnail is not one decode: a
// page can pull fonts and images from anywhere in the file over the network, so
// painting is gated on the row being in the strip's window and on screen.
// Viewer state arrives as getters because it moves under in-flight paints.

import { el } from "../ui/dom";
import type { Hash, Id, PageRef, Theme } from "../core/types";
import type { RenderCache, RenderKey } from "../cache/types";
import { createPageIndex, type PageIndex, type PageIndexRow } from "./pageIndex";
import { placePanelOverPage } from "../render/markGeometry";
import type { PdfSession } from "../render/pdfClient";

/** Thumbnail long edge, CSS px; small because a PDF thumbnail is expensive. */
const THUMB_PX = 120;

/**
 * The bare page's key in the shared cache, synthesised as `${md5}:p${index}`
 * (immutable blob, so still content-addressed). `size: "thumb"` admits it to the
 * persistent tier; the live theme is used so `evictTheme` handles it consistently.
 */
export function pdfPageThumbKey(docHash: string, index: number, theme: Theme): RenderKey {
  return { hash: `${docHash}:p${index}` as Hash, size: "thumb", theme };
}

/**
 * The key for a page a `.mark` writes on: PDF md5, page, and the mark page's
 * hash, which is what moves when the handwriting does. The bare key remains the
 * base `paintThumbs` composites onto.
 */
export function pdfThumbKey(
  docHash: string,
  index: number,
  theme: Theme,
  ref: PageRef | undefined,
  previewMd5: string | null,
): RenderKey {
  if (!ref) return pdfPageThumbKey(docHash, index, theme);
  // Under an annotation preview, `ref.hash` is still the live mark page's, so the
  // version md5 names the ink instead.
  const ink = previewMd5 ? `${previewMd5}:${ref.index}` : ref.hash;
  return { hash: `${docHash}:p${index}+${ink}` as Hash, size: "thumb", theme };
}

/** Read at every step, never captured: each value moves under an in-flight paint. */
export interface PdfThumbStripState {
  session(): PdfSession | null;
  /** A closed handle must never be rendered through. */
  isOpen(): boolean;
  /** Bumped per open and per teardown. */
  generation(): number;
  docHash(): string;
  markId(): Id | null;
  /** The mark's pages, keyed by the PDF page they annotate; sparse. */
  markPages(): ReadonlyMap<number, PageRef>;
  previewVersion(): { md5: string } | null;
}

export interface PdfThumbStripOptions {
  deps: {
    cache: RenderCache;
    getTheme: () => Theme;
    api: { getPageBytes(id: Id, ref: PageRef): Promise<ArrayBuffer> };
  };
  state: PdfThumbStripState;
  /** A `.mark` page's ink reduced into a canvas of this size; touches no viewer overlay state. */
  inkRaster(
    bytes: ArrayBuffer,
    dst: { width: number; height: number },
  ): Promise<HTMLCanvasElement | null>;
  onPick(index: number): void;
}

export interface PdfThumbStrip {
  /** The viewer owns docking and what the strip is told; this module owns the pixels. */
  readonly panel: PageIndex;
  setFirstAspect(aspect: number): void;
  repaintInked(): void;
  reset(): void;
  destroy(): void;
}

export function createPdfThumbStrip(opts: PdfThumbStripOptions): PdfThumbStrip {
  const { deps, state, inkRaster } = opts;

  /**
   * Thumbnail provenance published on `__inkholdPdfThumbs` for e2e tests: a
   * regression that re-renders or probes serially paints identical pixels, and
   * on the only fixture the inked composite is pixel-identical to the bare page.
   * `probe` is the largest parallel cache batch.
   */
  const thumbCounts = { hits: 0, renders: 0, inked: 0, probe: 0 };
  function publishThumbCounts(): void {
    (globalThis as unknown as { __inkholdPdfThumbs?: typeof thumbCounts }).__inkholdPdfThumbs = {
      ...thumbCounts,
    };
  }

  const thumbRows = new Map<number, PageIndexRow>();
  /** Observed and unpainted, nearest-first. */
  const thumbQueue: number[] = [];
  const thumbPainted = new Set<number>();
  /** Aspects learned from renders, so a recycled row keeps its corrected shape. */
  const thumbAspects = new Map<number, number>();
  let firstAspect = 1 / Math.SQRT2; // A4 portrait, if page 0 will not measure
  let thumbsBusy = false;

  const pagesPanel = createPageIndex({
    id: "pdf-pages-panel",
    stripHook: "pdf-filmstrip",
    inkWord: "annotated",
    onPick: (i) => opts.onPick(i),
    aspect: (i) => thumbAspects.get(i) ?? firstAspect,
    loading: () => true,
    mount: (row) => {
      thumbRows.set(row.index, row);
      thumbObserver().observe(row.el);
    },
    unmount: (row) => {
      thumbObserver().unobserve(row.el);
      thumbRows.delete(row.index);
      // The canvas is about to be zeroed, so forget the paint or it never redraws.
      thumbPainted.delete(row.index);
      const at = thumbQueue.indexOf(row.index);
      if (at >= 0) thumbQueue.splice(at, 1);
    },
  });

  /** One observer rooted on the panel, built lazily since its root is under construction. */
  let thumbIo: IntersectionObserver | null = null;
  function thumbObserver(): IntersectionObserver {
    thumbIo ??= new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const i = Number((e.target as HTMLElement).dataset.page);
          if (!Number.isFinite(i)) continue;
          if (e.isIntersecting) {
            if (!thumbPainted.has(i) && !thumbQueue.includes(i)) thumbQueue.push(i);
          } else {
            const at = thumbQueue.indexOf(i);
            if (at >= 0) thumbQueue.splice(at, 1);
          }
        }
        void paintThumbs();
      },
      { root: pagesPanel.el, rootMargin: "200px 0px" },
    );
    return thumbIo;
  }

  function pageThumbKey(index: number): RenderKey {
    return pdfPageThumbKey(state.docHash(), index, deps.getTheme());
  }

  function thumbKey(index: number): RenderKey {
    return pdfThumbKey(
      state.docHash(),
      index,
      deps.getTheme(),
      state.markPages().get(index),
      state.previewVersion()?.md5 ?? null,
    );
  }

  async function cachedThumb(key: RenderKey): Promise<ImageBitmap | undefined> {
    try {
      return await deps.cache.get(key);
    } catch {
      return undefined;
    }
  }

  /**
   * Page raster plus the mark's ink as a new bitmap (the row canvas is recycled
   * and is not what the cache stores), or null if there is no ink to add. `page`
   * may be the cache's and is never closed here.
   */
  async function compositeInk(page: ImageBitmap, ref: PageRef): Promise<ImageBitmap | null> {
    const id = state.markId();
    if (!id || page.width <= 0 || page.height <= 0) return null;
    // Same placement as on screen (`render/markGeometry.ts`): ink is in panel
    // pixels and the page is a letterboxed sub-rect. Raster pixels can stand in
    // for page points because the fit is scale-invariant, saving a `pageSize` call.
    const place = placePanelOverPage(
      { width: ref.width, height: ref.height },
      { width: page.width, height: page.height },
      { width: page.width, height: page.height },
    );
    if (place.width < 1 || place.height < 1) return null;
    let bytes: ArrayBuffer;
    try {
      bytes = await deps.api.getPageBytes(id, ref);
    } catch {
      return null;
    }
    const ink = await inkRaster(bytes, place);
    if (!ink) return null;
    try {
      const sheet = el("canvas") as HTMLCanvasElement;
      sheet.width = page.width;
      sheet.height = page.height;
      const ctx = sheet.getContext("2d");
      if (!ctx) return null;
      ctx.drawImage(page, 0, 0);
      // Whole pixels: a fractional offset smears a one-pixel stroke.
      ctx.drawImage(ink, Math.round(place.left), Math.round(place.top));
      const out = await createImageBitmap(sheet);
      sheet.width = 0;
      sheet.height = 0;
      return out;
    } catch {
      return null;
    } finally {
      ink.width = 0;
      ink.height = 0;
    }
  }

  /**
   * Phase one: every queued row's cache entry at once. Hits are the common case
   * (immutable blobs) and need no decoder, so serial reads would only add round
   * trips. The observer bounds the batch; misses stay queued. The cache owns the
   * bitmaps it returns.
   */
  async function drainCachedThumbs(): Promise<void> {
    if (!state.docHash() || !state.isOpen()) return;
    const batch = thumbQueue.filter((i) => !thumbPainted.has(i) && thumbRows.has(i));
    if (batch.length === 0) return;
    const mine = state.generation();
    thumbCounts.probe = Math.max(thumbCounts.probe, batch.length);

    const probed = await Promise.all(
      batch.map(async (i) => {
        const row = thumbRows.get(i)!;
        // Key resolved before the await so a mark landing mid-probe cannot split identities.
        return { i, row, hit: await cachedThumb(thumbKey(i)) };
      }),
    );
    if (mine !== state.generation()) return;

    const painted = new Set<number>();
    for (const { i, row, hit } of probed) {
      if (!hit) continue; // a miss stays queued for the serial pass
      // Recycled mid-batch; the fresh row is re-queued on mount.
      if (thumbRows.get(i) !== row) continue;
      thumbCounts.hits++;
      row.canvas.width = hit.width;
      row.canvas.height = hit.height;
      row.canvas.getContext("2d")?.drawImage(hit, 0, 0);
      row.setLoading(false);
      thumbPainted.add(i);
      painted.add(i);
    }
    if (painted.size === 0) return;
    publishThumbCounts();
    for (let n = thumbQueue.length - 1; n >= 0; n--) {
      if (painted.has(thumbQueue[n]!)) thumbQueue.splice(n, 1);
    }
  }

  /**
   * Hits together, then misses one at a time: the decoder is one worker, and
   * concurrent renders would interleave range fetches ahead of the page being
   * read. Serial also bounds compositing memory: a mark page decodes at panel
   * resolution (~10.5 MB RGBA per layer), so the peak stays one layer.
   */
  async function paintThumbs(): Promise<void> {
    if (thumbsBusy) return;
    thumbsBusy = true;
    try {
      await drainCachedThumbs();
      while (thumbQueue.length > 0) {
        const i = thumbQueue.shift()!;
        if (thumbPainted.has(i)) continue;
        const row = thumbRows.get(i);
        const s = state.isOpen() ? state.session() : null;
        if (!s || !row) continue;
        const mine = state.generation();
        // Ink and key resolved once: `loadMark` can fill `markPages` mid-flight.
        // A change is caught at the bottom, after drawing.
        const ref = state.markPages().get(i);
        const key = thumbKey(i);

        // Read-through. The cache owns the returned bitmap: blit, never close.
        if (state.docHash()) {
          const hit = await cachedThumb(key);
          if (mine !== state.generation()) return;
          const cur = thumbRows.get(i);
          if (hit) {
            // A hit is done either way; a recycled row is re-queued when it returns.
            if (cur === row) {
              thumbCounts.hits++;
              publishThumbCounts();
              row.canvas.width = hit.width;
              row.canvas.height = hit.height;
              row.canvas.getContext("2d")?.drawImage(hit, 0, 0);
              row.setLoading(false);
              thumbPainted.add(i);
            }
            continue;
          }
        }

        // For an annotated row, the cached bare page is the base, saving a MuPDF
        // render. It is the cache's bitmap: never closed here.
        let base: ImageBitmap | undefined;
        if (ref && state.docHash()) {
          base = await cachedThumb(pageThumbKey(i));
          if (mine !== state.generation()) return;
          if (base && thumbRows.get(i) !== row) continue; // recycled; it is queued afresh
        }

        let frame;
        if (base) {
          thumbCounts.hits++;
          publishThumbCounts();
        } else {
          try {
            const size = await s.pageSize(i);
            if (mine !== state.generation()) return;
            const scale = THUMB_PX / Math.max(size.width, size.height);
            if (size.height > 0) {
              const a = size.width / size.height;
              thumbAspects.set(i, a);
              row.setAspect(a);
            }
            frame = await s.render(i, scale);
          } catch {
            // An unrenderable page is an empty frame: the strip is still navigation.
            row.setLoading(false);
            thumbPainted.add(i);
            continue;
          }
          thumbCounts.renders++;
          publishThumbCounts();
        }

        // Ink failure is a missing overlay, not a broken row.
        let thumb = base ?? frame!.bitmap;
        let ours = base === undefined; // the cache owns what it handed back
        let inked = false;
        // The bare page once a composite replaces it; cached under its own key.
        let bare: ImageBitmap | null = null;
        if (ref) {
          const composed = await compositeInk(thumb, ref);
          if (composed) {
            if (ours) bare = thumb;
            thumb = composed;
            ours = true;
            inked = true;
            thumbCounts.inked++;
            publishThumbCounts();
          }
          // No superseded check here: leaving mid-composite is common, and the
          // write-through below should keep the render already paid for.
        }

        // Write-through before the superseded check, since the pixels are valid
        // forever. Ownership passes to the cache, whose LRU closes on eviction, so
        // never close after a put. Store under the key the pixels really are: an
        // ink failure goes under the bare key, never the inked one.
        const writeKey = ref && !inked ? pageThumbKey(i) : key;
        let owned = false;
        if (state.docHash() && ours) {
          try {
            await deps.cache.put(writeKey, thumb);
            owned = true;
          } catch {
            owned = false; // it never entered the cache, so it is still ours
          }
        }
        if (bare) {
          try {
            await deps.cache.put(pageThumbKey(i), bare);
          } catch {
            bare.close(); // it never entered the cache, so it is still ours
          }
        }

        // Superseded by a new document or a recycled row; close only if the cache did not take it.
        if (mine !== state.generation() || thumbRows.get(i) !== row) {
          if (ours && !owned) thumb.close();
          if (mine !== state.generation()) return;
          continue;
        }
        row.canvas.width = thumb.width;
        row.canvas.height = thumb.height;
        row.canvas.getContext("2d")?.drawImage(thumb, 0, 0);
        if (ours && !owned) thumb.close();
        row.setLoading(false);
        // If ink arrived while painting, keep these pixels up and queue the row again.
        if (thumbKey(i).hash !== key.hash) {
          thumbQueue.push(i);
          continue;
        }
        thumbPainted.add(i);
      }
    } finally {
      thumbsBusy = false;
    }
  }

  /**
   * Re-queue finished rows a late `.mark` writes on. Queued rows pick up the new
   * key anyway; old pixels stay up rather than flashing back to skeletons.
   */
  function repaintInkedThumbs(): void {
    let any = false;
    for (const i of state.markPages().keys()) {
      if (!thumbPainted.has(i)) continue;
      thumbPainted.delete(i);
      thumbQueue.push(i);
      any = true;
    }
    if (any) void paintThumbs();
  }

  function resetThumbs(): void {
    thumbCounts.hits = 0;
    thumbCounts.renders = 0;
    thumbCounts.inked = 0;
    thumbCounts.probe = 0;
    publishThumbCounts();
    pagesPanel.clear(); // unmounts each row, which unobserves and dequeues it
    thumbRows.clear();
    thumbQueue.length = 0;
    thumbPainted.clear();
    thumbAspects.clear();
    firstAspect = 1 / Math.SQRT2;
  }

  return {
    panel: pagesPanel,
    setFirstAspect(aspect: number): void {
      firstAspect = aspect;
    },
    repaintInked: repaintInkedThumbs,
    reset: resetThumbs,
    destroy(): void {
      pagesPanel.destroy();
      thumbIo?.disconnect();
    },
  };
}
