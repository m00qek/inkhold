// The line shown under a search result: where in the document the words
// typed sit closest together. Built in the browser from the text the browser
// already holds, so the server never sees a query; never fetched for a search.
//
// Which line, among a document's matching pages: the page whose shortest
// stretch holding every query word is shortest; then one matched as typed
// over one that needed the last word's start; then the earliest page. Only
// the first `MAX_PAGES` matching pages are read, whatever the document's size.

import { el } from "../ui/dom";
import { fold, words } from "./fold";
import type { Expansion } from "./localSearch";
import type { TextSegment } from "./docText";
import type { StoredDocumentText } from "../cache/textStore";

/** Pages read per document: a 900-page PDF costs what a 50-page one does. */
export const MAX_PAGES = 50;
/** About one line of a result, in characters. */
export const WIDTH = 140;

/** What the query asks of a word: one of `terms`, or for `start`, beginning so. */
export interface ExcerptQuery {
  readonly terms: readonly string[];
  /** The last word as typed, matched as the start of a word; null after a space or a typo answer. */
  readonly start: string | null;
}

/**
 * The query's folded words. Where the typo ladder answered, its words replace
 * the typed ones: the excerpt shows what the device actually wrote.
 */
export function excerptQuery(q: string, expansions: readonly Expansion[] = []): ExcerptQuery | null {
  const typed = words(q);
  if (typed.length === 0) return null;
  const swap = new Map(expansions.map((e) => [fold(e.typed), fold(e.matched)]));
  const terms = typed.map((t) => swap.get(t) ?? t);
  // The word being typed is a prefix in the index, unless the ladder replaced it.
  const last = typed[typed.length - 1]!;
  const start = /\s$/.test(q) || swap.has(last) ? null : last;
  return { terms: start === null ? terms : terms.slice(0, -1), start };
}

/** The excerpt: a cut of one segment, and where the matched words are in it. */
export interface Excerpt {
  /** The segment's ordinal: the page (or `.txt` paragraph) it is from. */
  readonly segment: number;
  readonly text: string;
  /** [start, end) in `text`. */
  readonly marks: readonly (readonly [number, number])[];
  /** True when it was cut before the start; for the leading "…". */
  readonly cutStart: boolean;
  readonly cutEnd: boolean;
}

interface Token {
  readonly start: number;
  readonly end: number;
  /** Which query words it satisfies, as bits: terms first, `start` last. */
  readonly hits: number;
  /** It satisfied `start` only as a beginning, not whole. */
  readonly partial: boolean;
}

const WORD = /[\p{L}\p{M}\p{N}]+/gu;

/** The words of `text` that satisfy any query word, with where they are. */
function tokens(text: string, q: ExcerptQuery): Token[] {
  const out: Token[] = [];
  const n = q.terms.length;
  for (const m of text.matchAll(WORD)) {
    let hits = 0;
    let partial = false;
    for (const part of words(m[0])) {
      const i = q.terms.indexOf(part);
      if (i >= 0) hits |= 1 << i;
      if (q.start !== null && part.startsWith(q.start)) {
        hits |= 1 << n;
        if (part !== q.start) partial = true;
      }
    }
    if (hits !== 0) out.push({ start: m.index, end: m.index + m[0].length, hits, partial });
  }
  return out;
}

interface Window {
  readonly from: Token;
  readonly to: Token;
  /** Query words it holds: all of them, unless the page has fewer. */
  readonly covered: number;
  readonly span: number;
  readonly partial: boolean;
}

const bits = (x: number) => {
  let c = 0;
  for (; x; x &= x - 1) c++;
  return c;
};

/** The shortest stretch of `toks` holding every query word the page has. */
function shortest(toks: readonly Token[], all: number): Window | null {
  if (toks.length === 0) return null;
  const present = toks.reduce((m, t) => m | t.hits, 0);
  const want = present & all;
  const count = new Map<number, number>();
  let have = 0;
  let best: Window | null = null;
  let lo = 0;
  for (let hi = 0; hi < toks.length; hi++) {
    for (let b = 0; 1 << b <= want; b++) {
      if (!(toks[hi]!.hits & (1 << b))) continue;
      const c = (count.get(b) ?? 0) + 1;
      count.set(b, c);
      if (c === 1) have |= 1 << b;
    }
    while (have === want) {
      const from = toks[lo]!;
      const to = toks[hi]!;
      const span = to.end - from.start;
      const partial = toks.slice(lo, hi + 1).some((t) => t.partial);
      if (!best || span < best.span || (span === best.span && best.partial && !partial)) {
        best = { from, to, covered: bits(want), span, partial };
      }
      for (let b = 0; 1 << b <= want; b++) {
        if (!(from.hits & (1 << b))) continue;
        const c = count.get(b)! - 1;
        count.set(b, c);
        if (c === 0) have &= ~(1 << b);
      }
      lo++;
    }
  }
  return best;
}

