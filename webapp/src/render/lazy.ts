// The lazy-render engine: never paint an off-screen tile. Slots get a
// placeholder and paint once when they scroll near the viewport. A <canvas>
// target (filmstrip, bin) is blitted with an `ImageBitmap`; an <img> target
// (gallery) gets an object URL over the facade's WebP blob, leaving decode and
// eviction to the browser. The engine owns when to paint; the injected
// `getThumbnail` facade (or the direct note-page pipeline) owns what. A theme
// bump repaints only visible slots; the rest re-lazy.

import type { Hash, Id, PageRef, RenderSize, Theme } from "../core/types";
import type { Api } from "../api/types";
import { dispatchApiFailure, type ApiFailureSink } from "../api/client";
import type { NoteRenderer } from "./types";
import type { RenderCache } from "../cache/types";
import type { ThumbSource } from "./thumbnails";

export interface LazySlotInput {
  /**
   * Where this tile paints; the target's kind (not the facade's presence)
   * decides the display path.
   */
  target: HTMLCanvasElement | HTMLImageElement;
  noteId: Id;
  /**
   * Optional only for facade-driven slots that never touch pages; a pageless
   * slot without a facade throws.
   */
  page?: PageRef;
  size: RenderSize;
  /** Accessible name for an <img> target; ignored for a canvas. */
  alt?: string;
  /**
   * What this tile is, for the facade. Absent: a note page with no hash (no
   * cover probe). `bin` selects the bin-scoped raw-file routes.
   */
  thumb?: { fileType: string; fileHash: Hash | null; bin?: boolean; aspect?: { w: number; h: number } };
}

export interface ObserverLike {
  observe(target: Element): void;
  unobserve(target: Element): void;
  disconnect(): void;
}

export type ObserverFactory = (
  onVisibility: (target: Element, isIntersecting: boolean) => void,
) => ObserverLike;

/**
 * How long a tile may stay blank before its glyph is painted, short enough not
 * to look broken, long enough that fast strategies win and never flash a glyph.
 */
export const PLACEHOLDER_AFTER_MS = 200;

export interface LazyEngineDeps {
  api: Api;
  renderer: NoteRenderer;
  cache: RenderCache;
  /** Read fresh on every paint so mid-scroll theme toggles are honored. */
  getTheme: () => Theme;
  /**
   * The thumbnail facade (what a slot shows, as a WebP blob). Absent, the engine
   * uses the direct `renderPage` path. Required for <img> targets.
   */
  getThumbnail?: (source: ThumbSource, fileType: string) => Promise<Blob>;
  /** The type's glyph for the interim paint (`PLACEHOLDER_AFTER_MS`); absent, slow tiles stay blank. */
  getGlyph?: (fileType: string) => Promise<Blob>;
  /** Decode a facade blob for a canvas target. Defaults to `createImageBitmap`. */
  decode?: (blob: Blob) => Promise<ImageBitmap>;
  /** Scroll root for the default IntersectionObserver (null = viewport). */
  root?: Element | null;
  /** Preload margin. Default "120px 0px". */
  rootMargin?: string;
  observerFactory?: ObserverFactory;
  blit?: (canvas: HTMLCanvasElement, bitmap: ImageBitmap) => void;
  /** Override the off-screen placeholder paint (tests). Canvas targets only. */
  placeholder?: (canvas: HTMLCanvasElement, page: PageRef) => void;
  createObjectUrl?: (blob: Blob) => string;
  revokeObjectUrl?: (url: string) => void;
  /** Defer the initial placeholder+observe past layout. Default rAF. */
  schedule?: (fn: () => void) => void;
  /**
   * Where actionable page-fetch failures (UNAUTHORIZED, STALE_PAGE) go; a
   * swallowed 401 would leave blank thumbnails forever. The engine still just
   * retries on the next intersection.
   */
  failures?: ApiFailureSink;
  /** Debounce before painting while scrolling. Default 150. */
  debounceMs?: number;
}

export interface LazyEngine {
  add(input: LazySlotInput): void;
  remove(target: HTMLCanvasElement | HTMLImageElement): void;
  /** Forget every slot and disconnect the observer, keeping the engine reusable. */
  reset(): void;
  /** Repaint visible slots for a new theme; drop the rest to re-lazy. */
  bumpTheme(): void;
  repaintVisible(): void;
  /** Warm the cache for a page without a canvas (reader neighbour prefetch). */
  prefetch(noteId: Id, page: PageRef, size: RenderSize): void;
  destroy(): void;
}

