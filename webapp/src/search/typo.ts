// The typo ladder for what the index doesn't hold (to-dos): the rules of the
// in-wasm one (`webapp/wasm/sqlite_core_fuzzy.zig`), over a small vocabulary
// in the browser. A fallback, never a widening: used only when nothing
// matched as typed.

/** Allowed edits by length in codepoints: none up to 3, then 1, then 2. */
export function maxEdits(len: number): number {
  if (len <= 3) return 0;
  if (len <= 7) return 1;
  return 2;
}

/** Damerau-Levenshtein (optimal string alignment) distance, in codepoints. */
export function editDistance(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  const d: number[][] = Array.from({ length: x.length + 1 }, (_, i) => [i, ...Array<number>(y.length).fill(0)]);
  for (let j = 1; j <= y.length; j++) d[0]![j] = j;
  for (let i = 1; i <= x.length; i++) {
    for (let j = 1; j <= y.length; j++) {
      const cost = x[i - 1] === y[j - 1] ? 0 : 1;
      let v = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && x[i - 1] === y[j - 2] && x[i - 2] === y[j - 1]) v = Math.min(v, d[i - 2]![j - 2]! + 1);
      d[i]![j] = v;
    }
  }
  return d[x.length]![y.length]!;
}

/**
 * The words of `vocab` nearest `term` within its edit budget: the best tier
 * only (smallest distance, then smallest length difference), as the index's
 * ladder keeps. Empty when none is close enough.
 */
export function nearest(term: string, vocab: Iterable<string>): string[] {
  const len = [...term].length;
  const budget = maxEdits(len);
  if (budget === 0) return [];
  let best: { dist: number; delta: number } | null = null;
  let out: string[] = [];
  for (const w of new Set(vocab)) {
    if (w === term) continue;
    const delta = Math.abs([...w].length - len);
    if (delta > budget) continue;
    const dist = editDistance(term, w);
    if (dist > budget) continue;
    if (!best || dist < best.dist || (dist === best.dist && delta < best.delta)) {
      best = { dist, delta };
      out = [w];
    } else if (dist === best.dist && delta === best.delta) {
      out.push(w);
    }
  }
  return out.sort();
}
