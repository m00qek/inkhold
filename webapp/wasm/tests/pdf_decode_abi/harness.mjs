// Loads pdf-decode.wasm under real WASI, with a scriptable host reader, and the check helpers.

import { WASI } from "node:wasi";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

/** The host reader's script: `fixture` is what it serves; the rest bend it. */
export const host = { fixture: null, fails: false, zeroFrom: Infinity, reads: [] };

/** How many checks have failed so far, across every module. */
export function failureCount() {
  return failures;
}


export const [, , wasmPath, pdfPath] = process.argv;
if (!wasmPath || !pdfPath) {
  console.error("usage: node pdf_decode_abi.mjs <pdf-decode.wasm> <fixture.pdf>");
  process.exit(2);
}

/** A committed host.fixture, read relative to this file (the harness passes one). */
export function fixturePath(name) {
  return fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
}

let failures = 0;
export function check(ok, what, detail) {
  if (ok) return;
  failures += 1;
  console.error(`FAIL: ${what}${detail === undefined ? "" : ` (${detail})`}`);
}
export function equal(actual, expected, what) {
  check(actual === expected, what, `expected ${expected}, got ${actual}`);
}

// Real WASI, so an accidental filesystem call is a wrong answer, not swallowed.
const wasi = new WASI({ version: "preview1", args: [], env: {} });
const mod = await WebAssembly.compile(fs.readFileSync(wasmPath));

// `ink.host_read` must be supplied even here (an omitted import is a link
// error). It answers synchronously, like a block-cache hit in the browser, which
// exercises the stream's `next`/`seek` bookkeeping without JSPI.
host.fixture = fs.readFileSync(pdfPath);
export const savedFixture = host.fixture;
const imports = {
  ...wasi.getImportObject(),
  ink: {
    host_read(off, dst, len) {
      const at = Number(off);
      host.reads.push([at, len]);
      if (host.fails) return -1;
      if (at >= host.zeroFrom) return 0;
      const n = Math.max(0, Math.min(len, host.fixture.length - at));
      if (n > 0) new Uint8Array(e.memory.buffer, dst, n).set(host.fixture.subarray(at, at + n));
      return n;
    },
  },
};
const instance = await WebAssembly.instantiate(mod, imports);
wasi.initialize(instance);
export const e = instance.exports;

for (const name of [
  "ink_alloc",
  "ink_free",
  "ink_open",
  "ink_open_stream",
  "ink_page_count",
  "ink_page_size",
  "ink_page_links",
  "ink_links_free",
  "ink_page_words",
  "ink_words_free",
  "ink_load_outline",
  "ink_outline_free",
  "ink_render",
  "ink_render_width",
  "ink_render_height",
  "ink_close",
  "ink_export_page",
  "ink_annotate_page",
  "ink_export_incremental",
  "ink_export_free",
  "memory",
]) {
  check(e[name] !== undefined, `export \`${name}\` is present`);
}
if (failures > 0) process.exit(1);

export const pdf = fs.readFileSync(pdfPath);