/**
 * An object URL and its idempotent `release()`: `createObjectURL` pins the blob
 * until revoked, so hold it while displayed and release on replace or teardown.
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
  /** The <img> slot's live object URL, revoked on replacement/teardown. */
  urlHandle: ObjectUrlHandle | null;
}

const DPR_CAP = 2;

/** Reads `tagName`, not `instanceof`, so DOM-less tests route correctly. */
function isImgTarget(target: { tagName?: string }): boolean {
  return target.tagName === "IMG";
}

/** Default canvas blit: size to the CSS box × DPR and draw scaled. */
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

/**
 * A blank ruled sheet in live CSS colours. Exported for the reader, whose
 * full-size page shows it when there is no filmstrip bitmap to blur up from.
 */
export function defaultPlaceholder(canvas: HTMLCanvasElement, _page: PageRef): void {
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

/**
 * The cache → getPageBytes → render → put pipeline for one page, shared by the
 * engine and the reader so the cache-key contract lives in one place.
 */
export async function renderPage(
  deps: { api: Api; renderer: NoteRenderer; cache: RenderCache; theme: Theme },
  noteId: Id,
  page: PageRef,
  size: RenderSize,
): Promise<ImageBitmap> {
  // Notes render theme-independently, so they cache under a fixed light key.
  const theme: Theme = "light";
  const key = { hash: page.hash, size, theme };
  const hit = await deps.cache.get(key);
  if (hit) return hit;
  const bytes = await deps.api.getPageBytes(noteId, page);
  const decoded = await deps.renderer.render({ bytes, noteId, page, size, theme });
  await deps.cache.put(key, decoded.bitmap);
  return decoded.bitmap;
}

export function createLazyEngine(deps: LazyEngineDeps): LazyEngine {
  const { api, renderer, cache, getTheme } = deps;
  const getThumbnail = deps.getThumbnail;
  const getGlyph = deps.getGlyph;
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

  // Settle gate: `debounceMs` applies only while the scroll container moved in
  // the last `settleMs`, so a settled view paints at once. 0 disables (tests).
  const settleMs = deps.debounceMs ?? 150;
  const nowMs = (): number => (typeof performance !== "undefined" ? performance.now() : 0);
  let lastScrollAt = -Infinity;
  const onScroll = (): void => {
    lastScrollAt = nowMs();
  };
  const scrollRoot: EventTarget | null =
    settleMs > 0 ? (deps.root ?? (typeof window !== "undefined" ? window : null)) : null;
  scrollRoot?.addEventListener("scroll", onScroll, { passive: true });

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

  /** Hand an actionable failure to the owner; `page` is absent for pageless slots. */
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
   * The bitmap for a canvas slot. The facade path decodes a transient we must
   * close; the direct path's bitmap belongs to the render cache and must not be.
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
   * Point an <img> at a fresh object URL and revoke the previous one, or every
   * repaint leaks a pinned blob. The new URL stays live for the async load.
   */
  function paintImg(slot: Slot, blob: Blob, isGlyph = false): void {
    const next = objectUrl(blob);
    const img = slot.target as HTMLImageElement;
    // A picture that won't load (a stored one Safari can't read back) shows
    // the type's glyph, never a broken image with its alt text over the card;
    // `painted` false so the next sight of the card tries the real one again.
    img.onerror = isGlyph
      ? null
      : () => {
          slot.painted = false;
          showGlyph(slot);
        };
    img.src = next.url;
    // The race's stand-in, until the real picture lands (tests tell them apart).
    img.toggleAttribute("data-interim", isGlyph);
    if (slot.alt !== undefined) img.alt = slot.alt;
    slot.urlHandle?.release(); // the previous paint's URL is now safe to drop
    slot.urlHandle = next;
  }

  function showGlyph(slot: Slot): void {
    if (!getGlyph || !isImgTarget(slot.target)) return;
    const version = themeVersion;
    void getGlyph(slot.thumb?.fileType ?? "note")
      .then((g) => {
        if (version === themeVersion && slots.has(slot.target)) paintImg(slot, g, true);
      })
      .catch(() => {});
  }

  function releaseSlot(slot: Slot): void {
    slot.urlHandle?.release();
    slot.urlHandle = null;
  }

  /** Canvas placeholder; a no-op for <img> targets, whose unset `src` shows the sheet. */
  function paintPlaceholder(slot: Slot): void {
    if (isImgTarget(slot.target) || !slot.page) return;
    placeholder(slot.target as HTMLCanvasElement, slot.page);
  }

  async function paint(slot: Slot): Promise<void> {
    if (slot.inFlight) return;
    slot.inFlight = true;

    // Settle only while actively scrolling; a slot flung past is skipped.
    if (settleMs > 0 && nowMs() - lastScrollAt < settleMs) {
      await new Promise((resolve) => setTimeout(resolve, settleMs));
      if (!slot.visible || !slots.has(slot.target)) {
        slot.inFlight = false;
        return;
      }
    }

    const renderVersion = themeVersion;
    const theme = getTheme();
    try {
      if (isImgTarget(slot.target)) {
        if (!getThumbnail) throw new Error("an <img> slot requires a thumbnail facade");
        const fileType = slot.thumb?.fileType ?? "note";
        const real = getThumbnail(thumbSource(slot), fileType);
        // Race a glyph floor against slow producers: a `.pdf` tile must fetch and
        // compile MuPDF first (8.5 s on 3G) and was the LCP element while blank.
        // Fast strategies win the race and never flash the glyph.
        const slow = Symbol("slow");
        const first = await Promise.race([
          real.catch(() => slow),
          new Promise<typeof slow>((r) => setTimeout(() => r(slow), PLACEHOLDER_AFTER_MS)),
        ]);
        if (first === slow && getGlyph && renderVersion === themeVersion && slots.has(slot.target)) {
          // Interim only: `painted` stays false, and a failure here is ignored.
          await getGlyph(fileType)
            .then((g) => {
              if (renderVersion === themeVersion && slots.has(slot.target)) paintImg(slot, g, true);
            })
            .catch(() => {});
        }
        const blob = await real;
        // The slot may have been torn down during the fetch; a URL minted now
        // would never be revoked.
        if (renderVersion === themeVersion && slots.has(slot.target)) {
          paintImg(slot, blob);
          slot.painted = true;
          slot.themeV = renderVersion;
        } else {
          slot.painted = false;
        }
      } else {
        const { bitmap, owned } = await produceBitmap(slot, theme);
        // Discard a bitmap for a stale theme or a removed slot.
        if (renderVersion === themeVersion && slots.has(slot.target)) {
          blit(slot.target as HTMLCanvasElement, bitmap);
          slot.painted = true;
          slot.themeV = renderVersion;
        } else {
          slot.painted = false;
        }
        // Close a facade transient; render-cache bitmaps are closed on eviction.
        if (owned) bitmap.close();
      }
    } catch (e) {
      // Non-fatal: retry next intersection, but report session and staleness
      // failures, which a retry won't fix. An <img> with no picture yet shows
      // the glyph meanwhile (bare, Safari draws its alt text and a "?").
      slot.painted = false;
      if (isImgTarget(slot.target) && slot.urlHandle === null) showGlyph(slot);
      report(e, slot.noteId, slot.page);
    } finally {
      slot.inFlight = false;
    }
    // Keyed on `renderVersion`, not `slot.themeV`: a failed paint leaves `themeV`
    // stale, and keying on it would retry a failing fetch forever.
    if (slot.visible && renderVersion !== themeVersion) void paint(slot);
  }

  return {
    add(input: LazySlotInput): void {
      const slot: Slot = { ...input, visible: false, painted: false, themeV: -1, inFlight: false, urlHandle: null };
      slots.set(input.target, slot);
      schedule(() => {
        if (!slots.has(input.target)) return;
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
          // Off-screen <img>s keep their off-theme src until scrolled in;
          // revoking now would show a broken image.
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
          // Best-effort, but an expired session is still worth reporting.

          report(e, noteId, page);
        }
      });
    },

    destroy(): void {
      observer.disconnect();
      scrollRoot?.removeEventListener("scroll", onScroll);
      for (const slot of slots.values()) releaseSlot(slot);
      slots.clear();
    },
  };
}
