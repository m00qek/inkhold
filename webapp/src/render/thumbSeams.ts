// The thumbnail facade's browser seams: canvas painting, WebP encoding and the fetch network.

import { type Theme } from "../core/types";
import { thumbTargetWidth } from "./types";
import { type ThumbPainter, type ImageTileResult, type ThumbNet } from "./thumbnails";

// ---- browser seam implementations (canvas + fetch) ----

/**
 * How to reach the tier target: `none` keeps the source size (never upscale),
 * `direct` is one bilinear draw (≤2×), `high` an area-averaging reduction
 * (>2×, where bilinear drops thin e-ink strokes).
 */
export interface DownscalePlan {
  w: number;
  h: number;
  method: "none" | "direct" | "high";
}

export function downscalePlan(srcW: number, srcH: number, targetW: number): DownscalePlan {
  if (srcW <= targetW) return { w: srcW, h: srcH, method: "none" };
  const w = Math.max(1, Math.round(targetW));
  const h = Math.max(1, Math.round((srcH * w) / srcW));
  return { w, h, method: srcW / w > 2 ? "high" : "direct" };
}

/** The sub-rect of a `srcW×srcH` image to keep for a centred cover crop. */
export interface CropRect {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

/**
 * The centred cover-crop rect for `aspect`. A missing or degenerate aspect (or
 * one matching the source) yields the full frame.
 */
export function coverCropRect(srcW: number, srcH: number, aspect?: { w: number; h: number }): CropRect {
  const full: CropRect = { sx: 0, sy: 0, sw: srcW, sh: srcH };
  if (!aspect) return full;
  const { w: aw, h: ah } = aspect;
  if (!Number.isFinite(aw) || !Number.isFinite(ah) || aw <= 0 || ah <= 0) return full;
  if (!(srcW > 0) || !(srcH > 0)) return full;
  const targetA = aw / ah;
  const srcA = srcW / srcH;
  if (targetA > srcA) {
    const sh = srcW / targetA;
    return { sx: 0, sy: (srcH - sh) / 2, sw: srcW, sh };
  }
  const sw = srcH * targetA;
  return { sx: (srcW - sw) / 2, sy: 0, sw, sh: srcH };
}

function usableAspect(a?: { w: number; h: number }): a is { w: number; h: number } {
  return !!a && Number.isFinite(a.w) && Number.isFinite(a.h) && a.w > 0 && a.h > 0;
}

function makeCanvas(w: number, h: number): { canvas: OffscreenCanvas | HTMLCanvasElement; ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D } {
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2d context unavailable");
    return { canvas, ctx };
  }
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d context unavailable");
  return { canvas, ctx };
}

const WEBP_TYPE = "image/webp";
const WEBP_QUALITY = 0.9;

function encodeWebp(canvas: OffscreenCanvas | HTMLCanvasElement): Promise<Blob> {
  if (canvas instanceof OffscreenCanvas) return canvas.convertToBlob({ type: WEBP_TYPE, quality: WEBP_QUALITY });
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), WEBP_TYPE, WEBP_QUALITY),
  );
}

interface Palette {
  paper: string;
  ink: string;
  margin: string;
  rule: string;
}

/** Tile paper from live CSS tokens; fallbacks equal the token values. */
function palette(theme: Theme): Palette {
  const fallback: Palette =
    theme === "dark"
      ? { paper: "#17171a", ink: "#e9e6dd", margin: "#cd6a60", rule: "rgba(233,230,221,0.12)" }
      : { paper: "#fcfbf7", ink: "#1c1b17", margin: "#bf5248", rule: "rgba(28,27,23,0.11)" };
  if (typeof document === "undefined") return fallback;
  const s = getComputedStyle(document.documentElement);
  const tok = (name: string, fb: string): string => s.getPropertyValue(name).trim() || fb;
  return {
    paper: tok("--sheet", fallback.paper),
    ink: tok("--ink", fallback.ink),
    margin: tok("--margin", fallback.margin),
    rule: tok("--paper-rule", fallback.rule),
  };
}

/**
 * Load the brand mono face once before canvas draws: `ctx.font` silently falls
 * back to a system mono otherwise. A failure is not a render failure.
 */
let monoFontReady: Promise<void> | null = null;
function ensureMonoFont(): Promise<void> {
  if (monoFontReady) return monoFontReady;
  monoFontReady = (async () => {
    if (typeof document === "undefined" || !document.fonts) return;
    try {
      await Promise.all([
        document.fonts.load('400 16px "Space Mono"'),
        document.fonts.load('700 16px "Space Mono"'),
      ]);
    } catch {
    }
  })();
  return monoFontReady;
}

/** The faint red margin rule shared by every placeholder tile. */
function drawMarginRule(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  w: number,
  h: number,
  color: string,
): number {
  const marginX = w * 0.12;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.3;
  ctx.lineWidth = Math.max(1, w / 150);
  ctx.beginPath();
  ctx.moveTo(marginX, h * 0.06);
  ctx.lineTo(marginX, h * 0.94);
  ctx.stroke();
  ctx.restore();
  return marginX;
}

