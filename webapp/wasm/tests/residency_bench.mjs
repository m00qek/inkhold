// Client residency and build-latency bench for `sqlite-core.wasm`. Not a test:
// it needs a dev-database corpus. Node is fine here, since memory growth is a
// wasm/V8 property. Input is NDJSON, one page per line: {"p": <ordinal>,
// "t": "<text>"} (from `note_page_index`).
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
  // `memory.buffer` can be replaced by any growing call: re-read pointers.
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
  const snapshot = () => {
    const n = must(e.idx_serialize(), "idx_serialize");
    return Buffer.from(new Uint8Array(e.memory.buffer, e.idx_image_ptr(), n));
  };
  /** Restores an image; returns ms for alloc + copy in + deserialize. */
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

// "con" is the pathological short prefix; "que " has no `*`.
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
  // One instance should not stack across documents: idx_open() returns the
  // closed database's pages to SQLite's heap for reuse.
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
  // Global index -> find inside a document (destroying it) -> restore, for the
  // first visit (build + serialize) and the second (deserialize only).
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
