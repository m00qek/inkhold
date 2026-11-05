// Quoted phrases: `"passé composé"` asks for those words, next to each other,
// in that order. The index has one set of words per page and can't tell, so
// it finds the candidate pages and this checks them against the page's text,
// folded the way the index folds (`fold.ts`). A quote still being typed is a
// phrase too, its last word matched as the start of one, as the index treats
// the word being typed. A single quoted word is just a word.

import { fold, words } from "./fold";
import type { Expansion } from "./localSearch";

export interface Phrase {
  /** Folded, in order; at least two. */
  readonly words: readonly string[];
  /** The closing quote is not typed yet: the last word may be a start. */
  readonly open: boolean;
}

/** The query's phrases, in the order typed. */
export function phrasesOf(q: string): Phrase[] {
  const out: Phrase[] = [];
  for (const m of q.matchAll(/"([^"]*)("?)/g)) {
    const ws = words(m[1]!);
    if (ws.length >= 2) out.push({ words: ws, open: m[2] !== '"' });
  }
  return out;
}

/** Where the typo ladder answered, its words stand in for the typed ones. */
export function withExpansions(phrases: readonly Phrase[], expansions: readonly Expansion[]): Phrase[] {
  if (expansions.length === 0) return [...phrases];
  const swap = new Map(expansions.map((e) => [fold(e.typed), fold(e.matched)]));
  return phrases.map((p) => ({ words: p.words.map((w) => swap.get(w) ?? w), open: p.open }));
}

/** True when `have` (a text's folded words) holds the phrase, word next to word. */
export function holds(have: readonly string[], p: Phrase): boolean {
  const n = p.words.length;
  for (let i = 0; i + n <= have.length; i++) {
    let ok = true;
    for (let k = 0; k < n && ok; k++) {
      const want = p.words[k]!;
      const got = have[i + k]!;
      ok = p.open && k === n - 1 ? got.startsWith(want) : got === want;
    }
    if (ok) return true;
  }
  return false;
}

/** True when `text` holds every phrase. */
export function holdsAll(text: string, phrases: readonly Phrase[]): boolean {
  if (phrases.length === 0) return true;
  const have = words(text);
  return phrases.every((p) => holds(have, p));
}
