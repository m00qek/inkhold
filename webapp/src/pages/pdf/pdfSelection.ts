// PDF text selection: which words a drag covers and what they copy as. Reading
// order is the shim's emission order (blocks, lines, chars), so a range is just
// the words between two indices and two columns select as they read. Words are
// the unit; the shim carries no per-glyph geometry.

import type { PdfWord } from "../../render/pdfWire";

/** The two words a selection was dragged between, in either order. */
export interface WordRange {
  anchor: number;
  head: number;
}

/** The covered words in reading order, whichever way the drag went. */
export function wordsInRange(words: readonly PdfWord[], range: WordRange): PdfWord[] {
  const lo = Math.max(0, Math.min(range.anchor, range.head));
  const hi = Math.min(words.length - 1, Math.max(range.anchor, range.head));
  if (hi < lo) return [];
  return words.slice(lo, hi + 1);
}

/**
 * Words joined by spaces within a line, lines by newlines. The line id is the
 * shim's, so angled text and shared baselines across columns behave. Hyphenated
 * words are not rejoined; a wrong guess would edit the copied text.
 */
export function selectionText(words: readonly PdfWord[]): string {
  if (words.length === 0) return "";
  const lines: string[] = [];
  let line: string[] = [];
  let at = words[0]!.line;
  for (const w of words) {
    if (w.line !== at) {
      lines.push(line.join(" "));
      line = [];
      at = w.line;
    }
    line.push(w.t);
  }
  lines.push(line.join(" "));
  return lines.join("\n");
}

/**
 * The word under a page-space point, or `null`. Hit-tested in JS rather than one
 * DOM rect per word; last match wins (the later word draws on top).
 */
export function wordAtPoint(
  words: readonly PdfWord[],
  x: number,
  y: number,
): number | null {
  let found: number | null = null;
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    if (x >= w.x && x <= w.x + w.w && y >= w.y && y <= w.y + w.h) found = i;
  }
  return found;
}

/**
 * The word a drag has reached once the pointer is off the text, so a drag does
 * not stall in a margin. Picks the nearest line first, then the position in it:
 * plain nearest-box distance shrinks selections among short lines. Only for
 * extending; a press in a margin starts nothing.
 */
export function nearestWord(words: readonly PdfWord[], x: number, y: number): number | null {
  if (words.length === 0) return null;
  let line: number | null = null;
  let bestDy = Infinity;
  for (const w of words) {
    const dy = y < w.y ? w.y - y : y > w.y + w.h ? y - (w.y + w.h) : 0;
    if (dy < bestDy) {
      bestDy = dy;
      line = w.line;
    }
  }
  // A pointer past the line's end lands on its last word: `<=` lets ties fall later.
  let best: number | null = null;
  let bestDx = Infinity;
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    if (w.line !== line) continue;
    const dx = x < w.x ? w.x - x : x > w.x + w.w ? x - (w.x + w.w) : 0;
    if (dx <= bestDx) {
      bestDx = dx;
      best = i;
    }
  }
  return best;
}
