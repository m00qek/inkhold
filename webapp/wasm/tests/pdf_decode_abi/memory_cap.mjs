// The module's memory ceiling (`pdf_decode_max_memory` in build.zig): declared
// in the binary, reached as MuPDF's ordinary out-of-memory error rather than a
// trap, and survived by starting a fresh instance, as the viewer's worker does.
// Its own instances: the shared one must not be the one that runs out.

import { WASI } from "node:wasi";
import fs from "node:fs";
import { check, equal, wasmPath, pdf } from "./harness.mjs";

const CEILING_PAGES = (1 << 30) / 65536;

/** The memory section's maximum, in pages, read from the binary itself. */
function declaredMaximum(bytes) {
  let at = 8;
  const leb = () => {
    let v = 0, shift = 0, b;
    do { b = bytes[at++]; v += (b & 0x7f) * 2 ** shift; shift += 7; } while (b & 0x80);
    return v;
  };
  while (at < bytes.length) {
    const id = bytes[at++];
    const size = leb();
    const end = at + size;
    if (id === 5) {
      leb(); // memory count
      const flags = leb();
      leb(); // minimum
      return flags & 1 ? leb() : null;
    }
    at = end;
  }
  return null;
}

const wasmBytes = fs.readFileSync(wasmPath);
equal(declaredMaximum(wasmBytes), CEILING_PAGES, "pdf-decode.wasm declares a 1 GiB memory maximum");

const mod = await WebAssembly.compile(wasmBytes);
async function instance(fixture) {
  const wasi = new WASI({ version: "preview1", args: [], env: {} });
  let x;
  const inst = await WebAssembly.instantiate(mod, {
    ...wasi.getImportObject(),
    ink: {
      host_read(off, dst, len) {
        const from = Number(off);
        const n = Math.max(0, Math.min(len, fixture.length - from));
        new Uint8Array(x.memory.buffer, dst, n).set(fixture.subarray(from, from + n));
        return n;
      },
    },
  });
  x = inst.exports;
  wasi.initialize(inst);
  return x;
}
const lastError = (x) => {
  const p = x.ink_error_ptr();
  const bytes = new Uint8Array(x.memory.buffer, p, 256);
  return Buffer.from(bytes.subarray(0, bytes.indexOf(0))).toString();
};

// Squeezed to the ceiling: the next allocation inside MuPDF fails.
const spent = await instance(pdf);
const doc = spent.ink_open_stream(BigInt(pdf.length));
check(doc >= 1, "a document opens before the squeeze", `got ${doc}`);
spent.memory.grow(CEILING_PAGES - spent.memory.buffer.byteLength / 65536);
let result;
try {
  result = spent.ink_render(doc, 0, 4);
} catch (err) {
  check(false, "a render past the ceiling is an error, not a trap", `${err.constructor.name}: ${err.message}`);
}
if (result !== undefined) {
  check(result < 0n, "a render past the ceiling fails", `got ${result}`);
  check(/malloc \(\d+ bytes\) failed/.test(lastError(spent)), "it fails as MuPDF's out-of-memory error", lastError(spent));
}

// A fresh instance, as the viewer starts after that error, opens and renders.
const next = await instance(pdf);
const again = next.ink_open_stream(BigInt(pdf.length));
check(again >= 1, "a fresh instance opens the next document", `got ${again}`);
check(next.ink_render(again, 0, 2) > 0n, "and renders it");

// Every other call that allocates fails the same way, never as a trap: words,
// links and the outline of an open document, and opening one. Squeezed to the
// ceiling and every free block taken, as at the end of a heavy session.
const outlined = fs.readFileSync(new URL("../fixtures/outlined-six-page.pdf", import.meta.url));
function squeeze(x) {
  x.memory.grow(CEILING_PAGES - x.memory.buffer.byteLength / 65536);
  for (const size of [1 << 20, 1 << 16, 1 << 12, 256, 16]) while (x.ink_alloc(size)) {}
}
for (const [what, call] of [
  ["ink_page_words", (x, d) => x.ink_page_words(d, 3)],
  ["ink_page_links", (x, d) => x.ink_page_links(d, 3)],
  ["ink_load_outline", (x, d) => x.ink_load_outline(d)],
  ["ink_open_stream", (x) => x.ink_open_stream(BigInt(outlined.length))],
]) {
  const x = await instance(outlined);
  const d = x.ink_open_stream(BigInt(outlined.length));
  squeeze(x);
  let r;
  try {
    r = call(x, d);
  } catch (err) {
    check(false, `${what} past the ceiling is an error, not a trap`, `${err.constructor.name}: ${err.message}`);
    continue;
  }
  check(r < 0, `${what} past the ceiling fails`, `got ${r}`);
  check(/alloc \(.*\) failed|out of memory/.test(lastError(x)), `${what} fails as MuPDF's out-of-memory error`, lastError(x));
}
