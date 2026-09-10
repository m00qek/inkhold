import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { countMarks } from "../../src/search/docSearch";
import { fold, words as wordTerms } from "../../src/search/fold";

// THE SAFETY NET FOR THE HAND-WRITTEN TOKENIZER (§8.3).
//
// Find-in-document works only because three things agree on what a "word" is:
//
//   1. the server's FTS5 tokenizer — `unicode61 remove_diacritics 2`;
//   2. the client's search wasm — the same tokenizer, from the same string;
//   3. a HAND-WRITTEN TypeScript imitation of it — `search/fold.ts`'s `fold`
//      and `words`, the one module `docSearch.ts` and all three find bars
//      (`pdfFind.ts`, `findInNote.ts`, `txtFind.ts`) call.
//
// (3) is an approximation, and until this file nothing checked it. A drift is
// SILENT and one-sided: FTS5 still counts the match, the TS side no longer
// names a word to point at, and the user sees a search hit with no highlight —
// which reads as "find is broken" and points at nothing. That is precisely the
// failure §6's honesty rule was designed around.
//
// WHAT IS ASSERTED IS A PROPERTY, NOT AN EQUALITY OF TOKEN LISTS. The module
// exposes no tokenize entry point, and §8.5 rules out adding one for this step,
// so the tokenizer's own tokens cannot be enumerated. Instead, for each fixture
// string T: index T as a document, split it with the TS implementation, and
// assert that EVERY word TS produced finds that document by an exact term
// query. "Every word TS thinks is a word is findable in the index the server
// built" is exactly the property that makes a highlight land.
//
// A subset property, not an equality — so it does not catch a tokenizer that
// splits FINER than TS (`kitab` -> `ki` + `tab` while TS says `kitab` would
// pass here). That direction costs a mark that is slightly wide, never a
// missing one, which is the same trade `pdfFind.ts` documents for the decoder's
// splitting. The direction that costs a LOST highlight is the one pinned.

const wasmPath = fileURLToPath(new URL("../../public/sqlite-core.wasm", import.meta.url));

/** The slice of the `idx_*` ABI this file drives. */
interface Core {
  memory: WebAssembly.Memory;
  _initialize?: () => void;
  idx_alloc: (n: number) => number;
  idx_free: (ptr: number, n: number) => void;
  idx_open: () => number;
  idx_close: () => void;
  idx_begin: () => number;
  idx_add: (docId: number, ptr: number, len: number) => number;
  idx_commit: () => number;
  idx_query: (ptr: number, len: number, limit: number) => number;
  idx_hit: (i: number) => number;
  idx_errmsg_ptr: () => number;
  idx_errmsg_len: () => number;
}

let core: Core;

/** Copy a string into wasm memory as UTF-8; one byte of slack so the empty
 *  string still has an address. The view is built AFTER the alloc, which can
 *  grow `memory` and detach any view taken before it. */
function put(text: string): [number, number] {
  const buf = Buffer.from(text, "utf8");
  const ptr = core.idx_alloc(buf.length + 1);
  new Uint8Array(core.memory.buffer, ptr, buf.length + 1).set(buf, 0);
  return [ptr, buf.length];
}

function drop([ptr, len]: [number, number]): void {
  core.idx_free(ptr, len + 1);
}

function errorText(): string {
  const n = core.idx_errmsg_len();
  if (n === 0) return "";
  return Buffer.from(new Uint8Array(core.memory.buffer, core.idx_errmsg_ptr(), n)).toString("utf8");
}

/**
 * The document ids one term matches, through the REAL tokenizer.
 *
 * THE TRAILING SPACE IS LOAD-BEARING. `buildMatch` appends a `*` to the last
 * term unless the query ends in whitespace, and a prefix match would let
 * `page` "find" a document whose only term is `pagebreak` — which is the exact
 * divergence the PUA fixture below exists to pin. Every query here is closed.
 */
