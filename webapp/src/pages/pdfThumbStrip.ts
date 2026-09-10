// The PDF PAGE INDEX's PAINT — the engine behind the filmstrip the viewer docks
// on its left.
//
// The STRIP is shared (`pages/pageIndex.ts`). What lives here is the one thing
// that is the PDF's own — how a row's pixels are produced — because a PDF page
// comes from the worker's session and nothing else in the app can produce one.
//
// WHY A THUMBNAIL IS NOT FREE HERE, unlike in the reader. A `.note` page is an
// independent byte range and its thumbnail is one decode. A PDF page is a walk
// through a shared resource graph: rendering page 40's thumbnail can pull fonts,
// colour spaces and images from anywhere in the file, over the network, one
// suspended round trip at a time. So the paint is gated TWICE — on the row being
// inside the strip's window (the component's job) and on it actually being on
// screen (the observer's).
//
// EVERY PIECE OF VIEWER STATE THIS READS ARRIVES AS A GETTER
// ({@link PdfThumbStripState}), never as a value handed over once: the document
// md5, the paired `.mark` and the previewed version all move underneath a paint
// already in flight, and the queue's cancellation rules can only notice that by
// asking again.

import { el } from "../ui/dom";
import type { Hash, Id, PageRef, Theme } from "../core/types";
import type { RenderCache, RenderKey } from "../cache/types";
import { createPageIndex, type PageIndex, type PageIndexRow } from "./pageIndex";
import { placePanelOverPage } from "../render/markGeometry";
import type { PdfSession } from "../render/pdfClient";

/** A page-index thumbnail's long edge in CSS pixels. Small on purpose — see
 *  `paintThumbs`: a PDF thumbnail is not a free decode. */
const THUMB_PX = 120;

/**
 * A thumbnail's identity in the SHARED cache (`sn-thumbs` — see
 * `webapp/ARCHITECTURE.md`, "there is one cache").
 *
 * A PDF page has no server-side content hash — the FILE has an md5 and the pages
 * do not — so one is synthesised. It is still honestly content-addressed: the
 * md5 pins the bytes, the index pins the page, and a blob is immutable.
 *
 * THE BARE PAGE, and only that. A row that also carries a `.mark`'s handwriting
 * is a picture of TWO blobs and is keyed by both — see {@link pdfThumbKey},
 * which is what every caller should ask.
 *
 * `size: "thumb"` is not decoration — it is what admits the entry to the
 * PERSISTENT tier (`renderCache.ts:125`), the whole reason for using the shared
 * cache rather than a private map.
 *
 * The theme is the LIVE one even though a PDF raster does not depend on it.
 * Pinning a constant would put these entries outside `evictTheme`'s model, which
 * would then drop them on a theme toggle without knowing they were theme-free;
 * consistency costs one duplicate thumbnail per page per theme.
 */
export function pdfPageThumbKey(docHash: string, index: number, theme: Theme): RenderKey {
  return { hash: `${docHash}:p${index}` as Hash, size: "thumb", theme };
}

/**
 * A thumbnail's identity when a `.mark` writes on that page — the PDF's md5,
 * the page, AND the mark page's own content hash.
 *
 * WITHOUT the second half this feature is a caching bug. A row's picture depends
 * on two blobs, and `PageRef.hash` is the one thing that moves when the
 * handwriting does — so under the bare `${md5}:p${i}` key an ink-free entry
 * written a moment before the mark landed would be served for the rest of the
 * store's life, and re-annotating a page on the device would show yesterday's
 * strokes.
 *
 * The ink-free key is NOT retired: it still names the bare page, which is what
 * a row painted before the mark arrives really is, and `paintThumbs` reads it
 * back as the base to composite ON rather than re-rendering the page.
 */
export function pdfThumbKey(
  docHash: string,
  index: number,
  theme: Theme,
  ref: PageRef | undefined,
  previewMd5: string | null,
): RenderKey {
  if (!ref) return pdfPageThumbKey(docHash, index, theme);
  // UNDER AN ANNOTATION PREVIEW THE INK IS A DIFFERENT BLOB, and `ref.hash` is
  // the LIVE mark page's — the page list comes from the live mark either way,
  // because that is what maps mark pages onto PDF pages. Keying on it alone
  // would hand the preview the live handwriting straight out of the persistent
  // cache: a strip showing today's strokes beside a banner saying these are
  // last week's. The version md5 is what actually names these bytes, so under a
  // preview it is what names the picture.
  const ink = previewMd5 ? `${previewMd5}:${ref.index}` : ref.hash;
  return { hash: `${docHash}:p${index}+${ink}` as Hash, size: "thumb", theme };
}

