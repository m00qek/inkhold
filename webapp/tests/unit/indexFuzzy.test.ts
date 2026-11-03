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

// The typo ladder on the real terms store when available, else a synthetic one:
//   SHADOW_TERMS=../server/8089/data/terms npx vitest run tests/unit/indexFuzzy.test.ts
// A corrected search must answer exactly what the correct spelling answers (or a
// superset, where the ranking cannot separate two readings).

const wasmPath = fileURLToPath(new URL("../../public/sqlite-core.wasm", import.meta.url));
let bytes: Uint8Array;
const loadCore: CoreLoader = async () => {
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const core = instance.exports as unknown as SearchCoreExports;
  core._initialize?.();
  return core;
};

/** `[12-byte header][raw deflate fragment]`; each fragment lacks a final block. */
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

/** Stand-in corpus; terms unaccented, as the server's `remove_diacritics 2` left them. */
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

/** Three of the four cases as `[typed, meant]`; `cosete` is tested separately. */
const TYPOS: readonly [string, string][] = [
  ["valjaen", "valjean"],  // one edit only because of Damerau
  ["valjen", "valjean"],
  ["quijotte", "quijote"],
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
      const correct = index.query(`${meant} `, 1_000_000);
      expect(correct.total, `the corpus has no ${meant} to find`).toBeGreaterThan(0);
      expect(correct.expansions, "a query that matches substitutes nothing").toEqual([]);

      expect(index.query(`${typed} `, 1_000_000).total).toBe(0);

      const fixed = index.query(`${typed} `, 1_000_000, true);
      expect(fixed.expansions).toContainEqual({ typed, matched: meant });
      if (fixed.expansions.length === 1) expect(fixed.total).toBe(correct.total);
      else expect(fixed.total).toBeGreaterThanOrEqual(correct.total);
    });
  }

  // On the real library `cosete` reaches comete/copete (substitution, same length)
  // before `cosette` (insertion): only the best tier is offered. Assert the property.
  it("corrects cosete to the best reading its vocabulary holds", () => {
    expect(index.query("cosete ", 1_000_000).total).toBe(0);
    const fixed = index.query("cosete ", 1_000_000, true);
    expect(fixed.total).toBeGreaterThan(0);
    expect(fixed.expansions.length).toBeGreaterThan(0);
    expect(fixed.expansions.map((e) => e.typed)).toEqual(fixed.expansions.map(() => "cosete"));
    if (!real) expect(fixed.expansions).toEqual([{ typed: "cosete", matched: "cosette" }]);
  });

  it("expands a word still being typed, against the term truncated to what was typed", () => {
    // Mid-typing the candidate is cut to the typed length, or `valjae` is three edits away.
    const fixed = index.query("valjae", 1_000_000, true);
    expect(fixed.expansions).toContainEqual({ typed: "valjae", matched: "valjean" });
    expect(fixed.total).toBeGreaterThan(0);
  });

  it("does not fire when the query as typed matched", () => {
    const asked = index.query("valjean ", 1_000_000, true);
    expect(asked.expansions).toEqual([]);
    expect(asked.total).toBe(index.query("valjean ", 1_000_000).total);
  });

  // Skipped on the real corpus, which cannot promise a three-letter string is absent.
  it.skipIf(real)("leaves a three-character token alone, however near the vocabulary is", () => {
    // At three characters a single edit is a different word, not a typo.
    expect(index.query("jean ", 1_000_000).total, "`jean` is one edit away").toBeGreaterThan(0);
    const r = index.query("jea ", 1_000_000, true);
    expect(r.total).toBe(0);
    expect(r.expansions).toEqual([]);
  });
});

// --- from the search box: both the term and the typed token must survive ---------

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

    expect((await local.search("valjean")).expansions).toEqual([]);
  });

  it("drops the substitution when the manifest dropped every row it found", async () => {
    // The index is a superset; a correction naming no listed document prints nothing.
    const local = createIndexSearch({ sync: fakeSync([manifestRow(SYNTHETIC[1]!.md5, 20)]), load: loadCore });
    await local.sync();

    const results = await local.search("cosete");
    expect(results.documents).toEqual([]);
    expect(results.expansions).toEqual([]);
  });
});
