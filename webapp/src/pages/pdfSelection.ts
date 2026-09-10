// Selecting a passage of a PDF's text: which words a drag covers, and what those
// words say when you copy them.
//
// READING ORDER IS EMISSION ORDER. The shim walks the document's structured text
// — blocks, then lines, then chars — and emits words in that order, so the
// selection between two words is simply every word BETWEEN THEM IN THE ARRAY.
// That order is the DOCUMENT's, not a geometric one: on a two-column page,
// dragging from the top of the left column to the bottom of the right selects
// both columns as they are meant to be read, never a horizontal band across
// both. It comes free from not being clever about coordinates.
//
// WORDS ARE THE UNIT, deliberately: splitting a word needs per-glyph geometry
// the shim does not carry, and a passage is what people select anyway.

import type { PdfWord } from "../render/pdfWire";

/** A selection as the two words it was dragged between, in no particular order. */
export interface WordRange {
  /** Index into the page's word array where the drag started. */
  anchor: number;
  /** Index where it currently ends. May be before {@link anchor}. */
  head: number;
}

/**
 * The words a range covers, in reading order.
 *
 * Order-insensitive about its input and ordered in its output: dragging up the
 * page selects the same passage as dragging down it, and copies it the way it
 * reads rather than the way the pointer moved.
 */
export function wordsInRange(words: readonly PdfWord[], range: WordRange): PdfWord[] {
  const lo = Math.max(0, Math.min(range.anchor, range.head));
  const hi = Math.min(words.length - 1, Math.max(range.anchor, range.head));
  if (hi < lo) return [];
  return words.slice(lo, hi + 1);
}

/**
 * What a selection says: words joined by spaces within a line, lines by
 * newlines.
 *
 * The LINE ID comes from the shim's own stext walk, so "same line" means what
 * the document says it means rather than what the y coordinates look like from
 * here — which matters for text set at an angle, and for two columns whose
 * lines share a baseline without sharing a line.
 *
 * A HYPHENATED WORD STAYS TWO WORDS. Rejoining would mean guessing which
 * hyphens are breaks and which belong to the word, and a wrong guess edits the
 * person's document on the way to their clipboard.
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
 * The word under a point in PAGE coordinates, or `null`.
 *
 * HIT-TESTED IN JS RATHER THAN BY THE DOM: a dense page carries hundreds of
 * words, and giving each a hit rect would put hundreds of elements over every
 * page of a book for a feature most page views never use. The words are already
 * in memory and a linear scan per pointer event is nothing.
 *
 * LAST MATCH WINS — hence no early exit — so overlapping boxes resolve to the
 * later one in reading order, which is the one drawn on top.
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
 * The word a drag has reached, for a pointer that has wandered off the text.
 *
 * A DRAG MUST NOT STALL IN A MARGIN. Selecting to the end of a paragraph means
 * pulling past the last word, and a strict hit test answers nothing there — so
 * the selection would stop growing exactly where the user is trying to take it.
 *
 * THE LINE FIRST, THEN THE POSITION IN IT. A plain nearest-box rule measuring
 * straight-line distance is wrong in a way only a real page shows: among SHORT
 * lines, a pointer dragged down and to the right sits closer to the end of an
 * EARLIER long line than to the line it is actually beside, so pulling into the
 * right margin quietly shrinks the selection back up the page. Reading order is
 * vertical first, so the search has to be too.
 *
 * Only for EXTENDING a selection. Starting one uses {@link wordAtPoint}, because
 * a press in a margin is not an attempt to select the nearest paragraph — it is
 * a press in a margin, and it should clear.
 */
export function nearestWord(words: readonly PdfWord[], x: number, y: number): number | null {
  if (words.length === 0) return null;
  // 1. WHICH LINE: the band the pointer is in, or the nearest band above/below.
  let line: number | null = null;
  let bestDy = Infinity;
  for (const w of words) {
    const dy = y < w.y ? w.y - y : y > w.y + w.h ? y - (w.y + w.h) : 0;
    if (dy < bestDy) {
      bestDy = dy;
      line = w.line;
    }
  }
  // 2. WHERE IN IT. A pointer past the end of the line must land on its last
  //    word, or "drag into the margin to take the rest of the line" does not
  //    work; the `<=` is what does it, by letting a tie fall to the later word.
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
