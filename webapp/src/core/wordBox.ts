// The one place millimetres become pixels.
//
// `WordBox` carries the DEVICE's own numbers out of the `.note` RECOGNTEXT block
// — millimetres, origin top-left — and `NoteMeta.pxPerMm` is the only scale that
// turns them into anything on a page. Two features need that conversion and they
// must not derive it twice:
//
//   - the PDF exporter's invisible text layer (`export/pdf.ts`), which places
//     words at page-pixel coordinates;
//   - find-in-note's ovals (`pages/findInNote.ts`), which draws round the same
//     words at the DISPLAYED page's size.
//
// The second is the first with a different scale: a page shown at 480 CSS px
// wide out of a 1404 px native page is simply `pxPerMm * 480/1404`. Sharing the
// per-word arithmetic and the bounds rule is what keeps a word circled in the
// reader and the same word selectable in the export from ever disagreeing about
// where it is.

import type { WordBox } from "./types";

/** One word resolved to pixels, top-left origin. */
export interface BoxPx {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Slack, in pixels, allowed when checking a scaled box against the page.
 * Small on purpose: this is float noise, not a fudge factor for a wrong scale.
 */
export const BOUNDS_SLACK_PX = 1;

/** A usable scale — a positive, finite number of pixels per millimetre. */
export function isUsableScale(pxPerMm: number | null): pxPerMm is number {
  return pxPerMm !== null && Number.isFinite(pxPerMm) && pxPerMm > 0;
}

/**
 * Scale one word's millimetres to pixels, or null when the numbers are not
 * arithmetic (the values are device-authored and reach a PDF content stream and
 * a CSS length, so a `NaN` has to be stopped here rather than propagated).
 */
export function wordBoxPx(word: WordBox, pxPerMm: number): BoxPx | null {
  const box = {
    x: word.xMm * pxPerMm,
    y: word.yMm * pxPerMm,
    w: word.wMm * pxPerMm,
    h: word.hMm * pxPerMm,
  };
  return [box.x, box.y, box.w, box.h].every(Number.isFinite) ? box : null;
}

/**
 * Does a scaled box land on the page?
 *
 * FALSE MEANS THE SCALE IS WRONG, which is why both callers treat it as
 * all-or-nothing rather than dropping the offending word: if the millimetre
 * scale disagrees with this page then every box is wrong, and keeping the ones
 * that happen to still fit leaves a partial answer that looks deliberate.
 */
export function withinPage(box: BoxPx, widthPx: number, heightPx: number): boolean {
  return (
    box.x >= -BOUNDS_SLACK_PX &&
    box.y >= -BOUNDS_SLACK_PX &&
    box.x + box.w <= widthPx + BOUNDS_SLACK_PX &&
    box.y + box.h <= heightPx + BOUNDS_SLACK_PX
  );
}