/**
 * The viewer state a paint reads, ASKED FOR AT EVERY STEP rather than captured.
 *
 * Every one of these moves under a paint that is already in flight — another
 * document is opened, `loadMark` lands, `release()` closes the handle — and the
 * queue is built to catch that. A snapshot taken at construction, or even at
 * the head of a paint, would defeat it.
 */
export interface PdfThumbStripState {
  /** The decoder session, or null when there is no document open. */
  session(): PdfSession | null;
  /** Is a document open? A closed handle must never be rendered through. */
  isOpen(): boolean;
  /** The viewer's generation counter — bumped per open and per teardown. */
  generation(): number;
  /** The open document's md5 — half of a thumbnail's cache identity. */
  docHash(): string;
  /** The paired `.mark`'s id, once its page list has been fetched. */
  markId(): Id | null;
  /** The mark's pages, keyed by the PDF page they annotate. SPARSE. */
  markPages(): ReadonlyMap<number, PageRef>;
  /** The annotation version being previewed — it SALTS the composite key. */
  previewVersion(): { md5: string } | null;
}

export interface PdfThumbStripOptions {
  /** The shared seams: the render cache, the theme, the mark's page bytes. */
  deps: {
    cache: RenderCache;
    getTheme: () => Theme;
    api: { getPageBytes(id: Id, ref: PageRef): Promise<ArrayBuffer> };
  };
  state: PdfThumbStripState;
  /**
   * A `.mark` page's ink, decoded and reduced into a canvas of this size
   * (`noteLayers.ts`'s `inkRaster` — it touches no state the viewer's own
   * overlay owns, which is why the strip may call it while a page is on screen).
   */
  inkRaster(
    bytes: ArrayBuffer,
    dst: { width: number; height: number },
  ): Promise<HTMLCanvasElement | null>;
  /** The reader picked a row. */
  onPick(index: number): void;
}

export interface PdfThumbStrip {
  /**
   * The strip itself. The viewer owns where it is docked and what it is told
   * about the document (`setPages`, `setCurrent`, `setBadges`, `setInk`); this
   * module owns only what goes on the canvases.
   */
  readonly panel: PageIndex;
  /** Page 0's aspect — every row's reserved shape until its own is known. */
  setFirstAspect(aspect: number): void;
  /** A `.mark` landed after the strip painted: send its rows round again. */
  repaintInked(): void;
  /** Forget every thumbnail: a new document, or none. */
  reset(): void;
  /** The strip and the observer that drives it. */
  destroy(): void;
}