function hitsFor(term: string): number[] {
  const buf = put(`${term} `);
  const total = core.idx_query(buf[0], buf[1], 32);
  const hits: number[] = [];
  if (total >= 0) for (let i = 0; i < Math.min(total, 32); i++) hits.push(core.idx_hit(i));
  drop(buf);
  if (total < 0) throw new Error(`idx_query(${JSON.stringify(term)}) failed: ${errorText()}`);
  return hits;
}

/**
 * `docSearch.ts`'s split, reached through its real caller: `countMarks` reports
 * every word it found whose fold starts with `plan.prefix`, and the empty
 * prefix is a prefix of everything. The same rule by construction since §8.2's
 * merge finished (§9.0: four copies, not two) — reached through the caller
 * rather than by importing `words` directly, so that a `countMarks` which grew
 * its own split again would be visible here.
 */
function docSearchWords(text: string): string[] {
  return countMarks(text, { exact: new Set<string>(), prefix: "" }).terms;
}

/**
 * The server's PUA filter, mirrored for ONE fixture — `stripPrivateUse` in
 * `backend/services/pdf_text.zig` (the three ranges are its `isPrivateUse`).
 * A fixture transform, not a second implementation: it exists so the PUA case
 * can state which pipeline the TS split agrees with. See PUA_STRIPPED below.
 */
function stripPrivateUse(text: string): string {
  return [...text]
    .map((ch) => {
      const cp = ch.codePointAt(0)!;
      const pua =
        (cp >= 0xe000 && cp <= 0xf8ff) ||
        (cp >= 0xf0000 && cp <= 0xffffd) ||
        (cp >= 0x100000 && cp <= 0x10fffd);
      return pua ? " " : ch;
    })
    .join("");
}

/** A term in no fixture, so "not found" can be told from "the query broke". */
const ABSENT = "quatloos";

const PUA_RAW = "page\u{E906}break";
const PUA_STRIPPED = stripPrivateUse(PUA_RAW);

/**
 * The hard cases, one document each. Every one of these was chosen because the
 * TS regex and `unicode61` could plausibly disagree about it.
 */
const FIXTURES: ReadonlyArray<{ id: number; what: string; text: string }> = [
  { id: 1, what: "plain ASCII", text: "the quick brown fox" },
  // `remove_diacritics 2` is half the tokenizer contract; the TS side spells it
  // NFD + strip U+0300-036F. Queried unaccented below, as `reuniao`.
  { id: 2, what: "Latin accents", text: "reunião de avaliação" },
  { id: 3, what: "case", text: "MAIÚSCULAS Uppercase TITLE" },
  { id: 4, what: "hyphenated compounds", text: "page-range hyphen-compound" },
  { id: 5, what: "punctuation runs", text: "spaced -- out ... punctuation!! (runs)" },
  { id: 6, what: "digits with letters", text: "A4 2022 x86 h2o" },
  // THE UNDERSCORE. `_` is Unicode category Pc, so the TS regex splits on it;
  // whether `unicode61` does was the open question. It does — see the dedicated
  // test below, which pins it from the tokenizer's side rather than by
  // coincidence of this fixture passing.
  { id: 7, what: "underscores", text: "unicode61 snake_case_word _leading trailing_" },
  // NON-LATIN COMBINING MARKS. The TS `fold` strips only U+0300-036F, so Arabic
  // harakat and Devanagari matras survive it — and then the split treats them as
  // separators, because Mn/Mc are neither \p{L} nor \p{N}. `unicode61` breaks at
  // them too, so the fragments TS produces are real index terms. Fine-grained
  // and ugly on both sides, but AGREED, which is all a highlight needs.
  { id: 8, what: "Arabic harakat", text: "كِتَاب مُحَمَّد" },
  { id: 9, what: "Devanagari matras", text: "हिन्दी नमस्ते" },
  // THE PUA CASE, AND IT IS NOT A COINCIDENCE ANY MORE.
  //
  // §3 made the SERVER replace Private Use Area codepoints with
  // spaces before indexing, because `unicode61` treats a PUA codepoint as a
  // token CHARACTER — an icon glyph glued to a word made the word unfindable.
  // The TS split happens to break there too (category Co is not \p{L}/\p{N}).
  //
  // So the agreement asserted here is with the SERVER'S PIPELINE, not with
  // `unicode61` alone. This fixture is therefore the server-processed string;
  // the raw one is asserted to DISAGREE, in its own test below, so the
  // distinction is pinned rather than assumed.
  { id: 10, what: "PUA, as the server indexes it", text: PUA_STRIPPED },
  // DECOMPOSED INPUT, and this one pins an ORDER rather than a character class.
  //
  // `search/fold.ts` folds and THEN splits. The other order was live in
  // `countMarks` until the two copies were merged, and the two disagree here:
  // fold-first strips the combining acute and yields one term `ab`, split-first
  // breaks at it (Mn is neither \p{L} nor \p{N}) and yields `a` and `b`.
  //
  // Only one of those can match the index. `unicode61 remove_diacritics 2`
  // REMOVES a combining mark, it does not break at one — so `ab` is the term,
  // and fold-first is the order that agrees. Asserted here rather than reasoned
  // about, because the merge changed `countMarks` to this order and nothing else
  // in this file is decomposed.
  { id: 11, what: "decomposed accent", text: "a\u0301b sep\u0301arate" },
];

