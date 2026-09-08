// Client residency + build latency for `sqlite-core.wasm` — the measurement
// `golden-search.md` §7 asked for before step 7, recorded in its §8.1.
//
// NOT a test and NOT wired into `build.zig`: it needs a corpus, and the corpus
// is a dev database rather than a fixture. It lives next to `sqlite_core_abi.mjs`
// because it drives the SAME shipped artifact through the SAME `idx_*` ABI, and
// because §7 still has follow-on numbers to take (build time from a real stream,
// what 1,755 `.note` pages do to row count) that want this harness rather than a
// new one.
//
// **Why Node is legitimate here**, given that §3.1 found Node lies about the
// transport: linear-memory growth is a wasm-spec property of the module's own
// allocator plus SQLite's heap, and V8 is the engine Chromium ships. There is no
// browser-side behaviour to miss. `Content-Encoding` was a networking-stack
// property, which is exactly why Node was the wrong place to check it.
//
// Input is NDJSON, one page per line: {"p": <ordinal>, "t": "<text>"}. Extract it
// from `note_page_index` (`page_index`, `text`) for whichever blob you care about;
// for the global-index shape, one line per page of the whole library whose `t` is
// that page's deduplicated folded terms.
//
// Usage:
//   node residency_bench.mjs doc       <wasm> <doc.ndjson>...       # one doc at a time, fresh instance each
//   node residency_bench.mjs reuse     <wasm> <doc.ndjson>...       # all through ONE instance (does it stack?)
//   node residency_bench.mjs lifecycle <wasm> <global.ndjson> <doc.ndjson>

import { WASI } from "node:wasi";
import fs from "node:fs";

const [, , mode, wasmPath, ...rest] = process.argv;
const MODES = ["doc", "reuse", "lifecycle"];
if (!MODES.includes(mode) || !wasmPath || rest.length === 0) {
  console.error(`usage: node residency_bench.mjs <${MODES.join("|")}> <sqlite-core.wasm> <corpus.ndjson>...`);
  process.exit(2);
}

const mod = await WebAssembly.compile(fs.readFileSync(wasmPath));
const MB = 1024 * 1024;
const mb = (b) => (b / MB).toFixed(2);
const load = (p) => fs.readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const name = (p) => p.split("/").pop().replace(/\.ndjson$/, "");

async function freshInstance() {
  const wasi = new WASI({ version: "preview1", args: [], env: {} });
  const inst = await WebAssembly.instantiate(mod, wasi.getImportObject());
  wasi.initialize(inst);
  return inst.exports;
}

/** The `idx_*` calls, bound to one instance. */
function api(e) {
  // memory.buffer can be replaced by any call that grows it, so every pointer is
  // re-read after the call that produced it — the lifetime rule sqlite_core.zig
  // states in its header.
  const put = (text) => {
    const buf = Buffer.from(text, "utf8");
    const ptr = e.idx_alloc(buf.length + 1);
    if (ptr === 0) throw new Error("idx_alloc returned null");
    new Uint8Array(e.memory.buffer, ptr, buf.length + 1).set(buf, 0);
    return [ptr, buf.length];
  };
  const errorText = () => {
    const n = e.idx_errmsg_len();
    return n === 0 ? "" : Buffer.from(new Uint8Array(e.memory.buffer, e.idx_errmsg_ptr(), n)).toString("utf8");
  };
  const must = (rc, what) => {
    if (rc < 0) throw new Error(`${what}: rc=${rc} ${errorText()}`);
    return rc;
  };
  const build = (pages) => {
    const t0 = performance.now();
    must(e.idx_begin(), "idx_begin");
    for (const p of pages) {
      const [ptr, len] = put(p.t);
      must(e.idx_add(p.p, ptr, len), `idx_add(${p.p})`);
      e.idx_free(ptr, len + 1);
    }
    must(e.idx_commit(), "idx_commit");
    return performance.now() - t0;
  };
  const query = (q, limit = 50) => {
    const [ptr, len] = put(q);
    const t0 = performance.now();
    const total = must(e.idx_query(ptr, len, limit), `idx_query(${q})`);
    const ms = performance.now() - t0;
    e.idx_free(ptr, len + 1);
    return { total, ms };
  };
  /** Serialize and copy the image out, the way the client does before IndexedDB. */
  const snapshot = () => {
    const n = must(e.idx_serialize(), "idx_serialize");
    return Buffer.from(new Uint8Array(e.memory.buffer, e.idx_image_ptr(), n));
  };
  /** Restore from an image; returns end-to-end ms (alloc + copy in + deserialize). */
  const restore = (image) => {
    const t0 = performance.now();
    const dst = e.idx_image_alloc(image.length);
    if (dst === 0) throw new Error("idx_image_alloc returned null");
    new Uint8Array(e.memory.buffer, dst, image.length).set(image);
    must(e.idx_deserialize(dst, image.length), "idx_deserialize");
    return performance.now() - t0;
  };
  const mem = () => e.memory.buffer.byteLength;
  return { put, must, build, query, snapshot, restore, mem };
}

// A short common prefix is the pathological case: the last term of a query gets
// a `*` unless it ends in whitespace, so "con" expands and "que " does not.
const QUERIES = ["misere", "jean valjean", "con", "que ", "zzzznotpresent"];

