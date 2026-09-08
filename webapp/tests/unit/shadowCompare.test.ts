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

// ---------------------------------------------------------------------------
// THE SHADOW, run against a FROZEN capture of the server's answers.
//
// the search removal step 4 puts both engines behind the real search box and
// counts disagreements on queries a person types. This replaces that, and the
// reason is not impatience: step 6 DELETES the server implementation, so the
// window in which the two can be compared at all is finite, and a control that
// depends on somebody noticing a counter during it is not a control.
//
// So the server's answers are captured now, exhaustively, by
// `tools/shadow-capture.py` — thousands of queries GENERATED FROM THE CORPUS
// rather than imagined by an author — and this checks the browser against them
// forever, including long after there is no server left to ask.
//
//   sqlite3 server/8089/minicloud.db ".backup /tmp/shadow.db"
//   python3 tools/shadow-capture.py /tmp/shadow.db /tmp/golden.json 4000
//   cd webapp && SHADOW_TERMS=../server/8089/data/terms SHADOW_SERVER=/tmp/golden.json \
//     npx vitest run tests/unit/shadowCompare.test.ts
//
// Skipped unless pointed at real data, so the normal suite pays nothing.
//
// The capture reads `segment_fts` — the index the shipped path really uses, not
// a reimplementation. This half reads the derived files off disk and builds
// through the REAL engine, rowid mapping included, because that mapping is
// exactly where an addressing bug would hide.
// ---------------------------------------------------------------------------

const termsDir = process.env.SHADOW_TERMS;
// The capture is COMMITTED, and that is the point of it: step 6 deletes the
// server, and after that this file is the only record of what it answered. It
// is 1.8 MB of JSON, 0.2 MB gzipped, so it is stored compressed.
const defaultGolden = fileURLToPath(new URL("../../../tools/testdata/shadow-golden.json.gz", import.meta.url));
const goldenPath = process.env.SHADOW_SERVER ?? defaultGolden;
const enabled = Boolean(termsDir && goldenPath && existsSync(termsDir) && existsSync(goldenPath));

/** One mode's frozen answer: always a count and a digest, plus the pages when
 * the result was small enough that reading them directly is worth the bytes. */
type ModeAnswer = { n?: number; digest?: string; pages?: [string, number][]; error?: string };
type Golden = { seed: number; queries: Record<string, { exact: ModeAnswer; prefix: ModeAnswer }> };

/** Must stay identical to `shadow-capture.py`'s `digest()`: sha256 over
 * `md5#page\n` lines in sorted order, truncated to 32 hex characters.
 * Synchronous on purpose — this runs once per query over thousands of them, and
 * `crypto.subtle` made the comparison an async bottleneck that timed out. */
function digestOf(keys: readonly string[]): string {
  const h = createHash("sha256");
  for (const k of keys) h.update(`${k}\n`);
  return h.digest("hex").slice(0, 32);
}

/** `[12-byte header][raw deflate fragment]`. The fragment carries no final block
 * — every one is written with flush() so they concatenate — so reading one back
 * means appending what the serve path appends after the last. */
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

  // TWO MODES, because the client asks two questions: `buildMatch` appends `*`
  // to the LAST term unless the query ends in whitespace. Asking only one is how
  // the first version of this harness produced nine disagreements of its own
  // making, the largest 3,549 pages.
  for (const mode of ["exact", "prefix"] as const) {
    it(`matches the frozen server answers in ${mode} mode`, () => {
      const disagreements: string[] = [];
      let checked = 0;

      for (const [query, answer] of Object.entries(golden.queries)) {
        const want = answer[mode];
        // A trailing space suppresses the prefix star; its absence requests one.
        const asked = mode === "exact" ? `${query} ` : query;

        if (want.error !== undefined) {
          // The server could not parse it. Ours must ANSWER rather than throw —
          // §2.2: a token folding to no terms is not an error.
          expect(() => index.query(asked, 1), `${JSON.stringify(query)} threw`).not.toThrow();
          continue;
        }
        checked += 1;
        // ONE canonical order on both sides, and it is not the obvious one.
        // `shadow-capture.py` sorts `[md5, page]` pairs, so pages compare as
        // NUMBERS; sorting the composed `md5#page` strings instead puts page 10
        // before page 9 and the digests disagree on ordering alone. That looked
        // exactly like a real defect — same count, different set — on every
        // query too big to keep full pages for.
        const hits = index
          .query(asked, 1_000_000)
          .hits.slice()
          .sort((a, b) => (a.md5 < b.md5 ? -1 : a.md5 > b.md5 ? 1 : a.page - b.page))
          .map((h) => `${h.md5}#${h.page}`);

        if (hits.length !== want.n) {
          disagreements.push(`${JSON.stringify(query)}: server ${want.n} pages, client ${hits.length}`);
          continue;
        }
        // Full pages where the capture kept them, digest otherwise. The digest is
        // what catches a set of the right SIZE but the wrong CONTENT — which is
        // precisely what a rowid mapped to the wrong page looks like.
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