beforeAll(async () => {
  if (!existsSync(wasmPath)) throw new Error(`missing ${wasmPath} — run \`npm run build:wasm\``);
  // The real artifact the app serves, instantiated the way `indexEngine.ts`
  // does it: zero imports, then the reactor's `_initialize` for the null VFS.
  const { instance } = await WebAssembly.instantiate(readFileSync(wasmPath), {});
  core = instance.exports as unknown as Core;
  core._initialize?.();

  const opened = core.idx_open();
  if (opened !== 0) throw new Error(`idx_open failed (${opened}): ${errorText()}`);
  if (core.idx_begin() !== 0) throw new Error(`idx_begin failed: ${errorText()}`);
  for (const f of FIXTURES) {
    const buf = put(f.text);
    const rc = core.idx_add(f.id, buf[0], buf[1]);
    drop(buf);
    if (rc !== 0) throw new Error(`idx_add(${f.id}) failed (${rc}): ${errorText()}`);
  }
  // The raw PUA string under its own id, for the divergence test.
  {
    const buf = put(PUA_RAW);
    const rc = core.idx_add(99, buf[0], buf[1]);
    drop(buf);
    if (rc !== 0) throw new Error(`idx_add(99) failed (${rc}): ${errorText()}`);
  }
  if (core.idx_commit() !== 0) throw new Error(`idx_commit failed: ${errorText()}`);
});

afterAll(() => core?.idx_close?.());