export type DownscaleSource = ImageBitmap | HTMLCanvasElement | OffscreenCanvas;

/**
 * Area-average (box filter) RGBA downscale, pure so it's testable in Node. A
 * 1-px ruled line is averaged in rather than skipped, unlike bilinear at high
 * reduction. The fallback inside {@link downscaleToBox}.
 */
export function boxDownscaleRgba(
  src: Uint8ClampedArray,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(dstW * dstH * 4);
  const sx = srcW / dstW;
  const sy = srcH / dstH;
  for (let dy = 0; dy < dstH; dy++) {
    const y0 = Math.floor(dy * sy);
    const y1 = Math.min(srcH, Math.max(y0 + 1, Math.floor((dy + 1) * sy)));
    for (let dx = 0; dx < dstW; dx++) {
      const x0 = Math.floor(dx * sx);
      const x1 = Math.min(srcW, Math.max(x0 + 1, Math.floor((dx + 1) * sx)));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * srcW + x) * 4;
          r += src[i]!;
          g += src[i + 1]!;
          b += src[i + 2]!;
          a += src[i + 3]!;
          n++;
        }
      }
      const o = (dy * dstW + dx) * 4;
      out[o] = r / n;
      out[o + 1] = g / n;
      out[o + 2] = b / n;
      out[o + 3] = a / n;
    }
  }
  return out;
}

/** Read a source's native pixels via a scratch canvas (box-filter fallback only). */
function readPixels(source: DownscaleSource, w: number, h: number): Uint8ClampedArray {
  const { ctx } = makeCanvas(w, h);
  ctx.drawImage(source, 0, 0);
  return ctx.getImageData(0, 0, w, h).data;
}

/**
 * The one shared quality downscale, used by the facade and both layer panels:
 * ≤2× one bilinear draw; >2× `createImageBitmap` `resizeQuality: "high"`, then
 * {@link boxDownscaleRgba} as fallback.
 */
export async function downscaleToBox(
  source: DownscaleSource,
  dstW: number,
  dstH: number,
): Promise<OffscreenCanvas | HTMLCanvasElement> {
  const w = Math.max(1, Math.round(dstW));
  const h = Math.max(1, Math.round(dstH));
  const srcW = source.width;
  const srcH = source.height;

  if (srcW / w <= 2 && srcH / h <= 2) {
    const { canvas, ctx } = makeCanvas(w, h);
    ctx.drawImage(source, 0, 0, w, h);
    return canvas;
  }

  try {
    const resized = await createImageBitmap(source, {
      resizeWidth: w,
      resizeHeight: h,
      resizeQuality: "high",
    });
    const { canvas, ctx } = makeCanvas(w, h);
    ctx.drawImage(resized, 0, 0);
    resized.close();
    return canvas;
  } catch {
  }
  const dst = boxDownscaleRgba(readPixels(source, srcW, srcH), srcW, srcH, w, h);
  const { canvas, ctx } = makeCanvas(w, h);
  const image = ctx.createImageData(w, h);
  image.data.set(dst);
  ctx.putImageData(image, 0, 0);
  return canvas;
}

/**
 * Paint `source` downscaled into a box on `ctx` (layer panel previews). The
 * caller paints the background first, since this is async; failures leave it.
 */
export async function drawDownscaledInto(
  ctx: CanvasRenderingContext2D,
  source: DownscaleSource,
  dw: number,
  dh: number,
  dx: number,
  dy: number,
): Promise<void> {
  try {
    const scaled = await downscaleToBox(source, dw, dh);
    ctx.drawImage(scaled, dx, dy);
  } catch {
  }
}

async function tileFromBytes(bytes: Blob): Promise<ImageTileResult> {
  const bitmap = await createImageBitmap(bytes);
  const sourceW = bitmap.width;
  const sourceH = bitmap.height;
  const plan = downscalePlan(sourceW, sourceH, thumbTargetWidth());
  const canvas = await downscaleToBox(bitmap, plan.w, plan.h);
  bitmap.close();
  return { blob: await encodeWebp(canvas), sourceW, sourceH };
}

/**
 * Centre-crop image bytes to `aspect`, then downscale the band to the tier
 * target (never upscaling) and encode WebP.
 */
async function croppedTileFromBytes(bytes: Blob, aspect: { w: number; h: number }): Promise<Blob> {
  const bitmap = await createImageBitmap(bytes);
  const rect = coverCropRect(bitmap.width, bitmap.height, aspect);
  // Extract the band at native resolution; it becomes the downscale source.
  const bandW = Math.max(1, Math.round(rect.sw));
  const bandH = Math.max(1, Math.round(rect.sh));
  const { canvas: band, ctx } = makeCanvas(bandW, bandH);
  ctx.drawImage(bitmap, rect.sx, rect.sy, rect.sw, rect.sh, 0, 0, bandW, bandH);
  bitmap.close();
  const plan = downscalePlan(bandW, bandH, thumbTargetWidth());
  const canvas = await downscaleToBox(band, plan.w, plan.h);
  return encodeWebp(canvas);
}

