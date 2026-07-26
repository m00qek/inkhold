// The `.txt` viewer's find, factored out of txtViewer.ts the way findInNote.ts is
// out of reader.ts: the pure text/DOM operations that make find TESTABLE, with
// the viewer keeping only the wiring (the toolbar toggle, the bar, the fetch).
//
// WHY THIS IS DIFFERENT FROM find-in-note, and deliberately so. The reader draws
// a rectangle per recognised WORD, from the device's own coordinates — find is a
// geometry problem there. A `.txt` has no geometry: the whole file is loaded in
// the viewer as text, so a match is a substring and highlighting is a DOM
// operation. The two share their SHAPE — a note-scoped/blob-scoped query, terms
// as the one-way authority for what to mark, prev/next stepping, an exact count
// — and nothing of their mechanism.
//
// THE ONE HAZARD THIS FILE EXISTS TO GET RIGHT: the byte range vs the string
// index. The backend addresses a paragraph by its BYTE offset in the raw blob
// (`recogn_offset`/`recogn_length`); the viewer holds the file as a decoded
// UTF-16 string. `byteToCharMap` is the one conversion between them, so a
// multi-byte character before a match cannot slide the highlight off the word.

import { el } from "../ui/dom";
import type { TxtMatch } from "../core/types";

/**
 * Case- and accent-insensitive form — the SAME fold `unicode61
 * remove_diacritics 2` applies to the index and `findInNote.ts` applies to a
 * word before comparing it with a term. The household writes Portuguese, so
 * `avaliação` typed as `avaliacao` has to mark the word it means; the backend
 * folded the same way to COUNT it, which is what keeps the marks and the count
 * describing the same matches.
 */
