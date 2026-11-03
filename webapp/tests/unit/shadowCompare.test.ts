import { describe, expect, it, beforeAll } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { inflateRawSync } from "node:zlib";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SearchIndex,
  type CoreLoader,
  type SearchCoreExports,
  type TermsDocument,
} from "../../src/search/indexEngine";

// The browser engine against a frozen capture of the server's answers:
//   sqlite3 server/8089/minicloud.db ".backup /tmp/shadow.db"
//   python3 tools/shadow-capture.py /tmp/shadow.db /tmp/golden.json 4000
//   cd webapp && SHADOW_TERMS=../server/8089/data/terms SHADOW_SERVER=/tmp/golden.json \
//     npx vitest run tests/unit/shadowCompare.test.ts
// Skipped unless pointed at real data.

const termsDir = process.env.SHADOW_TERMS;
// Committed (gzipped): the only record of what the server answered.
const defaultGolden = fileURLToPath(new URL("../../../tools/testdata/shadow-golden.json.gz", import.meta.url));
const goldenPath = process.env.SHADOW_SERVER ?? defaultGolden;
const enabled = Boolean(termsDir && goldenPath && existsSync(termsDir) && existsSync(goldenPath));

/** One mode's frozen answer: always a count and a digest, plus the pages when
 * the result was small enough that reading them directly is worth the bytes. */
type ModeAnswer = { n?: number; digest?: string; pages?: [string, number][]; error?: string };
type Golden = { seed: number; queries: Record<string, { exact: ModeAnswer; prefix: ModeAnswer }> };

/** Must match `shadow-capture.py`'s `digest()`: sha256 over sorted `md5#page\n`
 *  lines, 32 hex chars. Synchronous: `crypto.subtle` was too slow here. */
function digestOf(keys: readonly string[]): string {
  const h = createHash("sha256");
  for (const k of keys) h.update(`${k}\n`);
  return h.digest("hex").slice(0, 32);
}

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
    docs.push({ md5, pages: lines.slice(1).map((l) => JSON.parse(l) as { p: number; t: string }) });
  }
  return docs;
}

let bytes: Uint8Array;
const loadCore: CoreLoader = async () => {
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const core = instance.exports as unknown as SearchCoreExports;
  core._initialize?.();
  return core;
};

describe.skipIf(!enabled)("the browser answers what the server answered", () => {
  let index: SearchIndex;
  let golden: Golden;

  beforeAll(async () => {
    bytes = readFileSync(new URL("../../public/sqlite-core.wasm", import.meta.url));
    golden = JSON.parse(
      goldenPath!.endsWith(".gz")
        ? gunzipSync(readFileSync(goldenPath!)).toString("utf8")
        : readFileSync(goldenPath!, "utf8"),
    );
    const docs = loadCorpus(termsDir!);
    index = await SearchIndex.open(loadCore);
    index.build(docs);
    // eslint-disable-next-line no-console
    console.log(`  corpus ${docs.length} documents / ${index.pageCount} pages, golden ${Object.keys(golden.queries).length} queries`);
  }, 120_000);

  // Two modes: `buildMatch` appends `*` unless the query ends in whitespace.
  for (const mode of ["exact", "prefix"] as const) {
    it(`matches the frozen server answers in ${mode} mode`, () => {
      const disagreements: string[] = [];
      let checked = 0;

      for (const [query, answer] of Object.entries(golden.queries)) {
        const want = answer[mode];
        const asked = mode === "exact" ? `${query} ` : query;

        if (want.error !== undefined) {
          // Unparseable on the server; ours must answer rather than throw.
          expect(() => index.query(asked, 1), `${JSON.stringify(query)} threw`).not.toThrow();
          continue;
        }
        checked += 1;
        // Pages sort as numbers, as `shadow-capture.py` does, not as `md5#page` strings.
        const hits = index
          .query(asked, 1_000_000)
          .hits.slice()
          .sort((a, b) => (a.md5 < b.md5 ? -1 : a.md5 > b.md5 ? 1 : a.page - b.page))
          .map((h) => `${h.md5}#${h.page}`);

        if (hits.length !== want.n) {
          disagreements.push(`${JSON.stringify(query)}: server ${want.n} pages, client ${hits.length}`);
          continue;
        }
        if (want.pages) {
          const have = new Set(hits);
          const missing = want.pages.map(([m, p]) => `${m}#${p}`).filter((k) => !have.has(k));
          if (missing.length) {
            disagreements.push(`${JSON.stringify(query)}: ${missing.length} wrong page(s), e.g. ${missing[0]}`);
          }
        } else if (digestOf(hits) !== want.digest) {
          disagreements.push(`${JSON.stringify(query)}: ${hits.length} pages but a DIFFERENT SET`);
        }
      }

      // eslint-disable-next-line no-console
      console.log(`  ${mode}: ${checked} queries compared, ${disagreements.length} disagreed`);
      const shown = disagreements.slice(0, 20);
      expect(shown, `\n  ${shown.join("\n  ")}\n`).toEqual([]);
    }, 300_000);
  }
});