/** The production painter (canvas + WebP); exercised by e2e. */
export function createCanvasThumbPainter(): ThumbPainter {
  return {
    async fromBitmap(bitmap: ImageBitmap): Promise<Blob> {
      const { canvas, ctx } = makeCanvas(bitmap.width, bitmap.height);
      ctx.drawImage(bitmap, 0, 0);
      return encodeWebp(canvas);
    },

    async fromImageBytes(bytes: Blob, _theme: Theme, cropAspect?: { w: number; h: number }): Promise<Blob> {
      if (usableAspect(cropAspect)) return croppedTileFromBytes(bytes, cropAspect);
      return (await tileFromBytes(bytes)).blob;
    },

    async imageTile(bytes: Blob): Promise<ImageTileResult> {
      return tileFromBytes(bytes);
    },

    async glyph(kind: string, theme: Theme): Promise<Blob> {
      const w = thumbTargetWidth(); // tier target; the facade keys glyphs per bucket
      const h = Math.round(w * (1872 / 1404)); // the note page aspect
      await ensureMonoFont();
      const { canvas, ctx } = makeCanvas(w, h);
      const p = palette(theme);
      ctx.fillStyle = p.paper;
      ctx.fillRect(0, 0, w, h);
      drawMarginRule(ctx, w, h, p.margin);

      // A dog-eared document sheet, centred.
      const sheetW = w * 0.42;
      const sheetH = sheetW * 1.3;
      const x = (w - sheetW) / 2;
      const y = (h - sheetH) / 2 - h * 0.02;
      const fold = sheetW * 0.28;
      ctx.strokeStyle = p.ink;
      ctx.lineWidth = Math.max(1.5, w / 120);
      ctx.lineJoin = "round";
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + sheetW - fold, y);
      ctx.lineTo(x + sheetW, y + fold);
      ctx.lineTo(x + sheetW, y + sheetH);
      ctx.lineTo(x, y + sheetH);
      ctx.closePath();
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x + sheetW - fold, y);
      ctx.lineTo(x + sheetW - fold, y + fold);
      ctx.lineTo(x + sheetW, y + fold);
      ctx.stroke();

      // The kind letter under the sheet; folders get none.
      if (kind !== "folder") {
        ctx.fillStyle = p.ink;
        // Space Mono ships 400/700, no 600.
        ctx.font = `700 ${Math.round(w * 0.1)}px "Space Mono", ui-monospace, monospace`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(kind, w / 2, y + sheetH + h * 0.09);
      }
      return encodeWebp(canvas);
    },

    async textSnippet(content: string, theme: Theme): Promise<Blob> {
      const w = thumbTargetWidth(); // tier target; keyed per bucket by the facade
      const h = Math.round(w * (1872 / 1404));
      await ensureMonoFont();
      const { canvas, ctx } = makeCanvas(w, h);
      const p = palette(theme);
      ctx.fillStyle = p.paper;
      ctx.fillRect(0, 0, w, h);
      const marginX = drawMarginRule(ctx, w, h, p.margin);

      const lines = content
        .split(/\r?\n/)
        .map((l) => l.replace(/\t/g, "  ").trimEnd())
        .filter((l, i, a) => l.length > 0 || (i > 0 && a[i - 1]!.length > 0))
        .slice(0, 9);
      const padX = marginX + w * 0.05;
      const padRight = w * 0.08;
      const fontPx = Math.round(w * 0.062);
      const lineH = fontPx * 1.5;
      let y = h * 0.12;
      ctx.fillStyle = p.ink;
      ctx.font = `${fontPx}px "Space Mono", ui-monospace, "SF Mono", Menlo, monospace`;
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      const maxChars = Math.floor((w - padX - padRight) / (fontPx * 0.62));
      for (const line of lines) {
        const clipped = line.length > maxChars ? line.slice(0, maxChars - 1) + "…" : line;
        ctx.fillText(clipped, padX, y);
        y += lineH;
        if (y > h - lineH) break;
      }
      return encodeWebp(canvas);
    },
  };
}

/** `fetch` seam; any non-OK or transport error becomes `null`. */

export function createFetchThumbNet(): ThumbNet {
  return {
    async bytes(url: string): Promise<Blob | null> {
      try {
        const res = await fetch(url, { credentials: "same-origin" });
        if (!res.ok) return null;
        return await res.blob();
      } catch {
        return null;
      }
    },
    async probe(url: string): Promise<Blob | "not-found" | null> {
      try {
        const res = await fetch(url, { credentials: "same-origin" });
        if (res.status === 404) return "not-found";
        if (!res.ok) return null;
        return await res.blob();
      } catch {
        return null;
      }
    },
    async text(url: string): Promise<string | null> {
      try {
        const res = await fetch(url, { credentials: "same-origin" });
        if (!res.ok) return null;
        return await res.text();
      } catch {
        return null;
      }
    },
  };
}
