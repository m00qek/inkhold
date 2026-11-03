// The hand-drawn loop find puts round a matched word (geometry only, no DOM).
// An outline, never a fill, so it does not obscure the ink; an oval because the
// device's word boxes are approximate.

import type { WordBox } from "../core/types";
import { isUsableScale, withinPage, wordBoxPx } from "../core/wordBox";

/**
 * Three loops plus alternating tilt, keyed to the match index (not random) so
 * a repaint never reshuffles them. Drawn in {@link OVAL_VIEWBOX} and stretched.
 */
export const FIND_LOOPS = [
  "M34 7C18 10 5 18 4 26C3 34 21 38.5 46 39C71 39.4 93 33 96 24C98.5 16 82 8.5 58 7C44 6 30 6.4 20 8.6C31 5.6 49 4 67 4.6",
  "M30 5.5C14 9 3 18 4.5 26.5C6 35 26 39 50 38.6C74 38 95 31 96 22C97 13 78 6.5 55 5.6C41 5 27 6.6 18 9.4C29 6.4 46 4.8 62 5.4",
  "M38 8C20 9.6 6 17 4.6 25C3.4 33.4 22 38.6 47 39.2C72 39.6 94 32.6 96 23C97.6 14.6 79 7.6 56 6.4C42 5.8 28 6.6 19 9C30 6 47 4.4 64 5",
] as const;

export const OVAL_VIEWBOX = "0 0 100 40";

/** Grow the word box first: a curve inscribed in it would clip the word's ends. */
const GROW_X = 0.2;
const GROW_Y = 0.32;

export interface Oval {
  /** CSS pixels from the page's top-left. */
  left: number;
  top: number;
  width: number;
  height: number;
  rotateDeg: number;
  path: string;
}

/**
 * Ovals at the page's current display size; scale is
 * `pxPerMm * displayWidth / nativeWidth`. Returns null, never a partial set,
 * when `pxPerMm` is unverified or any box falls off the page: a wrong scale
 * makes every box wrong.
 */
export function ovalsFor(
  words: readonly WordBox[],
  pxPerMm: number | null,
  nativeWidth: number,
  displayWidth: number,
  displayHeight: number,
): Oval[] | null {
  if (!isUsableScale(pxPerMm)) return null;
  if (!(nativeWidth > 0) || !(displayWidth > 0) || !(displayHeight > 0)) return null;

  const scale = pxPerMm * (displayWidth / nativeWidth);
  if (!Number.isFinite(scale) || scale <= 0) return null;

  const out: Oval[] = [];
  for (const [i, word] of words.entries()) {
    const box = wordBoxPx(word, scale);
    if (box === null) return null;
    if (!withinPage(box, displayWidth, displayHeight)) return null;
    if (box.w <= 0 || box.h <= 0) continue; // nothing to circle, and not evidence of anything
    out.push({
      left: box.x - box.w * (GROW_X / 2),
      top: box.y - box.h * (GROW_Y / 2),
      width: box.w * (1 + GROW_X),
      height: box.h * (1 + GROW_Y),
      rotateDeg: Number(((i % 2 ? 1 : -1) * (0.8 + (i % 3) * 0.5)).toFixed(2)),
      path: FIND_LOOPS[i % FIND_LOOPS.length]!,
    });
  }
  return out;
}