/** True when `a` is the better line: more words, then shorter, then whole words. Ties keep the earlier page. */
function better(a: Window, b: Window): boolean {
  if (a.covered !== b.covered) return a.covered > b.covered;
  if (a.span !== b.span) return a.span < b.span;
  return b.partial && !a.partial;
}

const isWord = (ch: string | undefined) => ch !== undefined && /[\p{L}\p{M}\p{N}]/u.test(ch);

/** One line around [from, to) of `text`, at word edges, whitespace collapsed; marks kept in step. */
function cut(segment: number, text: string, from: number, to: number, toks: readonly Token[]): Excerpt {
  const len = text.length;
  let a: number;
  let b: number;
  if (to - from >= WIDTH) {
    // Words far apart: the stretch's start, as much as fits.
    a = from;
    b = Math.min(len, from + WIDTH);
  } else {
    // A little before the words, the rest after them.
    a = Math.max(0, from - Math.floor((WIDTH - (to - from)) * 0.3));
    b = Math.min(len, a + WIDTH);
    if (b === len) a = Math.max(0, len - WIDTH);
  }
  // Never mid-word, and never past the matched words.
  while (a > 0 && a < from && isWord(text[a - 1])) a++;
  while (b < len && b > to && isWord(text[b])) b--;

  let out = "";
  const at = new Map<number, number>();
  let space = false;
  for (let i = a; i < b; i++) {
    const ch = text[i]!;
    if (/\s/.test(ch)) {
      at.set(i, out.length);
      space = out.length > 0;
      continue;
    }
    if (space) out += " ";
    space = false;
    at.set(i, out.length);
    out += ch;
  }
  at.set(b, out.length);
  const marks: [number, number][] = [];
  for (const t of toks) {
    if (t.start < a || t.end > b) continue;
    marks.push([at.get(t.start)!, at.get(t.end)!]);
  }
  return { segment, text: out.trimEnd(), marks, cutStart: a > 0, cutEnd: b < len };
}

/**
 * The best line among `pages` (ascending ordinals) of `doc`, or null when none
 * of them holds a query word as the browser folds it.
 */
export function pickExcerpt(doc: Pick<StoredDocumentText, "segments">, pages: readonly number[], q: ExcerptQuery): Excerpt | null {
  const want = new Set(pages.slice(0, MAX_PAGES));
  const all = (1 << (q.terms.length + (q.start === null ? 0 : 1))) - 1;
  let best: { seg: TextSegment; win: Window; toks: Token[] } | null = null;
  for (const seg of doc.segments) {
    if (!want.has(seg.p)) continue;
    const toks = tokens(seg.t, q);
    const win = shortest(toks, all);
    if (!win) continue;
    const tie = best !== null && !better(win, best.win) && !better(best.win, win);
    if (!best || better(win, best.win) || (tie && seg.p < best.seg.p)) {
      best = { seg, win, toks };
    }
  }
  if (!best) return null;
  return cut(best.seg.p, best.seg.t, best.win.from.start, best.win.to.end, best.toks);
}

/** The excerpt as nodes: text, and `<mark>` around the matched words; never markup. */
export function excerptNodes(x: Excerpt): Node[] {
  const out: Node[] = [];
  if (x.cutStart) out.push(document.createTextNode("…"));
  let from = 0;
  for (const [a, b] of x.marks) {
    if (a > from) out.push(document.createTextNode(x.text.slice(from, a)));
    out.push(el("mark", { text: x.text.slice(a, b) }));
    from = b;
  }
  if (from < x.text.length) out.push(document.createTextNode(x.text.slice(from)));
  if (x.cutEnd) out.push(document.createTextNode("…"));
  return out;
}
