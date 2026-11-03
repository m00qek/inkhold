// The one place millimetres become pixels. Shared by the PDF exporter's
// invisible text layer and find-in-note's ovals so the two never disagree about
// where a word is.

import type { WordBox } from "./types";

/** One word resolved to pixels, top-left origin. */
export interface BoxPx {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Slack for float noise when checking a scaled box against the page. */
export const BOUNDS_SLACK_PX = 1;

/** A usable scale — a positive, finite number of pixels per millimetre. */
export function isUsableScale(pxPerMm: number | null): pxPerMm is number {
  return pxPerMm !== null && Number.isFinite(pxPerMm) && pxPerMm > 0;
}

/**
 * Scale one word's millimetres to pixels, or null when not finite: the values
 * are device-authored and reach a PDF content stream and a CSS length.
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
 * Does a scaled box land on the page? False means the scale is wrong, so
 * callers treat it as all-or-nothing rather than dropping the word.
 */
export function withinPage(box: BoxPx, widthPx: number, heightPx: number): boolean {
  return (
    box.x >= -BOUNDS_SLACK_PX &&
    box.y >= -BOUNDS_SLACK_PX &&
    box.x + box.w <= widthPx + BOUNDS_SLACK_PX &&
    box.y + box.h <= heightPx + BOUNDS_SLACK_PX
  );
}
