// The drawn loop find puts round a matched word — geometry only, no DOM, so it
// is unit-testable on plain Node.
//
// AN OVAL, NOT A RECTANGLE AND NOT A WASH. The rectangles are the DEVICE's own
// recognition and can sit slightly off the ink, so a hard box asserts a
// precision the data does not have; an oval reads as *circled*, which is
// inherently approximate — and matches a pen going round a word in a notebook. A
// filled highlight would obscure the very ink it points at, so it stays an
// outline throughout, and nothing but stroke weight and opacity marks the
// current match.
//
// It is a DRAWN loop rather than a CSS ellipse: one pen stroke that goes round
// the word, past where it started, and out along the top. That overshoot is the
// whole tell — a geometric ellipse reads as stamped on, a crossing stroke reads
// as someone circling a word.

import type { WordBox } from "../core/types";
import { isUsableScale, withinPage, wordBoxPx } from "../core/wordBox";

/**
 * Three loops, so a page of matches is not one mark repeated, and a degree or
 * two of alternating tilt on top. Both are keyed to the MATCH INDEX rather than
 * randomised, so a repaint — paging away and back, a theme change, a resize —
 * never reshuffles them.
 *
 * Drawn in a 0..100 x 0..40 box and stretched to each word; see
 * {@link OVAL_VIEWBOX} and the two SVG attributes that make that survivable.
 */
export const FIND_LOOPS = [
  "M34 7C18 10 5 18 4 26C3 34 21 38.5 46 39C71 39.4 93 33 96 24C98.5 16 82 8.5 58 7C44 6 30 6.4 20 8.6C31 5.6 49 4 67 4.6",
  "M30 5.5C14 9 3 18 4.5 26.5C6 35 26 39 50 38.6C74 38 95 31 96 22C97 13 78 6.5 55 5.6C41 5 27 6.6 18 9.4C29 6.4 46 4.8 62 5.4",
  "M38 8C20 9.6 6 17 4.6 25C3.4 33.4 22 38.6 47 39.2C72 39.6 94 32.6 96 23C97.6 14.6 79 7.6 56 6.4C42 5.8 28 6.6 19 9C30 6 47 4.4 64 5",
] as const;

/** The box the loops are drawn in. Stretched to each word — see `preserveAspectRatio`. */
export const OVAL_VIEWBOX = "0 0 100 40";

/**
 * How much the word's rectangle GROWS before the loop is drawn into it.
 *
 * A curve inscribed in the word's own rectangle clips its corners, so it covers
 * less of the word than the rectangle did and leaves the ends of the word
 * outside the loop. More vertically than horizontally, because the boxes are
 * wide and shallow.
 */
const GROW_X = 0.2;
const GROW_Y = 0.32;

/** One oval, in the coordinate space of the displayed page element. */
export interface Oval {
  /** CSS pixels from the page's top-left. */
  left: number;
  top: number;
  width: number;
  height: number;
  /** A degree or two, alternating — the last thing that gives away a stamp. */
  rotateDeg: number;
  /** One of {@link FIND_LOOPS}. */
  path: string;
}

/**
 * The ovals for a page's matched words, at the size the page is CURRENTLY shown.
 *
 * `pxPerMm` is the device's VERIFIED scale for native page pixels, and
 * `displayWidth`/`displayHeight` are the page element's measured CSS size, so
 * the scale actually used is `pxPerMm * displayWidth / nativeWidth`. That is the
 * same conversion the PDF exporter's text layer makes (`core/wordBox.ts`), at a
 * different magnification — which is why they share the arithmetic rather than
 * deriving it twice.
 *
 * RETURNS NULL RATHER THAN A PARTIAL SET when the scale is unusable or a box
 * lands off the page. `pxPerMm === null` is the common case and means "this
 * hardware's millimetre scale has never been verified" — drawing anyway would
 * put loops confidently round the wrong words, which is worse than drawing none.
 * The bounds rule is all-or-nothing for the same reason the exporter's is: if
 * the scale disagrees with this page then every box is wrong, and keeping the
 * ones that happen to fit leaves a partial answer that looks deliberate.
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