if (mode === "doc") {
  for (const path of rest) {
    const pages = load(path);
    const utf8 = pages.reduce((n, p) => n + Buffer.byteLength(p.t, "utf8"), 0);
    const e = await freshInstance();
    const a = api(e);
    const atInstantiate = a.mem();
    a.must(e.idx_open(), "idx_open");
    const atOpen = a.mem();
    const buildMs = a.build(pages);
    const atBuild = a.mem();
    const hits = QUERIES.map((q) => ({ q, ...a.query(q) }));
    const image = a.snapshot();
    const atSerialize = a.mem();

    console.log(`\n=== ${name(path)} ===`);
    console.log(`  corpus            ${pages.length} pages, ${mb(utf8)} MB utf8`);
    console.log(`  instantiate       ${mb(atInstantiate)} MB`);
    console.log(`  idx_open          ${mb(atOpen)} MB`);
    console.log(`  after build       ${mb(atBuild)} MB  (+${mb(atBuild - atOpen)} MB, ${((atBuild - atOpen) / utf8).toFixed(2)}x text)`);
    console.log(`  build time        ${buildMs.toFixed(0)} ms  (${(buildMs / pages.length).toFixed(3)} ms/page)`);
    console.log(`  serialize         ${mb(image.length)} MB image, instance ${mb(atSerialize)} MB`);
    console.log(`  HIGH WATER        ${mb(atBuild)} MB without serialize (the in-doc path), ${mb(atSerialize)} MB with`);
    for (const h of hits) {
      console.log(`    ${JSON.stringify(h.q).padEnd(18)} ${String(h.total).padStart(6)} hits  ${h.ms.toFixed(2)} ms`);
    }
    e.idx_close();
  }
} else if (mode === "reuse") {
  // Does one instance STACK across documents? It should not: idx_open() returns
  // the closed database's pages to SQLite's heap inside linear memory, and the
  // next build reuses them. §8.1 — this is what refuted §4.1's teardown rule.
  const e = await freshInstance();
  const a = api(e);
  console.log(`instantiate            ${mb(a.mem())} MB  (module static footprint)`);
  let peak = a.mem();
  for (const path of rest) {
    const pages = load(path);
    a.must(e.idx_open(), "idx_open");
    const before = a.mem();
    const ms = a.build(pages);
    const after = a.mem();
    peak = Math.max(peak, after);
    console.log(
      `open+build ${name(path).padEnd(11)} ${mb(before)} -> ${mb(after)} MB  ` +
        `(${pages.length} pages, ${ms.toFixed(0)} ms)${after === before ? "  [reused, no growth]" : ""}`,
    );
  }
  console.log(`\nHIGH WATER over ${rest.length} documents in ONE instance: ${mb(peak)} MB`);
} else {
  // The real §4.1 lifecycle: global index -> FIND inside a document (which
  // destroys it) -> restore the global index. Reported for both the first visit
  // (build + serialize) and the second (deserialize only), because the second is
  // the steady state and is much the cheaper of the two.
  const [globalPath, docPath] = rest;
  const globalPages = load(globalPath);
  const docPages = load(docPath);

  const first = await freshInstance();
  const fa = api(first);
  console.log(`[first visit] instantiate      ${mb(fa.mem())} MB`);
  fa.must(first.idx_open(), "idx_open");
  const gMs = fa.build(globalPages);
  console.log(`  global build (${globalPages.length} pages) ${gMs.toFixed(0)} ms   ${mb(fa.mem())} MB`);
  for (const q of ["misere", "jean valjean", "con", "natal"]) {
    const r = fa.query(q);
    console.log(`    "${q}" -> ${r.total} pages, ${r.ms.toFixed(2)} ms`);
  }
  const image = fa.snapshot();
  console.log(`  serialize                    ${mb(image.length)} MB image   ${mb(fa.mem())} MB`);
  const afterGlobal = fa.mem();
  fa.must(first.idx_open(), "idx_open"); // the global index is GONE from here
  const dMs = fa.build(docPages);
  console.log(`  in-doc build (${docPages.length} pages)  ${dMs.toFixed(0)} ms   ${mb(fa.mem())} MB`);
  const afterInDoc = fa.mem();
  console.log(`  restore global               ${fa.restore(image).toFixed(2)} ms   ${mb(fa.mem())} MB`);
  console.log(`  FIRST-VISIT HIGH WATER       ${mb(Math.max(afterGlobal, afterInDoc, fa.mem()))} MB`);

  const second = await freshInstance();
  const sa = api(second);
  console.log(`\n[second visit] instantiate     ${mb(sa.mem())} MB   (never builds the global index)`);
  console.log(`  deserialize                  ${sa.restore(image).toFixed(2)} ms   ${mb(sa.mem())} MB`);
  for (const q of ["misere", "jean valjean", "con", "natal"]) {
    const r = sa.query(q);
    console.log(`    "${q}" -> ${r.total} pages, ${r.ms.toFixed(2)} ms`);
  }
  sa.must(second.idx_open(), "idx_open");
  const d2 = sa.build(docPages);
  console.log(`  in-doc build                 ${d2.toFixed(0)} ms   ${mb(sa.mem())} MB`);
  console.log(`  restore global again         ${sa.restore(image).toFixed(2)} ms   ${mb(sa.mem())} MB`);
  console.log(`  SECOND-VISIT HIGH WATER      ${mb(sa.mem())} MB`);
}
