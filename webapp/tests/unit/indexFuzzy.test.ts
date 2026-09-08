import { describe, expect, it, beforeAll } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SearchIndex, type CoreLoader, type SearchCoreExports, type TermsDocument } from "../../src/search/indexEngine";
import { createIndexSearch } from "../../src/search/indexSearch";
import type { IndexSync, SyncOutcome } from "../../src/search/indexSync";
import type { DocumentManifest, ManifestRow } from "../../src/search/manifestCodec";
import type { StoredTermsDocument, TermsStore } from "../../src/cache/termsStore";

// ---------------------------------------------------------------------------
// THE TYPO LADDER, in the browser, on the four cases that MEASURED the hole.
//
// Step 5 switched global search onto the local index, and the index had prefix
// expansion and nothing else. Against the real library, with the server's ladder
// still answering beside it:
//
//     valjean  (exact)            887 pages      quijote  (exact)   1806 pages
//     valjaen  (transposed)         0            quijotte (doubled)    0
//     valjen   (dropped letter)     0            cosete   (dropped)    0
//
// The server corrected every one of them and §6 step 6 deletes the server, so
// unless the correction exists here first the capability is gone permanently.
// the sweep says where it goes: the ladder "moves to the browser".
//
// The four cases are asserted against the REAL corpus when one is at hand and a
// synthetic stand-in otherwise, because the questions are the same either way —
// what differs is only how much vocabulary the ladder had to reject to find the
// answer. Point it at the real one with:
//
//   SHADOW_TERMS=../server/8089/data/terms npx vitest run tests/unit/indexFuzzy.test.ts
//
// THE INVARIANT THE ASSERTIONS USE, rather than a page count that would rot with
// the library: a corrected search must answer EXACTLY what searching the correct
// spelling answers. The expansion is `("valjaen" OR "valjean")` and the typed
// half matches nothing, so anything else means the group is not what it claims.
// Where the ranking genuinely cannot separate two readings it offers both, and
// the answer can only be a superset — `valjen` reaches `valen` as well as
// `valjean`, both one edit and one character away, 894 pages against 887.
//
// Three of the four reach the word they were meant to be. The fourth, `cosete`,
// reaches a DIFFERENT one on the real library, and that is the ranking working;
// it has a test of its own that says why.
// ---------------------------------------------------------------------------

const wasmPath = fileURLToPath(new URL("../../public/sqlite-core.wasm", import.meta.url));
let bytes: Uint8Array;
const loadCore: CoreLoader = async () => {
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const core = instance.exports as unknown as SearchCoreExports;
  core._initialize?.();
  return core;
};

/** `[12-byte header][raw deflate fragment]`, as `shadowCompare.test.ts` reads
 *  them: every fragment is written with flush() and carries no final block, so
 *  reading one back means appending what the serve path appends after the last. */
function readStored(path: string): string {
  const raw = readFileSync(path);
  if (raw.subarray(0, 4).toString("latin1") !== "IDF1") throw new Error(`not a fragment: ${path}`);
  return inflateRawSync(Buffer.concat([raw.subarray(12), Buffer.from([0x03, 0x00])])).toString("utf8");
}

function loadCorpus(dir: string): TermsDocument[] {
  const docs: TermsDocument[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "tmp" || !name.includes(".")) continue;
    const [md5] = name.split(".");
    const lines = readStored(join(dir, name)).split("\n").filter(Boolean);
    docs.push({ md5: md5!, pages: lines.slice(1).map((l) => JSON.parse(l) as { p: number; t: string }) });
  }
  return docs;
}

/**
 * The stand-in when there is no derived store to read: two documents holding the
 * three words the four cases are about. Terms are UNACCENTED because that is
 * what a terms record contains — the server's `remove_diacritics 2` already ran
 * over them (§2.2) — and the ladder measures its distance on the same footing.
 */
const SYNTHETIC: TermsDocument[] = [
  {
    md5: "1".repeat(32),
    pages: [
      { p: 0, t: "jean valjean saiu da prisao" },
      { p: 1, t: "valjean e cosette em paris" },
      { p: 4, t: "o bispo myriel e os casticais" },
    ],
  },
  {
    md5: "2".repeat(32),
    pages: [
      { p: 0, t: "dom quijote de la mancha" },
      { p: 3, t: "sancho panca segue o quijote" },
    ],
  },
];