export function fold(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

/** UTF-8 byte length of one code point — the inverse of what a `TextEncoder`
 *  would cost per character, computed directly so a big file maps in one pass. */
function utf8Len(cp: number): number {
  if (cp <= 0x7f) return 1;
  if (cp <= 0x7ff) return 2;
  if (cp <= 0xffff) return 3;
  return 4;
}

/**
 * Map each raw-blob BYTE offset to a JS-string (UTF-16 code-unit) index in the
 * decoded text.
 *
 * The backend's paragraph addresses are byte offsets into the UTF-8 blob; the
 * viewer scrolls to and slices a UTF-16 string. One sequential pass over the
 * code points converts every requested offset at once — O(text + offsets),
 * never one scan per offset — so even a multi-MB file is mapped once per query.
 *
 * An offset that lands MID-sequence (a hostile or lossily-decoded file, where
 * the byte count can drift from the decoded string) resolves to the first char
 * at or past it: the highlight is derived from the terms regardless, so at worst
 * the scroll anchor is a character out on input the index already sanitised.
 */
export function byteToCharMap(text: string, byteOffsets: readonly number[]): Map<number, number> {
  const wanted = [...new Set(byteOffsets)].sort((a, b) => a - b);
  const out = new Map<number, number>();
  let bytes = 0;
  let ci = 0;
  let oi = 0;
  let i = 0;
  while (i < text.length && oi < wanted.length) {
    while (oi < wanted.length && wanted[oi]! <= bytes) out.set(wanted[oi++]!, ci);
    const cp = text.codePointAt(i)!;
    bytes += utf8Len(cp);
    const units = cp > 0xffff ? 2 : 1;
    i += units;
    ci += units;
  }
  // Any offset at or past the end of the file resolves to the end of the string.
  while (oi < wanted.length) out.set(wanted[oi++]!, text.length);
  return out;
}

/** One matching paragraph, resolved into the loaded string's coordinates. */
export interface FindSegment {
  /** The paragraph's segment ordinal — the deep link's target, and the URL page. */
  segment: number;
  /** Half-open char range `[startChar, endChar)` in the decoded text. */
  startChar: number;
  endChar: number;
  /** The folded terms this paragraph matched — what a word is marked against. */
  terms: Set<string>;
  /** The index's exact match count for this paragraph — summed for "N matches". */
  matches: number;
}

/**
 * Resolve each backend {@link TxtMatch}'s byte range to a char range in `text`,
 * in ONE byte→char pass over the whole set of offsets. Input order (ordinal =
 * byte order) is preserved.
 */
export function resolveFindSegments(text: string, segments: readonly TxtMatch[]): FindSegment[] {
  const offsets: number[] = [];
  for (const s of segments) offsets.push(s.offset, s.offset + s.length);
  const map = byteToCharMap(text, offsets);
  return segments.map((s) => ({
    segment: s.segment,
    startChar: map.get(s.offset) ?? 0,
    endChar: map.get(s.offset + s.length) ?? text.length,
    terms: new Set(s.terms.map(fold)),
    matches: s.matches,
  }));
}

/**
 * Total match instances across the matching paragraphs — the exact "N".
 *
 * Summed from the INDEX's per-paragraph counts, never from the marks the viewer
 * drew: where the client tokenises a word differently from the index the two can
 * disagree, and then the count wins — the same one-way authority find-in-note's
 * counter holds over its ovals.
 */
export function totalMatches(segments: readonly { matches: number }[]): number {
  return segments.reduce((n, s) => n + s.matches, 0);
}

/**
 * The counter copy: "N matches in M paragraphs", singular-aware. Exact, because
 * the scope is one document (the in-note counter's rule — unlike library
 * search's "20+" floors, which exist because that query stops counting early).
 */
export function txtCountText(total: number, paragraphs: number): string {
  if (paragraphs <= 0) return "No matches";
  const m = `${total} ${total === 1 ? "match" : "matches"}`;
  const p = `${paragraphs} ${paragraphs === 1 ? "paragraph" : "paragraphs"}`;
  return `${m} in ${p}`;
}

/**
 * The STREAMING counter copy (in-doc-search Phase 4): a FLOOR while the file is
 * still being drained ("N+ matches in M+ paragraphs"), settling to the exact
 * {@link txtCountText} the moment the last batch lands. A finite file always
 * reaches exact, so the "+" is only ever the in-progress display — the same
 * browser-Ctrl+F shape find-in-note's counter uses.
 */
export function txtCountProgress(total: number, paragraphs: number, done: boolean): string {
  if (done) return txtCountText(total, paragraphs);
  if (paragraphs <= 0) return "Searching…";
  const m = `${total}+ ${total === 1 ? "match" : "matches"}`;
  const p = `${paragraphs}+ ${paragraphs === 1 ? "paragraph" : "paragraphs"}`;
  return `${m} in ${p}`;
}

/** Word runs, as `unicode61` splits them: everything that is not a letter or a
 *  digit is a boundary, so `page-range` is two words and each is marked alone. */
const WORD_RE = /[\p{L}\p{N}]+/gu;

/**
 * One matching paragraph's DOM: its own substring, with each word whose folded
 * form is one of `terms` wrapped in `<mark>`. The wrapper is `.txt__match`, the
 * unit prev/next scrolls to and marks current.
 *
 * Marks are DERIVED FROM THE COUNTED TERMS, not re-matched from the query — an
 * equality test on the fold, exactly as find-in-note circles the words the index
 * counted rather than guessing at them. The text is device-authored, so every
 * piece goes in as a text node (`document.createTextNode`) or `mark`'s
 * textContent, never as markup.
 */
export function markParagraph(para: string, terms: ReadonlySet<string>): HTMLElement {
  const wrap = el("span", { class: "txt__match" });
  const children: Node[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  WORD_RE.lastIndex = 0;
  while ((m = WORD_RE.exec(para)) !== null) {
    const word = m[0];
    const at = m.index;
    if (!terms.has(fold(word))) continue;
    if (at > last) children.push(document.createTextNode(para.slice(last, at)));
    children.push(el("mark", { text: word }));
    last = at + word.length;
  }
  if (last < para.length) children.push(document.createTextNode(para.slice(last)));
  wrap.append(...children);
  return wrap;
}

/**
 * The `<pre>`'s children for `text` with every matching paragraph wrapped and
 * marked: plain text between the paragraphs, a `.txt__match` span for each.
 * Returns the wrappers in the SAME order as `segments` (ordinal order), so the
 * viewer's prev/next index and the deep link's target ordinal line up with them.
 *
 * Ranges are clamped and never allowed to overlap or go backwards, so a
 * malformed segment set degrades to less marking rather than to a scrambled
 * document.
 */
export function buildFindContent(
  text: string,
  segments: readonly FindSegment[],
): { nodes: Node[]; paras: HTMLElement[] } {
  const nodes: Node[] = [];
  const paras: HTMLElement[] = [];
  let pos = 0;
  for (const seg of segments) {
    const start = Math.max(pos, Math.min(seg.startChar, text.length));
    const end = Math.max(start, Math.min(seg.endChar, text.length));
    if (start > pos) nodes.push(document.createTextNode(text.slice(pos, start)));
    const wrap = markParagraph(text.slice(start, end), seg.terms);
    nodes.push(wrap);
    paras.push(wrap);
    pos = end;
  }
  if (pos < text.length) nodes.push(document.createTextNode(text.slice(pos)));
  return { nodes, paras };
}
