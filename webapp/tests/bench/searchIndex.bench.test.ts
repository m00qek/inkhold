// How the library search's index behaves as a library grows: the real
// `sqlite-core.wasm`, fed generated libraries shaped like the hub's on
// 2026-11-05 (45 documents, 231 pages with text, 54 distinct words a page,
// 3,559 distinct words), at 1x, 10x and 100x. Prints a table; asserts nothing.
//
// What is timed is what the browser does after a sync brings anything new:
// a whole rebuild (`SearchIndex.rebuild`), then queries. Reading the rows back
// out of IndexedDB is not included.

import { it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SearchIndex, type CoreLoader, type SearchCoreExports, type TermsDocument } from "../../src/search/indexEngine";

const HUB = { docs: 45, pagesPerDoc: 231 / 45, wordsPerPage: 54, vocabulary: 3559 };

const bytes = readFileSync(fileURLToPath(new URL("../../public/sqlite-core.wasm", import.meta.url)));
let core: SearchCoreExports | null = null;
const load: CoreLoader = async () => {
  const { instance } = await WebAssembly.instantiate(bytes, {});
  core = instance.exports as unknown as SearchCoreExports;
  core._initialize?.();
  return core;
};

/** A seeded generator, so every run measures the same library. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SYL = ["ca", "de", "pro", "re", "ta", "lo", "ma", "sen", "vi", "ção", "ni", "or", "ga", "bu", "fe", "ri", "mo", "es", "tu", "lin"];

/** Words that look like the corpus: folded, Portuguese-ish, 2 to 4 syllables. */
function vocabulary(n: number, r: () => number): string[] {
  const out = new Set<string>();
  while (out.size < n) {
    let w = "";
    const k = 2 + Math.floor(r() * 3);
    for (let i = 0; i < k; i++) w += SYL[Math.floor(r() * SYL.length)];
    out.add(w.normalize("NFD").replace(/[̀-ͯ]/g, "") + (out.size % 7 === 0 ? String(out.size % 100) : ""));
  }
  return [...out];
}

/** A library `scale` times the hub's; vocabulary grows by Heaps' law (n^0.6). */
function library(scale: number): { docs: TermsDocument[]; vocab: string[] } {
  const r = rng(scale);
  const vocab = vocabulary(Math.round(HUB.vocabulary * Math.pow(scale, 0.6)), r);
  // Zipf-ish: common words much likelier than rare ones.
  const pick = () => vocab[Math.floor(Math.pow(r(), 2.2) * vocab.length)]!;
  const docs: TermsDocument[] = [];
  const n = HUB.docs * scale;
  for (let d = 0; d < n; d++) {
    const pages = Math.max(1, Math.round(HUB.pagesPerDoc * (0.3 + r() * 1.4)));
    docs.push({
      md5: d.toString(16).padStart(32, "0"),
      pages: Array.from({ length: pages }, (_, p) => {
        const set = new Set<string>();
        while (set.size < HUB.wordsPerPage) set.add(pick());
        return { p, t: [...set].sort().join(" ") };
      }),
    });
  }
  return { docs, vocab };
}

function median(xs: number[]): number {
  const s = xs.slice().sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

function time(f: () => void, runs: number): number {
  const xs: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    f();
    xs.push(performance.now() - t);
  }
  return median(xs);
}

it("search index at 1x, 10x and 100x the hub's library", async () => {
  const rows: string[] = [];
  for (const scale of [1, 10, 100]) {
    const { docs, vocab } = library(scale);
    const pages = docs.reduce((n, d) => n + d.pages.length, 0);
    const idx = await SearchIndex.open(load);
    const build = time(() => idx.rebuild(docs), scale === 100 ? 3 : 5);
    const mem = core!.memory.buffer.byteLength / 2 ** 20;
    const common = vocab[3]!;
    const rare = vocab[vocab.length - 5]!;
    const one = time(() => idx.query(common, 0xffffffff, true), 20);
    const two = time(() => idx.query(`${common} ${vocab[10]}`, 0xffffffff, true), 20);
    const prefix = time(() => idx.query(rare.slice(0, 3), 0xffffffff, true), 20);
    // Nothing matches exactly, so the typo ladder scans the vocabulary.
    const typo = time(() => idx.query(rare.slice(0, -1) + "q", 0xffffffff, true), 5);
    idx.close();
    rows.push(
      `${String(scale).padStart(4)}x | ${String(docs.length).padStart(5)} docs | ${String(pages).padStart(6)} pages | ` +
        `rebuild ${build.toFixed(0).padStart(5)} ms | memory ${mem.toFixed(0).padStart(4)} MB | ` +
        `1 word ${one.toFixed(1)} ms | 2 words ${two.toFixed(1)} ms | prefix ${prefix.toFixed(1)} ms | typo ${typo.toFixed(0)} ms`,
    );
  }
  console.log("\n" + rows.join("\n"));
});
