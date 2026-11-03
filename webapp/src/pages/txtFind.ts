// Pure text/DOM operations behind the `.txt` viewer's find. A `.txt` has no
// geometry, so a match is a substring and highlighting is DOM work. The hazard:
// the index addresses paragraphs by UTF-8 byte offset, the viewer holds a UTF-16
// string, and `byteToCharMap` is the one conversion between them.

import { el } from "../ui/dom";
// Shared imitation of `unicode61 remove_diacritics 2`; `WORD_RE` below is the
// same split as a global regex whose match indices place each `<mark>`.
import { fold } from "../search/fold";

function utf8Len(cp: number): number {
  if (cp <= 0x7f) return 1;
  if (cp <= 0x7ff) return 2;
  if (cp <= 0xffff) return 3;
  return 4;
}

/**
 * Map raw-blob byte offsets to UTF-16 indices in one pass. An offset landing
 * mid-sequence (hostile or lossily-decoded input) resolves to the first char at
 * or past it.
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

/** A matching `.txt` paragraph as the index reports it (byte range present). */
export interface TxtSegmentMatch {
  readonly segment: number;
  /** Byte offset and byte length in the raw blob. */
  readonly offset: number;
  readonly length: number;
  readonly matches: number;
  readonly terms: readonly string[];
}

export interface FindSegment {
  segment: number;
  /** Half-open char range in the decoded text. */
  startChar: number;
  endChar: number;
  terms: Set<string>;
  matches: number;
}

export function resolveFindSegments(text: string, segments: readonly TxtSegmentMatch[]): FindSegment[] {
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
 * The exact "N", summed from the index's counts rather than the drawn marks:
 * where tokenisation disagrees, the index wins.
 */
export function totalMatches(segments: readonly { matches: number }[]): number {
  return segments.reduce((n, s) => n + s.matches, 0);
}

/** Shown while the first find pays the `text/<md5>` fetch and index build. */
export const TXT_SEARCHING = "Searching…";

/** Exact count, since the scope is one document. */
export function txtCountText(total: number, paragraphs: number): string {
  if (paragraphs <= 0) return "No matches";
  const m = `${total} ${total === 1 ? "match" : "matches"}`;
  const p = `${paragraphs} ${paragraphs === 1 ? "paragraph" : "paragraphs"}`;
  return `${m} in ${p}`;
}

/** Word runs as `unicode61` splits them: any non-letter/digit is a boundary. */
const WORD_RE = /[\p{L}\p{N}]+/gu;

/**
 * Marks words whose fold is in `terms` (the counted terms, not a re-match of the
 * query). Device-authored text goes in as text nodes, never markup.
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
 * Wrappers come back in `segments` order to line up with prev/next and deep
 * links. Ranges are clamped and never overlap, so bad segments mark less rather
 * than scramble the document.
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
