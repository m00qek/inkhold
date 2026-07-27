// The universal lazy-render primitive (P2). One rule, everywhere a thumbnail is
// drawn: NEVER paint an off-screen tile. Given a scroll root and a set of "slots"
// (each = a target element + which file it shows), it shows a static placeholder
// off-screen and, only when a slot scrolls into view (+ a preload margin), paints
// it once.
//
// A SLOT'S TARGET IS EITHER A <canvas> OR AN <img>, and that is the whole
// discriminant for HOW the finished image is displayed — the engine is not forked
// per surface, one paint() branches on the target's kind:
//
//   - <canvas> target (the reader filmstrip, the recycle bin): the engine decodes
//     the image to an `ImageBitmap` and blits it. Zoom-crisp, theme re-rendered,
//     and the bitmap lifetime is the render cache's (or a transient we close).
//   - <img> target (the library gallery): the engine sets `src` to an object URL
//     over the facade's WebP blob and the BROWSER owns decode and eviction — it
//     drops off-screen decoded pixels and re-decodes from the ~10-20 KB blob,
//     which is better memory behaviour on a phone than a hand-rolled bitmap LRU.
//     No `ImageBitmap` is decoded or held for a gallery tile.
//
// WHAT it paints is not this engine's business. The gallery injects a
// `getThumbnail` facade and the engine asks it for a WebP blob (which may be a
// `.note` page render, an extracted `.spd` thumbnail, an image, a `.txt` snippet
// or a glyph — the engine never learns which). The reader's filmstrip injects no
// facade and keeps the direct note-page pipeline:
//
//   cache.get → miss → api.getPageBytes → renderer.render → cache.put → blit
//
// This is the scheduling/what-to-paint boundary: the engine owns WHEN, the facade
// owns WHAT, and neither reaches into the other. `loading="lazy"` on an <img>
// composes as a native second line of defence for decode, but it does NOT replace
// the produce-when-near-viewport logic here: for a `.note` the blob is PRODUCED by
// a WASM render, which must stay gated on visibility.
//
// The painted result then stays put (no repaint on scroll). A theme toggle bumps
// a version and repaints ONLY the currently-visible slots; the rest drop back to
// placeholders so they re-lazy the next time they're scrolled in. This one engine
// backs the gallery thumbnails, the reader filmstrip, and the reader's main
// viewer (a single always-visible slot).
//
// Everything the DOM/observer touches is injectable (`observerFactory`, `blit`,
// `placeholder`, `schedule`, `createObjectUrl`/`revokeObjectUrl`) so the scheduler
// is unit-testable with a mocked IntersectionObserver, a stub renderer, and a stub
// api — asserting that off-screen slots never reach `renderer.render`, and that no
// object URL is leaked across a repaint or teardown.

import type { Hash, Id, PageRef, RenderSize, Theme } from "../core/types";
import type { Api } from "../api/types";
import { dispatchApiFailure, type ApiFailureSink } from "../api/client";
import type { NoteRenderer } from "../render/types";
import type { RenderCache } from "../cache/types";
import type { ThumbSource } from "./thumbnails";