const termsDir = process.env.SHADOW_TERMS;
const real = Boolean(termsDir && existsSync(termsDir));

/**
 * Three of the four cases, as `[typed, meant]` — the fourth is below, because
 * the real corpus answers it differently and correctly.
 */
const TYPOS: readonly [string, string][] = [
  ["valjaen", "valjean"], // two letters swapped — one edit only because of Damerau
  ["valjen", "valjean"], // a letter dropped
  ["quijotte", "quijote"], // a letter doubled
];

describe("the typo ladder answers in the browser", () => {
  let index: SearchIndex;

  beforeAll(async () => {
    if (!existsSync(wasmPath)) throw new Error(`missing ${wasmPath} — run \`npm run build:wasm\``);
    bytes = readFileSync(wasmPath);
    index = await SearchIndex.open(loadCore);
    index.build(real ? loadCorpus(termsDir!) : SYNTHETIC);
    // eslint-disable-next-line no-console
    console.log(
      `  ${real ? "REAL" : "synthetic"} corpus: ${index.documentCount} documents / ${index.pageCount} pages`,
    );
  }, 120_000);

  for (const [typed, meant] of TYPOS) {
    it(`corrects ${typed} to ${meant}`, () => {
      // The word spelt correctly is the answer the correction has to reproduce.
      const correct = index.query(`${meant} `, 1_000_000);
      expect(correct.total, `the corpus has no ${meant} to find`).toBeGreaterThan(0);
      expect(correct.expansions, "a query that matches substitutes nothing").toEqual([]);

      // Spelt as typed, it is exactly the zero the measurement recorded...
      expect(index.query(`${typed} `, 1_000_000).total).toBe(0);

      // ...until the ladder is asked, and then it is the corrected answer.
      const fixed = index.query(`${typed} `, 1_000_000, true);
      expect(fixed.expansions).toContainEqual({ typed, matched: meant });
      // The group is ("typed" OR the alts) and the typed half matches nothing,
      // so ONE correction must answer exactly what the correct spelling answers.
      // More than one means the ranking genuinely could not separate two
      // readings — "cala" really is equally close to casa, cara and cama — and
      // then the answer can only be a superset.
      if (fixed.expansions.length === 1) expect(fixed.total).toBe(correct.total);
      else expect(fixed.total).toBeGreaterThanOrEqual(correct.total);
    });
  }

  // THE FOURTH CASE, and it is the one that says most about the ranking.
  //
  // `cosete` is one edit from `cosette` (insert a `t`, delta 1) and, in the real
  // library, ALSO one edit from `comete` and `copete` (substitute a letter,
  // delta 0). Only the best tier is offered, and a substitution that preserves
  // length outranks an insertion that does not — the same rule that makes `tset`
  // prefer `test` over `set`. So the real corpus answers `cosete` with
  // comete/copete (4 pages, MEASURED) and not with `cosette` (759 pages), which
  // is the ladder working rather than failing: `cosete` really is a likelier
  // misspelling of a six-letter word than of a seven-letter one. The server's
  // copy of this ladder would have chosen the same, from the same vocabulary.
  //
  // What is asserted on both corpora is therefore the property, not the word:
  // the typed spelling found nothing, and the fallback found something and said
  // what it searched instead.
  it("corrects cosete to the best reading its vocabulary holds", () => {
    expect(index.query("cosete ", 1_000_000).total).toBe(0);
    const fixed = index.query("cosete ", 1_000_000, true);
    expect(fixed.total).toBeGreaterThan(0);
    expect(fixed.expansions.length).toBeGreaterThan(0);
    expect(fixed.expansions.map((e) => e.typed)).toEqual(fixed.expansions.map(() => "cosete"));
    // Where `cosette` is the only reading one edit away, it is the one offered.
    if (!real) expect(fixed.expansions).toEqual([{ typed: "cosete", matched: "cosette" }]);
  });

  it("expands a word still being typed, against the term truncated to what was typed", () => {
    // Mid-typing the candidate is cut to the length typed so far, or `valjae`
    // would be three edits from `valjean` rather than one and out of reach.
    const fixed = index.query("valjae", 1_000_000, true);
    expect(fixed.expansions).toContainEqual({ typed: "valjae", matched: "valjean" });
    expect(fixed.total).toBeGreaterThan(0);
  });

  it("does not fire when the query as typed matched", () => {
    // The rule, stated the way it can fail: a widened search for a word that
    // already had an answer would add documents the person did not ask about.
    const asked = index.query("valjean ", 1_000_000, true);
    expect(asked.expansions).toEqual([]);
    expect(asked.total).toBe(index.query("valjean ", 1_000_000).total);
  });

  // Skipped against the real corpus, which cannot promise that a three-letter
  // string is absent from 63,000 handwriting-recognised terms — and a token that
  // matched exactly would make the assertion vacuous rather than wrong. The rung
  // is pinned on a controlled vocabulary here and again in `sqlite_core_abi.mjs`.
  it.skipIf(real)("leaves a three-character token alone, however near the vocabulary is", () => {
    // The rungs are 0 / 1 / 2 and the first is the interesting one: at three
    // characters a single edit is a different word, not a typo.
    expect(index.query("jean ", 1_000_000).total, "`jean` is one edit away").toBeGreaterThan(0);
    const r = index.query("jea ", 1_000_000, true);
    expect(r.total).toBe(0);
    expect(r.expansions).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// ...and the same thing seen from the search box, where what matters is that
// BOTH HALVES of the substitution survive the trip: §4.3 renders "matched
// **reunião**", which needs the term, beside what was typed, which needs the
// token. A result that carried only one of them could not be rendered at all.
// ---------------------------------------------------------------------------

const STORED: StoredTermsDocument[] = SYNTHETIC.map((doc, i) => ({
  md5: doc.md5,
  indexVersion: 3,
  pageCount: 12,
  pages: [...doc.pages],
  storedAt: i + 1,
}));

function manifestRow(md5: string, fileId: number): ManifestRow {
  return { md5, fileId, tier: "note", updatedAt: 1000 * fileId, indexVersion: 3, derivation: "derived" };
}

/** An `IndexSync` with no transport behind it — the rows are already "stored". */
function fakeSync(rows: readonly ManifestRow[]): IndexSync {
  const manifest: DocumentManifest = { coverage: { notes: rows.length, unsearchable: 0 }, rows };
  return {
    store: { available: true } as TermsStore,
    async documents() {
      return STORED;
    },
    async sync(): Promise<SyncOutcome> {
      return {
        manifest,
        etag: "etag-1",
        requested: STORED.length,
        received: STORED.length,
        skipped: 0,
        dropped: 0,
        persisted: true,
      };
    },
  };
}

describe("createIndexSearch", () => {
  beforeAll(() => {
    if (!existsSync(wasmPath)) throw new Error(`missing ${wasmPath} — run \`npm run build:wasm\``);
    bytes = readFileSync(wasmPath);
  });

  it("reports what it substituted, both halves, on the real engine", async () => {
    const rows = [manifestRow(SYNTHETIC[0]!.md5, 10), manifestRow(SYNTHETIC[1]!.md5, 20)];
    const local = createIndexSearch({ sync: fakeSync(rows), load: loadCore });
    await local.sync();

    const results = await local.search("cosete");
    expect(results.expansions).toEqual([{ typed: "cosete", matched: "cosette" }]);
    expect(results.documents.map((d) => d.fileId)).toEqual([10]);

    // And a query that answered leaves it empty, so a view rendering it says
    // nothing rather than something false.
    expect((await local.search("valjean")).expansions).toEqual([]);
  });

  it("drops the substitution when the manifest dropped every row it found", async () => {
    // §2.7: the index is a SUPERSET and the manifest decides. A correction whose
    // only pages belong to a document nobody names would otherwise print
    // "matched cosette" over an empty result — the same contradiction between
    // the engine's count and the screen that `totalPages` is summed to avoid.
    const local = createIndexSearch({ sync: fakeSync([manifestRow(SYNTHETIC[1]!.md5, 20)]), load: loadCore });
    await local.sync();

    const results = await local.search("cosete");
    expect(results.documents).toEqual([]);
    expect(results.expansions).toEqual([]);
  });
});
