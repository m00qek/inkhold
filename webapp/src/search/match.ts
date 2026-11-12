// What the browser still does with a query itself, beside the index, which
// decides every word match (names, to-dos and digests are rows there): the
// one fallback FTS5 cannot do, the typed text anywhere in a name ("style" in
// "MyStyle"), used only when the index matched no name or to-do as typed (a
// fallback, never a widening); and marking the matched words, folded as the
// index folds them (`fold.ts`).

import { fold, words } from "./fold";

/** The fallback's needle: the typed text, folded, without quotes; null when blank. */
export function insideOf(q: string): string | null {
  const needle = fold(q).replace(/"/g, "").replace(/\s+/g, " ").trim();
  return needle === "" ? null : needle;
}

/** True when the folded `text` holds `needle` anywhere. */
export function holdsInside(text: string, needle: string | null): boolean {
  return needle !== null && fold(text).includes(needle);
}

/** A word of the text, by where it sits in the original string. */
const WORD = /[\p{L}\p{M}\p{N}]+/gu;

/**
 * The words to mark in a result's name or title, as [start, end) ranges of
 * the original string: the typed ones, accents and order aside, the last
 * also as the start of a word (the index's rule), and where the typo ladder
 * answered, its spellings of them. Whole words are marked.
 */
export function typedMarks(text: string, q: string, expansions: readonly { readonly matched: string }[]): [number, number][] {
  const typed = words(q);
  if (typed.length === 0) return [];
  const whole = new Set(typed.slice(0, -1));
  const start = typed[typed.length - 1]!;
  const matched = new Set(expansions.map((e) => fold(e.matched)));
  return wordMarks(text, (w) => whole.has(w) || w.startsWith(start) || matched.has(w));
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
export function insideMarks(text: string, needle: string | null): [number, number][] {
  if (needle === null || text === "") return [];
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