export interface LazySlotInput {
  /**
   * Where this tile paints. A <canvas> (reader filmstrip, recycle bin) is blitted
   * with a decoded `ImageBitmap`; an <img> (gallery) is pointed at an object URL
   * over the facade's WebP blob, with the browser owning decode/eviction. The
   * target's kind — not the presence of a facade — decides the display path, so a
   * facade-backed tile can render onto either (the bin uses the facade AND a
   * canvas; the gallery uses the facade AND an <img>).
   */
  target: HTMLCanvasElement | HTMLImageElement;
  noteId: Id;
  /**
   * The note page this slot renders/reports. OPTIONAL only for a facade-driven
   * slot whose strategy never touches pages — the bin's `.spd`/`.txt`/image
   * rows, where the entry may honestly have no page ref at all. The direct
   * (no-facade) render path and the canvas placeholder both require it, so a
   * pageless slot without a facade is a caller bug and throws.
   */
  page?: PageRef;
  size: RenderSize;
  /**
   * Accessible name for an <img> target — the note/file name, so the tile is
   * announced the way the card's own title is. Ignored for a <canvas> target,
   * whose tile is labelled by the surrounding control.
   */
  alt?: string;
  /**
   * What this tile IS, for the thumbnail facade. Present only when the engine is
   * driven through `getThumbnail` (the gallery, the bin); absent for the reader's
   * own note-page slots, which keep the direct render pipeline. `fileType` picks
   * the strategy (`note`/`spd`/`txt`/image); `fileHash` is the content-address
   * the fetching strategies use — for a `.note` it is what the cover-first probe
   * asks `/thumbnail/{hash}` with. When omitted the tile is treated as a note
   * page with no hash (no cover probe, straight to the render). `bin` marks a
   * TRASHED file, so the facade's raw-file strategies mint the bin-scoped
   * route instead of the live one (see `ThumbSource.bin`).
   */
  thumb?: { fileType: string; fileHash: Hash | null; bin?: boolean; aspect?: { w: number; h: number } };
}

/** The bits of `IntersectionObserver` the engine uses — lets tests fake it. */
export interface ObserverLike {
  observe(target: Element): void;
  unobserve(target: Element): void;
  disconnect(): void;
}

/** Factory the engine calls with its handler; returns an observer to drive it. */
export type ObserverFactory = (
  onVisibility: (target: Element, isIntersecting: boolean) => void,
) => ObserverLike;

export interface LazyEngineDeps {
  api: Api;
  renderer: NoteRenderer;
  cache: RenderCache;
  /** Current theme — read fresh on every paint so mid-scroll toggles are honored. */
  getTheme: () => Theme;
  /**
   * The thumbnail facade. When provided, the engine asks it WHAT image a slot
   * shows (a WebP blob) instead of inlining the note-page pipeline — so a slot
   * can be a `.spd`, a `.txt` or an image, not only a note. When ABSENT the
   * engine keeps the direct `renderPage` path, which is what the reader's
   * filmstrip and main-viewer prefetch still use. This is the seam that keeps
   * "when to paint" (here) apart from "what to paint" (the facade): the engine
   * never learns a strategy, the facade never learns an IntersectionObserver.
   *
   * REQUIRED for an <img> target (the gallery): an <img> displays a blob, and the
   * facade is the only thing that produces one. A canvas target may use it (the
   * bin) or not (the reader).
   */
  getThumbnail?: (source: ThumbSource, fileType: string) => Promise<Blob>;
  /** Decode a facade blob to a blittable bitmap, for a CANVAS target only.
   *  Injectable for tests; defaults to `createImageBitmap`. */
  decode?: (blob: Blob) => Promise<ImageBitmap>;
  /** Scroll root for the default IntersectionObserver (null = viewport). */
  root?: Element | null;
  /** Preload margin. Default "120px 0px". */
  rootMargin?: string;
  /** Override the observer (tests). Default builds a real IntersectionObserver. */
  observerFactory?: ObserverFactory;
  /** Override the canvas blit (tests / custom sizing). */
  blit?: (canvas: HTMLCanvasElement, bitmap: ImageBitmap) => void;
  /** Override the off-screen placeholder paint (tests). Canvas targets only. */
  placeholder?: (canvas: HTMLCanvasElement, page: PageRef) => void;
  /** Mint an object URL for a blob (img targets). Injected so a Node test can
   *  assert no leak without a real Blob-URL registry. Default: the platform. */
  createObjectUrl?: (blob: Blob) => string;
  /** Revoke an object URL. Default: the platform. */
  revokeObjectUrl?: (url: string) => void;
  /** Defer the initial placeholder+observe past layout. Default rAF. */
  schedule?: (fn: () => void) => void;
  /**
   * Where an actionable page-fetch failure goes. The engine itself only knows how
   * to leave a placeholder up — it cannot re-authenticate or refetch metadata, and
   * a swallowed 401 leaves the user staring at a gallery of blank thumbnails
   * forever. So it reports UNAUTHORIZED / STALE_PAGE to its owner and keeps its own
   * behaviour (retry on the next intersection) unchanged. Optional: an engine with
   * no sink degrades to the previous swallow-and-retry.
   */
  failures?: ApiFailureSink;
}