describe("the TS word split agrees with the real FTS5 tokenizer", () => {
  for (const f of FIXTURES) {
    it(`${f.what}: every word \`wordTerms\` finds is a term in the index`, () => {
      const terms = wordTerms(f.text);
      expect(terms.length, `${JSON.stringify(f.text)} produced no words`).toBeGreaterThan(0);

      for (const term of terms) {
        expect(
          hitsFor(term),
          `TS split ${JSON.stringify(f.text)} into ${JSON.stringify(terms)}, but the ` +
            `tokenizer has no term ${JSON.stringify(term)} in that document — a hit ` +
            `here would highlight nothing`,
        ).toContain(f.id);
      }

      // CASE HAS TO BE PINNED SEPARATELY, because the round trip is blind to
      // it: `buildMatch` folds the QUERY through the same tokenizer, so
      // `hitsFor("MAIUSCULAS")` finds the document whether or not the TS side
      // lowercases. What is observable is that the tokenizer's terms do not
      // change when the text is shouted (`hitsFor("REUNIAO")` below, and the
      // ABI test's own diacritic block) — so the TS split's must not either.
      // Without this line, a `fold` that stopped lowercasing would still pass
      // every assertion above and lose every highlight in production.
      expect(
        wordTerms(f.text.toUpperCase()),
        "the index folds case away; the TS split must fold the same case away",
      ).toEqual(terms);

      // The control: without it every assertion above would still pass against
      // a query function that answered "found" to anything.
      expect(hitsFor(ABSENT), "the control term must not match").not.toContain(f.id);
    });
  }

  // ALL FOUR copies of the rule (§8.2, corrected by §9.0) are now one module,
  // so this compares `search/fold`'s `words` with itself and cannot fail as
  // written. It stays as a TRIPWIRE, and that is now its only job: the day
  // anyone gives `countMarks` a split of its own again — the easiest thing in
  // the world to do, since a local two-line regex looks like less coupling than
  // an import — this starts comparing two rules again and fails on the
  // decomposed fixture before the divergence can reach a highlight.
  it("`search/fold`'s `words` and `docSearch`'s own split agree", () => {
    for (const f of [...FIXTURES, { id: 99, what: "raw PUA", text: PUA_RAW }]) {
      expect(new Set(docSearchWords(f.text)), f.what).toEqual(new Set(wordTerms(f.text)));
    }
  });

  it("an accented query and its unaccented fold reach the same document", () => {
    // `fold` is the client's half of `remove_diacritics 2`, asserted against the
    // tokenizer rather than against itself: both spellings are one term.
    expect(fold("reunião")).toBe("reuniao");
    expect(hitsFor("reuniao")).toContain(2);
    expect(hitsFor("reunião")).toContain(2);
    expect(hitsFor("REUNIAO")).toContain(2);
  });

  // THE UNDERSCORE, FROM THE TOKENIZER'S SIDE. `snake_case_word` was indexed as
  // one run; if `unicode61` kept `_` as a token character then `snake` would not
  // be a term and the fixture above would have failed. It is a term, so the two
  // sides agree that `_` is a separator. Asserted here so a future
  // `tokenchars=_` shows up as this test rather than as a lost highlight.
  it("`unicode61` splits on `_`, which is what the TS regex assumes", () => {
    expect(hitsFor("snake")).toContain(7);
    expect(hitsFor("case")).toContain(7);
    expect(hitsFor("word")).toContain(7);
    expect(hitsFor("snake_case_word")).toContain(7);
  });

  // THE HONESTY TEST. `unicode61` does NOT break at a PUA codepoint — that was
  // §3's bug — so on the RAW string the TS split and the
  // tokenizer genuinely disagree, and this pins the disagreement:
  // `page\u{E906}break` is ONE term to the index and TWO words to TS.
  //
  // Nothing is broken by it, because the server strips PUA before indexing and
  // the fixture above covers the string the index actually receives. But it is
  // the reason that agreement must never be claimed as agreement with
  // `unicode61`. If this test starts failing, the tokenizer changed and the
  // server's filter may no longer be load-bearing — reread §3 before deleting it.
  it("PUA is a token CHARACTER to `unicode61`: the raw string genuinely disagrees", () => {
    expect(wordTerms(PUA_RAW)).toEqual(["page", "break"]);
    expect(hitsFor("pagebreak")).not.toContain(99);
    expect(hitsFor("page"), "TS says `page`; the raw document has no such term").not.toContain(99);
    expect(hitsFor("break"), "TS says `break`; the raw document has no such term").not.toContain(99);
    // The whole glued run IS the term, which is the §3 bug stated as data.
    expect(hitsFor(PUA_RAW)).toContain(99);
    // ...and the same bytes after the server's filter split into two terms.
    expect(hitsFor("page")).toContain(10);
    expect(hitsFor("break")).toContain(10);
  });
});
