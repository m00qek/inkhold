// What the browser still does with a query itself, beside the index, which
// decides every word match (names, to-dos and digests are rows there): mark
// the matched words, by the index's rule imitated (`fold.ts`, `nameQuery`),
// and the one fallback FTS5 cannot do, the typed text anywhere in a name
// ("style" in "MyStyle", `insideQuery`), used only when the index matched no
// name or to-do as typed. A fallback, never a widening.

import { fold, words } from "./fold";
import { holdsAll, phrasesOf, type Phrase } from "./phrase";

/** A query ready to test names against; null when it has no words. */
export interface NameQuery {
  readonly whole: readonly string[];
  /** The last word, matched as the start of a word. */
  readonly start: string;
  /** The fallback's: the folded query, matched anywhere in the folded name. */
  readonly inside?: string;
  /** Quoted phrases: their words next to each other, in order (`phrase.ts`). */
  readonly phrases?: readonly Phrase[];
}

export function nameQuery(q: string): NameQuery | null {
  const terms = words(q);
  if (terms.length === 0) return null;
  return { whole: terms.slice(0, -1), start: terms[terms.length - 1]!, phrases: phrasesOf(q) };
}

/** The fallback: the typed text, folded, anywhere in a name. Null when blank. */
export function insideQuery(q: string): NameQuery | null {
  const inside = fold(q).replace(/"/g, "").replace(/\s+/g, " ").trim();
  return inside === "" ? null : { whole: [], start: "", inside };
}

/** True when every query word is a word of `text` (the last, the start of one). */
export function matchesName(text: string, query: NameQuery | null): boolean {
  if (!query) return false;
  if (query.inside !== undefined) return fold(text).includes(query.inside);
  const have = words(text);
  if (!query.whole.every((t) => have.includes(t))) return false;
  if (!have.some((w) => w.startsWith(query.start))) return false;
  return holdsAll(text, query.phrases ?? []);
}

/** A word of the name, by where it sits in the original string. */
const WORD = /[\p{L}\p{M}\p{N}]+/gu;

/**
 * Where the query's words sit in `text`, as [start, end) ranges of the
 * original string, for marking. Whole words are marked, also for the last
 * query word, which may have matched only the start of one.
 */
export function nameMarks(text: string, query: NameQuery | null): [number, number][] {
  if (!query || !matchesName(text, query)) return [];
  return queryMarks(text, query);
}

/**
 * The query's words in `text`, whether or not `text` matched on its own: a
 * to-do matches on its title, notebook and list together, and its title shows
 * whichever of the words it holds.
 */
export function queryMarks(text: string, query: NameQuery | null): [number, number][] {
  if (!query) return [];
  if (query.inside !== undefined) return text === "" ? [] : insideMarks(text, query.inside);
  return wordMarks(text, (w) => query.whole.includes(w) || w.startsWith(query.start));
}

/** Whole words of `text` (original positions) one of whose folded parts `accept` takes. */
export function wordMarks(text: string, accept: (folded: string) => boolean): [number, number][] {
  const out: [number, number][] = [];
  for (const m of text.matchAll(WORD)) {
    if (words(m[0]).some(accept)) out.push([m.index, m.index + m[0].length]);
  }
  return out;
}

/** Each occurrence of `needle` in the folded `text`, mapped back to the original. */
function insideMarks(text: string, needle: string): [number, number][] {
  // Folded code units and, for each, the original index it came from.
  let folded = "";
  const from: number[] = [];
  for (let i = 0; i < text.length; ) {
    const ch = String.fromCodePoint(text.codePointAt(i)!);
    const f = fold(ch);
    for (let k = 0; k < f.length; k++) from.push(i);
    folded += f;
    i += ch.length;
  }
  from.push(text.length);
  const out: [number, number][] = [];
  for (let at = folded.indexOf(needle); at >= 0; at = folded.indexOf(needle, at + needle.length)) {
    const end = from[at + needle.length]!;
    // A trailing combining mark belongs to the letter before it.
    let stop = end;
    while (stop < text.length && /\p{M}/u.test(text[stop]!)) stop++;
    out.push([from[at]!, stop]);
  }
  return out;
}
