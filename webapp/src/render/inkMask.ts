// Handwriting cut out of a rendered page: only the strokes, as black on
// transparent, trimmed to them. The paper and a template's light lines turn
// transparent, so the picture is a mask the theme colours (`--ink-src`).
// Shared by a lassoed task's strip (`pages/todo/todoInk.ts`) and a digest's
// handwritten note (`pages/digest/digestInk.ts`).

/**
 * How opaque a page pixel is as ink, from its darkness (0 white, 255 black):
 * the paper and a template's light lines are gone, black and dark grey pens
 * stay. Light grey ink is lost with the template; there is no telling them apart.
 */
export function inkAlpha(darkness: number): number {
  const LO = 70;
  const HI = 170;
  return darkness <= LO ? 0 : darkness >= HI ? 255 : Math.round(((darkness - LO) * 255) / (HI - LO));
}

/** A rectangle in pixels. */
export interface PxRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The smallest box around the pixels with any alpha; null when there are none. */
export function inkBounds(alpha: (x: number, y: number) => number, w: number, h: number): PxRect | null {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (alpha(x, y) > 0) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** A cut: the strokes as a WebP mask, and its size in px. */
export interface InkCut {
  blob: Blob;
  width: number;
  height: number;
}

/**
 * The strokes inside `area` of a page rendered light (dark ink on white),
 * trimmed to them with an even rim of air and no wider than `maxW`. Null when
 * the area holds no ink.
 */
export async function cutStrokes(page: ImageBitmap, area: PxRect, maxW: number): Promise<InkCut | null> {
  const { x: sx, y: sy, w: sw, h: sh } = area;
  if (sw <= 0 || sh <= 0) return null;
  const work = new OffscreenCanvas(sw, sh);
  const wc = work.getContext("2d", { willReadFrequently: true })!;
  wc.drawImage(page, sx, sy, sw, sh, 0, 0, sw, sh);
  const img = wc.getImageData(0, 0, sw, sh);
  const px = img.data;
  for (let i = 0; i < px.length; i += 4) {
    const dark = 255 - (0.3 * px[i]! + 0.59 * px[i + 1]! + 0.11 * px[i + 2]!);
    px[i] = px[i + 1] = px[i + 2] = 0;
    px[i + 3] = inkAlpha(dark);
  }
  const ink = inkBounds((x, y) => px[(y * sw + x) * 4 + 3]!, sw, sh);
  if (!ink) return null;
  wc.putImageData(img, 0, 0);

  const rim = Math.max(2, Math.round(ink.h * 0.08));
  const scale = Math.min(1, maxW / (ink.w + 2 * rim));
  const width = Math.max(1, Math.round((ink.w + 2 * rim) * scale));
  const height = Math.max(1, Math.round((ink.h + 2 * rim) * scale));
  const canvas = new OffscreenCanvas(width, height);
  canvas.getContext("2d")!.drawImage(work, ink.x, ink.y, ink.w, ink.h, rim * scale, rim * scale, ink.w * scale, ink.h * scale);
  return { blob: await canvas.convertToBlob({ type: "image/webp", quality: 0.9 }), width, height };
}
