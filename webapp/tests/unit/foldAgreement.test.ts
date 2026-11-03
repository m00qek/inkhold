import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { countMarks } from "../../src/search/docSearch";
import { fold, words as wordTerms } from "../../src/search/fold";

// The TS `fold`/`words` must agree with FTS5's `unicode61 remove_diacritics 2`, or
// a counted match gets no highlight. Asserted as a subset: every TS word must find
// its document by exact term (a finer tokenizer split would only widen a mark).

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

/** Copy a string into wasm memory; the view is built after the alloc, which can
 *  grow `memory` and detach earlier views. */
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

/** Ids one term matches. The trailing space stops `buildMatch` adding a prefix `*`. */
function hitsFor(term: string): number[] {
  const buf = put(`${term} `);
  const total = core.idx_query(buf[0], buf[1], 32);
  const hits: number[] = [];
  if (total >= 0) for (let i = 0; i < Math.min(total, 32); i++) hits.push(core.idx_hit(i));
  drop(buf);
  if (total < 0) throw new Error(`idx_query(${JSON.stringify(term)}) failed: ${errorText()}`);
  return hits;
}

/** The split via `countMarks`, so a `countMarks` with its own split shows up here. */
function docSearchWords(text: string): string[] {
  return countMarks(text, { exact: new Set<string>(), prefix: "" }).terms;
}

/** Fixture copy of the server's PUA filter (`pdf_text.zig` `stripPrivateUse`). */
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

const FIXTURES: ReadonlyArray<{ id: number; what: string; text: string }> = [
  { id: 1, what: "plain ASCII", text: "the quick brown fox" },
  { id: 2, what: "Latin accents", text: "reunião de avaliação" },
  { id: 3, what: "case", text: "MAIÚSCULAS Uppercase TITLE" },
  { id: 4, what: "hyphenated compounds", text: "page-range hyphen-compound" },
  { id: 5, what: "punctuation runs", text: "spaced -- out ... punctuation!! (runs)" },
  { id: 6, what: "digits with letters", text: "A4 2022 x86 h2o" },
  // `_` is Pc: TS splits on it, and so does `unicode61` (pinned below).
  { id: 7, what: "underscores", text: "unicode61 snake_case_word _leading trailing_" },
  // Non-Latin combining marks survive `fold` and split on both sides alike.
  { id: 8, what: "Arabic harakat", text: "كِتَاب مُحَمَّد" },
  { id: 9, what: "Devanagari matras", text: "हिन्दी नमस्ते" },
  // `unicode61` keeps PUA codepoints as token characters; the server strips them
  // before indexing, so this is the server-processed string.
  { id: 10, what: "PUA, as the server indexes it", text: PUA_STRIPPED },
  // Decomposed input: fold must run before split, since `unicode61` removes combining
  // marks rather than breaking at them.
  { id: 11, what: "decomposed accent", text: "a\u0301b sep\u0301arate" },
];

beforeAll(async () => {
  if (!existsSync(wasmPath)) throw new Error(`missing ${wasmPath} — run \`npm run build:wasm\``);
  // Instantiated as `indexEngine.ts` does: no imports, then `_initialize`.
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

      // Case is invisible to the round trip (the query is folded too), so pin it here.
      expect(
        wordTerms(f.text.toUpperCase()),
        "the index folds case away; the TS split must fold the same case away",
      ).toEqual(terms);

      // The control, against a query function that would answer "found" to anything.
      expect(hitsFor(ABSENT), "the control term must not match").not.toContain(f.id);
    });
  }

  // A tripwire: fails if `countMarks` ever grows its own split again.
  it("`search/fold`'s `words` and `docSearch`'s own split agree", () => {
    for (const f of [...FIXTURES, { id: 99, what: "raw PUA", text: PUA_RAW }]) {
      expect(new Set(docSearchWords(f.text)), f.what).toEqual(new Set(wordTerms(f.text)));
    }
  });

  it("an accented query and its unaccented fold reach the same document", () => {
    expect(fold("reunião")).toBe("reuniao");
    expect(hitsFor("reuniao")).toContain(2);
    expect(hitsFor("reunião")).toContain(2);
    expect(hitsFor("REUNIAO")).toContain(2);
  });

  // Fails if `unicode61` ever keeps `_` as a token character (`tokenchars=_`).
  it("`unicode61` splits on `_`, which is what the TS regex assumes", () => {
    expect(hitsFor("snake")).toContain(7);
    expect(hitsFor("case")).toContain(7);
    expect(hitsFor("word")).toContain(7);
    expect(hitsFor("snake_case_word")).toContain(7);
  });

  // On the raw string the two disagree: `page\u{E906}break` is one index term, two TS
  // words. If this starts failing, the server's PUA filter may no longer be needed.
  it("PUA is a token CHARACTER to `unicode61`: the raw string genuinely disagrees", () => {
    expect(wordTerms(PUA_RAW)).toEqual(["page", "break"]);
    expect(hitsFor("pagebreak")).not.toContain(99);
    expect(hitsFor("page"), "TS says `page`; the raw document has no such term").not.toContain(99);
    expect(hitsFor("break"), "TS says `break`; the raw document has no such term").not.toContain(99);
    expect(hitsFor(PUA_RAW)).toContain(99);
    expect(hitsFor("page")).toContain(10);
    expect(hitsFor("break")).toContain(10);
  });
});