export interface LazyEngine {
  /** Register a target to lazily paint when it scrolls into view. */
  add(input: LazySlotInput): void;
  /** Stop tracking a target (e.g. it was removed from the DOM). */
  remove(target: HTMLCanvasElement | HTMLImageElement): void;
  /** Forget every slot and disconnect the observer, keeping the engine reusable. */
  reset(): void;
  /** Repaint currently-visible slots for a new theme; drop the rest to re-lazy. */
  bumpTheme(): void;
  /** Repaint the slots that are on-screen right now (e.g. after a resize). */
  repaintVisible(): void;
  /** Warm the cache for a page without a canvas (reader neighbour prefetch). */
  prefetch(noteId: Id, page: PageRef, size: RenderSize): void;
  /** Tear down permanently. */
  destroy(): void;
}

/**
 * An object URL and the one call that frees it. `createObjectURL` pins the blob
 * in memory until `revokeObjectURL`, so this is the lifetime handle that replaces
 * the old `ImageBitmap.close()` discipline: hold it while an <img> displays the
 * URL, `release()` it on teardown or when a new URL replaces it. `release` is
 * idempotent — double teardown (remove after reset) must not double-revoke.
 */
interface ObjectUrlHandle {
  readonly url: string;
  release(): void;
}

interface Slot extends LazySlotInput {
  visible: boolean;
  painted: boolean;
  /** themeVersion the current paint is valid for; -1 = never painted. */
  themeV: number;
  inFlight: boolean;
  /** The object URL an <img> slot is currently pointed at, or null. Held so it
   *  can be revoked on replacement/teardown; always null for a canvas slot. */
  urlHandle: ObjectUrlHandle | null;
}

const DPR_CAP = 2;

/** True when a slot paints into an <img> (object-URL path) rather than a <canvas>
 *  (blit path). Reads `tagName` rather than `instanceof HTMLImageElement` so the
 *  engine stays usable in a DOM-less unit test — where the global constructor is
 *  undefined but a fake `{ tagName: "IMG" }` still routes correctly. */
function isImgTarget(target: { tagName?: string }): boolean {
  return target.tagName === "IMG";
}

/** Default canvas blit: size to the element's CSS box × DPR and draw scaled. */
function defaultBlit(canvas: HTMLCanvasElement, bitmap: ImageBitmap): void {
  const box = canvas.getBoundingClientRect();
  if (box.width < 1 || box.height < 1) return; // not laid out yet
  const dpr = Math.min(typeof devicePixelRatio !== "undefined" ? devicePixelRatio : 1, DPR_CAP);
  canvas.width = Math.round(box.width * dpr);
  canvas.height = Math.round(box.height * dpr);
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
}

/** Default placeholder: a blank ruled sheet (near-zero ink), matching the note
 * aesthetic. Colours come from the live CSS custom properties so it tracks theme. */
function defaultPlaceholder(canvas: HTMLCanvasElement, _page: PageRef): void {
  const box = canvas.getBoundingClientRect();
  if (box.width < 1 || box.height < 1) return;
  const dpr = Math.min(typeof devicePixelRatio !== "undefined" ? devicePixelRatio : 1, DPR_CAP);
  canvas.width = Math.round(box.width * dpr);
  canvas.height = Math.round(box.height * dpr);
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const styles = getComputedStyle(document.documentElement);
  const paper = styles.getPropertyValue("--sheet").trim() || "#fcfbf7";
  const rule = styles.getPropertyValue("--paper-rule").trim() || "rgba(0,0,0,0.06)";
  const accent = styles.getPropertyValue("--margin").trim() || "#bf5248";

  const w = box.width;
  const h = box.height;
  ctx.fillStyle = paper;
  ctx.fillRect(0, 0, w, h);

  const scale = w / 300;
  const padTop = 26 * scale;
  const lh = 20 * scale;
  const padX = 22 * scale;
  ctx.strokeStyle = rule;
  ctx.lineWidth = Math.max(0.5, 0.8 * scale);
  for (let y = padTop + lh; y < h - 12 * scale; y += lh) {
    ctx.beginPath();
    ctx.moveTo(padX * 0.5, y);
    ctx.lineTo(w - padX * 0.5, y);
    ctx.stroke();
  }
  ctx.strokeStyle = accent;
  ctx.globalAlpha = 0.3;
  ctx.beginPath();
  ctx.moveTo(padX * 1.6, padTop * 0.4);
  ctx.lineTo(padX * 1.6, h - 12 * scale);
  ctx.stroke();
  ctx.globalAlpha = 1;
}