export function createPdfThumbStrip(opts: PdfThumbStripOptions): PdfThumbStrip {
  const { deps, state, inkRaster } = opts;

  /**
   * Where the strip's thumbnails came from, published on `__inkholdPdfThumbs`.
   *
   * ALL OF THIS IS INVISIBLE WHEN IT WORKS, which is why it is counted at all.
   * A regression that re-renders every thumbnail, or probes rows one at a time,
   * paints exactly the same pixels — only slower, and only on hardware nobody
   * tests on. Two mutations of this file (closing a bitmap the cache owns, and
   * skipping the read-through entirely) passed the whole suite before this
   * existed.
   *
   * `inked` counts rows COMPOSITED with a `.mark`'s handwriting, for the sharper
   * version of the same problem: on the one fixture this app has, every stroke
   * inside the page's rect belongs to a device-hidden layer, so the composite is
   * pixel-identical to the bare page and a viewer that never asked for the ink
   * at all would look exactly right. `probe` is the largest batch the parallel
   * cache pass asked for at once.
   */
  const thumbCounts = { hits: 0, renders: 0, inked: 0, probe: 0 };
  function publishThumbCounts(): void {
    (globalThis as unknown as { __inkholdPdfThumbs?: typeof thumbCounts }).__inkholdPdfThumbs = {
      ...thumbCounts,
    };
  }

  /** Rows inside the strip's window, by page index. The paint's whole world. */
  const thumbRows = new Map<number, PageIndexRow>();
  /** Indices seen by the observer and not yet painted, nearest-first. */
  const thumbQueue: number[] = [];
  /** Indices whose canvas currently holds a finished thumbnail. */
  const thumbPainted = new Set<number>();
  /**
   * Page sizes learned from a thumbnail render, so a row that scrolls out and
   * back is rebuilt at the shape it was CORRECTED to rather than reverting to
   * page 0's guess.
   */
  const thumbAspects = new Map<number, number>();
  /** Page 0's aspect — every row's reserved shape until its own is known. */
  let firstAspect = 1 / Math.SQRT2; // A4 portrait, if page 0 will not measure
  let thumbsBusy = false;

  const pagesPanel = createPageIndex({
    id: "pdf-pages-panel",
    // The look is shared with the reader deliberately; the hook is what lets a
    // selector mean THIS strip (a bare `.filmstrip` matches both viewers).
    stripHook: "pdf-filmstrip",
    // A PDF page with ink on it was ANNOTATED, not written — same stroke in the
    // gutter, but the word a screen reader hears follows the document.
    inkWord: "annotated",
    onPick: (i) => opts.onPick(i),
    aspect: (i) => thumbAspects.get(i) ?? firstAspect,
    // Every PDF row starts unpainted: there is no cheap stand-in for a page we
    // have not rastered.
    loading: () => true,
    mount: (row) => {
      thumbRows.set(row.index, row);
      thumbObserver().observe(row.el);
    },
    unmount: (row) => {
      thumbObserver().unobserve(row.el);
      thumbRows.delete(row.index);
      // Its canvas is about to be zeroed, so whatever was on it is gone: forget
      // the paint too, or the row would come back blank and never be redrawn.
      thumbPainted.delete(row.index);
      const at = thumbQueue.indexOf(row.index);
      if (at >= 0) thumbQueue.splice(at, 1);
    },
  });

  /**
   * ONE observer for the whole strip, rooted on the panel (which owns the
   * overflow). Built lazily because its root is the panel we are constructing.
   */
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
            // Scrolled away before we got to it: drop it rather than spend a
            // round trip on a page nobody is looking at.
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

  /** The bare page's key, for the document that is open now. */
  function pageThumbKey(index: number): RenderKey {
    return pdfPageThumbKey(state.docHash(), index, deps.getTheme());
  }

  /** The key this row's picture is due — bare or composite, live or previewed. */
  function thumbKey(index: number): RenderKey {
    return pdfThumbKey(
      state.docHash(),
      index,
      deps.getTheme(),
      state.markPages().get(index),
      state.previewVersion()?.md5 ?? null,
    );
  }

  /** A cache read that can never sink a thumbnail. */
  async function cachedThumb(key: RenderKey): Promise<ImageBitmap | undefined> {
    try {
      return await deps.cache.get(key);
    } catch {
      return undefined;
    }
  }

  /**
   * An annotated page's thumbnail: the page raster with the mark's ink over it,
   * as ONE bitmap. Null when there is no ink to add — no mark bytes, a payload
   * that would not decode, or no canvas — and the caller then shows the page
   * alone, which is what the on-screen overlay does with the same failures.
   *
   * A NEW BITMAP RATHER THAN A DRAW ON THE ROW. The row's canvas is recycled by
   * the virtual list and is not what the cache stores; composing into a bitmap
   * keeps "what the strip shows" and "what the cache holds under the inked key"
   * the same picture, which is the whole point of {@link pdfThumbKey}.
   *
   * `page` is left ALONE — it may be the cache's, and the cache closes what it
   * owns.
   */
  async function compositeInk(page: ImageBitmap, ref: PageRef): Promise<ImageBitmap | null> {
    const id = state.markId();
    if (!id || page.width <= 0 || page.height <= 0) return null;
    // THE SAME ARITHMETIC THE PAGE USES, at 120px (`render/markGeometry.ts`).
    // The ink is in device PANEL pixels and the page is a letterboxed sub-rect
    // of that panel, so the whole panel is placed oversized and shifted until
    // its page-rect lands on the raster; the canvas edge clips the overhang the
    // way `.pdf-stage` does on screen.
    //
    // The raster's own pixels stand in for the page's POINTS, which is exact
    // rather than approximate: `fitPageInPanel` divides the panel by the page on
    // both axes and takes the smaller, so scaling the page by any factor leaves
    // the fit unchanged. That is what saves a `pageSize` round trip on the path
    // where the page raster came out of the cache.
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
      // WHOLE PIXELS. A stroke reduced to this size is a pixel or two wide and a
      // fractional offset would resample it into a smear — the same reasoning
      // `markExportSpace` states about `dx`/`dy`.
      ctx.drawImage(ink, Math.round(place.left), Math.round(place.top));
      const out = await createImageBitmap(sheet);
      sheet.width = 0;
      sheet.height = 0;
      return out;
    } catch {
      return null;
    } finally {
      // The ink canvas is ours by contract (`inkRaster`); free it eagerly rather
      // than at a GC that has no idea what a canvas weighs.
      ink.width = 0;
      ink.height = 0;
    }
  }

  /**
   * PHASE ONE: every queued row's cache entry, asked for AT ONCE.
   *
   * The serial rule the misses follow is about the DECODER, and there is no
   * decoder and no network in an IndexedDB read followed by a `drawImage`. The
   * hit is also the COMMON case — a blob is immutable, so its thumbnail is
   * cached forever and every revisit is all hits — and serially those are one
   * round trip each, so reopening a 77-page document repaints a strip that could
   * have painted in one frame.
   *
   * The batch bounds itself: the observer only queues rows inside the strip's
   * window plus its 200px margin, so this is five to fifteen reads, not
   * seventy-seven. Misses are left in the queue untouched.
   *
   * No bitmap is closed here and none is put: the cache owns what it returns, and
   * with no writes in flight nothing can be evicted out from under the blits.
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
        // Resolved BEFORE the await, exactly as the serial pass does it: a mark
        // landing mid-probe must not let a row be fetched under one identity and
        // painted under another.
        return { i, row, hit: await cachedThumb(thumbKey(i)) };
      }),
    );
    if (mine !== state.generation()) return;

    const painted = new Set<number>();
    for (const { i, row, hit } of probed) {
      if (!hit) continue; // a miss stays queued for the serial pass
      // Recycled while the batch was in flight. The strip builds a fresh row per
      // index and observes it on mount, so this page is queued again and finds
      // the same entry.
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
   * Paint queued thumbnails: the cache hits together, then the misses ONE AT A
   * TIME.
   *
   * Serial on the misses. The decoder is a single worker behind a single wasm
   * instance, so concurrent renders would queue there anyway — but they would
   * ALSO interleave their range fetches, so a page the user is actually reading
   * would wait behind six thumbnails.
   *
   * AND AN ANNOTATED ROW IS COMPOSITED HERE, which is the second reason. A mark
   * page decodes at the DEVICE PANEL's own resolution — ~10.5 MB of RGBA per
   * layer, whatever size the thumbnail ends up — so two of these in flight is
   * 20 MB of transient. `inkRaster` reduces and releases one layer at a time and
   * this loop guarantees one page at a time, so the peak is a single layer.
   */
  async function paintThumbs(): Promise<void> {
    if (thumbsBusy) return;
    thumbsBusy = true;
    try {
      // The hits first and together; then the misses, one at a time.
      await drainCachedThumbs();
      while (thumbQueue.length > 0) {
        const i = thumbQueue.shift()!;
        if (thumbPainted.has(i)) continue;
        const row = thumbRows.get(i);
        const s = state.isOpen() ? state.session() : null;
        if (!s || !row) continue;
        const mine = state.generation();
        // THE INK THIS ROW IS DUE, resolved ONCE, and the key that follows from
        // it. Everything below awaits, and `loadMark` can fill `markPages` in
        // mid-flight — reading either again at each step would let the row be
        // fetched under one identity and stored under another. The change is
        // caught at the bottom instead, where there is a finished picture to
        // leave up while the second pass runs.
        const ref = state.markPages().get(i);
        const key = thumbKey(i);

        // READ-THROUGH. A row that scrolls out and back is recycled by the
        // virtual list, so without this every return trip would re-render the
        // page — MuPDF work plus, on a cold block, network. The cache OWNS the
        // bitmap it returns (`renderCache.ts:113`: callers blit synchronously
        // and never close it), so this path draws and stops there.
        if (state.docHash()) {
          const hit = await cachedThumb(key);
          if (mine !== state.generation()) return;
          const cur = thumbRows.get(i);
          if (hit) {
            // A cached page is DONE either way: a row that scrolled out from
            // under us has nothing to draw on, but falling through would
            // re-render it through MuPDF (and on a cold block re-fetch it) only
            // to discard the pixels. It is queued afresh when it comes back.
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

        // THE PAGE UNDER THE INK. For an annotated row the ink-free twin is a
        // legitimate entry of its own — written by whatever painted this row
        // before the mark landed — and it is the page at exactly the size this
        // thumbnail wants, so reading it back makes the late-mark repaint cost a
        // decode instead of a second MuPDF render and, on a cold block, a second
        // range fetch. It is the CACHE'S bitmap: never closed here.
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
            // A page that will not render is left as an empty frame, not an error
            // card: the strip is navigation, and a broken thumbnail must not stop
            // you reaching the page it stands for.
            row.setLoading(false);
            thumbPainted.add(i);
            continue;
          }
          thumbCounts.renders++;
          publishThumbCounts();
        }

        // THE INK, for a page that has any. A failure here is a MISSING OVERLAY,
        // not a broken row — the same rule `paintMark` states for the page on
        // screen — so the bare page stands and is stored under its own key.
        let thumb = base ?? frame!.bitmap;
        let ours = base === undefined; // the cache owns what it handed back
        let inked = false;
        // The bare page, once a composite has REPLACED it on the row. It cost a
        // MuPDF render, so it goes into the cache under its own key rather than
        // being closed — that is what makes every later repaint of this row a
        // decode instead of a second render.
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
          // DELIBERATELY NO SUPERSEDED CHECK HERE. Fetching and decoding a mark
          // page is the longest await in this loop, so leaving the document
          // mid-composite is the COMMON way out of it — and the write-through
          // below is built for exactly that: pixels valid for this page forever
          // are handed over first, and only then does the paint find out it has
          // been overtaken. An early return throws away a MuPDF render the app
          // has already paid for.
        }

        // WRITE-THROUGH, and deliberately BEFORE the superseded check: the
        // render already happened and its pixels are valid for this page
        // forever, so handing them to the cache turns a scroll-past into work
        // that is not wasted. Ownership passes here — from this point the
        // bitmap must NOT be closed, because the cache's LRU closes it on
        // eviction and a double close would poison the entry.
        //
        // UNDER THE KEY THE PIXELS ACTUALLY ARE. A page whose ink would not
        // fetch or decode is stored as what it is — the bare page — so the inked
        // key is never occupied by an ink-free picture that would then be served
        // in preference to ever trying again. And a base that came OUT of the
        // cache is not put back: it is already there, under that same key.
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

        // Superseded — by another document, or by the row scrolling out of the
        // window and its canvas being recycled under us. The pixels have nowhere
        // legitimate to go; close them only if the cache did not take them.
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
        // DID THIS ROW'S IDENTITY MOVE WHILE IT WAS BEING PAINTED? `loadMark`
        // resolves on its own schedule, so a page can acquire ink between the
        // read at the top and the draw here — and nothing else would ever repaint
        // it. The pixels above are the best thing to show meanwhile (a page
        // without its ink beats a skeleton), so they stay up and the row goes
        // round again; the second pass finds the page it just cached and adds the
        // handwriting to it.
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
   * A `.mark` landed after the strip had already painted: the rows it writes on
   * are now the wrong picture, so send them round again.
   *
   * ONLY THE FINISHED ONES. A row still in the queue has not read its key yet
   * and picks up the new one for free; a row outside the strip's window has no
   * canvas to correct and is queued afresh when it scrolls back. The old pixels
   * are deliberately LEFT UP rather than reset to the loading treatment: a strip
   * that flashes back to skeletons the instant the mark arrives looks like a
   * fault.
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

  /** Forget every thumbnail: a new document, or none. */
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
