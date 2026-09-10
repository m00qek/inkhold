// The client's imitation of the index's tokenizer: one fold, one word split.
//
// The server, the search wasm and every highlight adapter have to agree on what
// a "word" is, or a search hit lands on a page with nothing marked on it. The
// index's answer is `unicode61 remove_diacritics 2`; this file is that rule
// hand-written in TypeScript, and `tests/unit/foldAgreement.test.ts` pins it
// against the real tokenizer in `sqlite-core.wasm`.
//
// WHY AN IMITATION RATHER THAN A CALL. The wasm tokenizer is exact and reachable,
// and using it would put a wasm round trip on every keystroke of a find box.
// The imitation is the trade; the agreement test is what makes it safe.
//
// NOTHING HERE DECIDES A MATCH. Membership is FTS5's — this only names, among
// the words of a segment the index ALREADY matched, which ones to point at. So a
// divergence costs a mark and never a result, and the failure is silent and
// one-sided: the count stays right and the highlights quietly stop appearing.

/**
 * Case- and accent-insensitive form — the client's half of `remove_diacritics
 * 2`, so `avaliação` typed as `avaliacao` marks the word the index counted.
 */
export function fold(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

/**
 * The folded terms one run carries, in order and with repeats — `unicode61`
 * splits on everything that is not a letter or a digit, so `page-range` is two
 * terms and `Endor,` is one.
 *
 * FOLDING FIRST AND SPLITTING AFTER is the order that matches the tokenizer:
 * `unicode61` removes a combining mark, it does not break at one, so decomposed
 * `áb` is the single term `ab` on both sides. Splitting first would make it two.
 *
 * This is also where MEMBERSHIP is decided for the PDF viewer, which is why
 * `pdf_shim.c`'s own splitting need only be good enough for a BOX: anything it
 * glues together is pulled apart here before the comparison, so a separator it
 * does not know costs a slightly wide mark and never a lost match.
 */
export function words(text: string): string[] {
  return fold(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}
