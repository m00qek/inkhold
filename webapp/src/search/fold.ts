// A hand-written imitation of the index tokenizer (`unicode61
// remove_diacritics 2`), pinned against the real wasm by
// `tests/unit/foldAgreement.test.ts`. Calling the wasm would cost a round trip
// per find keystroke. This never decides a match, only which words to mark,
// so a divergence silently loses highlights, never results.

/** Case- and accent-insensitive form, the client's half of `remove_diacritics 2`. */
export function fold(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

/**
 * Folded terms in order, with repeats; splits on anything not a letter or
 * digit. Fold before splitting: `unicode61` removes combining marks rather
 * than breaking at them. For PDFs this is where marked words are re-split, so
 * `pdf_shim.c`'s word boxes need only be roughly right.
 */
export function words(text: string): string[] {
  return fold(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}