function defaultObserverFactory(root: Element | null, rootMargin: string): ObserverFactory {
  return (onVisibility) =>
    new IntersectionObserver(
      (entries) => {
        for (const e of entries) onVisibility(e.target, e.isIntersecting);
      },
      { root, rootMargin, threshold: 0.01 },
    );
}

const idle: (fn: () => void) => void =
  typeof requestIdleCallback !== "undefined"
    ? (fn) => void requestIdleCallback(fn)
    : (fn) => void setTimeout(fn, 180);

/** The core L3 pipeline for one page: cache.get → miss → getPageBytes → render →
 * put. Shared by the lazy engine (thumbnails) and the reader's always-visible
 * viewer/prefetch, so there's a single place the cache-key contract lives. */
export async function renderPage(
  deps: { api: Api; renderer: NoteRenderer; cache: RenderCache; theme: Theme },
  noteId: Id,
  page: PageRef,
  size: RenderSize,
): Promise<ImageBitmap> {
  const key = { hash: page.hash, size, theme: deps.theme };
  const hit = await deps.cache.get(key);
  if (hit) return hit;
  const bytes = await deps.api.getPageBytes(noteId, page);
  const decoded = await deps.renderer.render({ bytes, noteId, page, size, theme: deps.theme });
  await deps.cache.put(key, decoded.bitmap);
  return decoded.bitmap;
}

export function createLazyEngine(deps: LazyEngineDeps): LazyEngine {
  const { api, renderer, cache, getTheme } = deps;
  const getThumbnail = deps.getThumbnail;
  const decode = deps.decode ?? ((blob: Blob) => createImageBitmap(blob));
  const blit = deps.blit ?? defaultBlit;
  const placeholder = deps.placeholder ?? defaultPlaceholder;
  const makeUrl = deps.createObjectUrl ?? ((blob: Blob) => URL.createObjectURL(blob));
  const dropUrl = deps.revokeObjectUrl ?? ((url: string) => URL.revokeObjectURL(url));
  const schedule = deps.schedule ?? ((fn) => void requestAnimationFrame(fn));
  const observerFactory =
    deps.observerFactory ?? defaultObserverFactory(deps.root ?? null, deps.rootMargin ?? "120px 0px");

  const slots = new Map<Element, Slot>();
  let themeVersion = 0;

  /** A blob → object-URL handle whose revoke is deferred to teardown/replacement. */
  function objectUrl(blob: Blob): ObjectUrlHandle {
    const url = makeUrl(blob);
    let released = false;
    return {
      url,
      release() {
        if (released) return;
        released = true;
        dropUrl(url);
      },
    };
  }

  /** Hand an actionable failure to the owner; no sink = the old silent retry.
   *  `page` is absent for the pageless facade slots — `dispatchApiFailure`
   *  already treats STALE_PAGE as undispatchable without one. */
  function report(e: unknown, noteId: Id, page?: PageRef): void {
    if (deps.failures) dispatchApiFailure(deps.failures, e, noteId, page);
  }

  const observer = observerFactory((target, isIntersecting) => {
    const slot = slots.get(target);
    if (!slot) return;
    slot.visible = isIntersecting;
    if (isIntersecting && (!slot.painted || slot.themeV !== themeVersion)) {
      void paint(slot);
    }
  });

  /**
   * The bitmap for a CANVAS slot, by whichever path this engine was wired for.
   *
   *  - FACADE path (`getThumbnail` injected — the bin): ask the facade WHAT image
   *    this tile shows, as a WebP blob, and decode it. The bitmap is a transient
   *    WE own and must close after the blit.
   *  - DIRECT path (the reader's filmstrip): the note-page pipeline, whose bitmap
   *    is owned by the render-cache LRU and must NOT be closed here.
   *
   * An <img> slot never comes here — it displays the facade blob directly, without
   * a decode (see `paintImg`).
   */
  async function produceBitmap(slot: Slot, theme: Theme): Promise<{ bitmap: ImageBitmap; owned: boolean }> {
    if (getThumbnail) {
      const blob = await getThumbnail(thumbSource(slot), slot.thumb?.fileType ?? "note");
      return { bitmap: await decode(blob), owned: true };
    }
    if (!slot.page) throw new Error("a slot without a page requires a thumbnail facade");
    const bitmap = await renderPage({ api, renderer, cache, theme }, slot.noteId, slot.page, slot.size);
    return { bitmap, owned: false };
  }

  function thumbSource(slot: Slot): ThumbSource {
    return {
      fileHash: slot.thumb?.fileHash ?? null,
      fileId: slot.noteId,
      noteId: slot.noteId,
      page: slot.page,
      bin: slot.thumb?.bin,
      aspect: slot.thumb?.aspect,
    };
  }

  /**
   * Point an <img> slot at a fresh object URL over the facade's WebP blob, and —
   * THE LOAD-BEARING HAZARD — revoke the URL it held before. `createObjectURL`
   * pins the blob in memory until revoked, so a leaked URL keeps a thumbnail's
   * bytes alive for the life of the document; a scroll that re-lazies a tile, or a
   * theme swap, would leak one per repaint. The NEW url is left live: the <img>
   * load is async and needs it, and it will be revoked in turn by the next
   * replacement or by `releaseSlot` on teardown.
   */
  function paintImg(slot: Slot, blob: Blob): void {
    const next = objectUrl(blob);
    const img = slot.target as HTMLImageElement;
    img.src = next.url;
    if (slot.alt !== undefined) img.alt = slot.alt;
    slot.urlHandle?.release(); // the previous paint's URL is now safe to drop
    slot.urlHandle = next;
  }

  /** Revoke a slot's live object URL, if any. Called on teardown/removal. */
  function releaseSlot(slot: Slot): void {
    slot.urlHandle?.release();
    slot.urlHandle = null;
  }

  /** Paint the off-screen placeholder for a slot. An <img> has none — an unset
   *  `src` shows the tile's own sheet background, which is the placeholder — so
   *  this is a no-op for an img target (and for the pageless facade slots,
   *  which are always <img>s anyway). */
  function paintPlaceholder(slot: Slot): void {
    if (isImgTarget(slot.target) || !slot.page) return;
    placeholder(slot.target as HTMLCanvasElement, slot.page);
  }

  async function paint(slot: Slot): Promise<void> {
    if (slot.inFlight) return;
    slot.inFlight = true;

    // DEBOUNCE: Yield briefly to let the IntersectionObserver catch up if the user
    // is scrolling extremely fast. If they scroll past before this resolves, the
    // slot is no longer visible, and we skip the expensive 10MB decode/scale pipeline.
    await new Promise((resolve) => setTimeout(resolve, 150));
    if (!slot.visible || !slots.has(slot.target)) {
      slot.inFlight = false;
      return;
    }

    const renderVersion = themeVersion;
    const theme = getTheme();
    try {
      if (isImgTarget(slot.target)) {
        // GALLERY: the facade answers with a WebP blob and the <img> displays it
        // as an object URL. No ImageBitmap is decoded or held — the browser owns
        // decode and eviction, which is the whole point of the <img> path.
        if (!getThumbnail) throw new Error("an <img> slot requires a thumbnail facade");
        const blob = await getThumbnail(thumbSource(slot), slot.thumb?.fileType ?? "note");
        // `slots.has` guards against a reset/remove that landed WHILE this fetch
        // was in flight (a gallery repaint on a folder change or live bump): the
        // slot is gone, so minting an object URL for it now would leak one nothing
        // will ever revoke. Skip it — the blob is dropped, the torn-down handle
        // was already revoked by `reset`/`remove`.
        if (renderVersion === themeVersion && slots.has(slot.target)) {
          paintImg(slot, blob);
          slot.painted = true;
          slot.themeV = renderVersion;
        } else {
          slot.painted = false;
        }
      } else {
        const { bitmap, owned } = await produceBitmap(slot, theme);
        // If the theme moved on, or the slot was torn down, while we were
        // fetching/rendering, this bitmap is for the wrong world — discard it and
        // let the trailing check re-lazy.
        if (renderVersion === themeVersion && slots.has(slot.target)) {
          blit(slot.target as HTMLCanvasElement, bitmap);
          slot.painted = true;
          slot.themeV = renderVersion;
        } else {
          slot.painted = false;
        }
        // A facade bitmap is a transient we decoded only to blit; free it now that
        // drawImage has copied it (or now that we've decided not to). A direct-path
        // bitmap belongs to the render cache (which closes it on eviction), so it
        // is left alone.
        if (owned) bitmap.close();
      }
    } catch (e) {
      // A render/fetch failure is non-fatal: leave the placeholder, retry on the
      // next intersection. The cache is never a source of truth. But the session
      // and staleness signals must still reach the owner — those two don't fix
      // themselves on a retry, and swallowing them is what froze the library.
      slot.painted = false;
      report(e, slot.noteId, slot.page);
    } finally {
      slot.inFlight = false;
    }
    // Theme changed mid-flight but the slot is still on screen: repaint fresh.
    // Keyed on `renderVersion` (did the theme move *during this paint*?) and NOT
    // on `slot.themeV`: a FAILED paint leaves `themeV` at its old value, so the
    // latter spins forever re-attempting a fetch that keeps throwing. A failure
    // must fall back to the placeholder and wait for the next intersection.
    if (slot.visible && renderVersion !== themeVersion) void paint(slot);
  }

  return {
    add(input: LazySlotInput): void {
      const slot: Slot = { ...input, visible: false, painted: false, themeV: -1, inFlight: false, urlHandle: null };
      slots.set(input.target, slot);
      schedule(() => {
        if (!slots.has(input.target)) return; // removed before layout
        paintPlaceholder(slot);
        observer.observe(input.target);
      });
    },

    remove(target: HTMLCanvasElement | HTMLImageElement): void {
      const slot = slots.get(target);
      if (!slot) return;
      releaseSlot(slot);
      slots.delete(target);
      observer.unobserve(target);
    },

    reset(): void {
      observer.disconnect();
      for (const slot of slots.values()) releaseSlot(slot);
      slots.clear();
    },

    bumpTheme(): void {
      themeVersion++;
      for (const slot of slots.values()) {
        if (slot.visible) void paint(slot);
        else {
          // Off-screen: drop to the placeholder and re-lazy on next view. An <img>
          // keeps its now-off-theme src until then (it is off-screen, so nobody
          // sees the wrong theme) and paints the correct theme when scrolled in —
          // which revokes this URL in `paintImg`. Revoking it here instead would
          // blank the tile with a broken image; leaving it is the no-leak choice.
          paintPlaceholder(slot);
          slot.painted = false;
        }
      }
    },

    repaintVisible(): void {
      for (const slot of slots.values()) {
        if (slot.visible) void paint(slot);
      }
    },

    prefetch(noteId: Id, page: PageRef, size: RenderSize): void {
      idle(async () => {
        try {
          await renderPage({ api, renderer, cache, theme: getTheme() }, noteId, page, size);
        } catch (e) {
          // Prefetch is best-effort — but an expired session is still worth
          // reporting: it's the same dead cookie every visible slot will hit.
          report(e, noteId, page);
        }
      });
    },

    destroy(): void {
      observer.disconnect();
      for (const slot of slots.values()) releaseSlot(slot);
      slots.clear();
    },
  };
}
