// ABI + render check for `pdf-decode.wasm` (`zig build wasm-pdf-decode-test`).
//
// The point is NOT that the module links — a dead-stripped shell links fine and
// exports the right names. The point is that a real PDF goes in and real pixels
// come out: the fixture's page 0 is 200x100 pt with a 60x40 pt black rectangle
// at (20,20), so at scale 2 we assert exact 400x200 dimensions, a fully opaque
// alpha channel (the ABI promises straight, non-premultiplied RGBA), black at
// the rectangle's centre, white outside it, and a black-pixel count that matches
// the rectangle's area. That last one is what a stub cannot fake.
//
// Also exercised: content sniffing with no filename, the second page's different
// size, and the handle discipline — a closed handle must come back as a rejected
// integer rather than crash.
//
// Usage: node pdf_decode_abi.mjs <pdf-decode.wasm> <fixture.pdf>

import { WASI } from "node:wasi";
import fs from "node:fs";

const [, , wasmPath, pdfPath] = process.argv;
if (!wasmPath || !pdfPath) {
  console.error("usage: node pdf_decode_abi.mjs <pdf-decode.wasm> <fixture.pdf>");
  process.exit(2);
}

let failures = 0;
function check(ok, what, detail) {
  if (ok) return;
  failures += 1;
  console.error(`FAIL: ${what}${detail === undefined ? "" : ` (${detail})`}`);
}
function equal(actual, expected, what) {
  check(actual === expected, what, `expected ${expected}, got ${actual}`);
}

// The module imports wasi_snapshot_preview1 because wasi-libc is linked, but the
// memory-only ABI never reaches a syscall. Node's real WASI is used here rather
// than ENOSYS stubs precisely so that an accidental filesystem call would show
// up as a wrong answer instead of being silently swallowed.
const wasi = new WASI({ version: "preview1", args: [], env: {} });
const mod = await WebAssembly.compile(fs.readFileSync(wasmPath));

// The module also declares ONE non-WASI import, `ink.host_read` — the callback
// `ink_open_stream` pulls its bytes through. It has to be supplied even here,
// where the whole-file entry point is what most of this file exercises: a
// declared import the embedder omits is a link error, not a lazily-bound symbol.
//
// Here it reads straight out of the fixture, synchronously. In the browser the
// same import is wrapped in `WebAssembly.Suspending` and may await a range
// fetch; a synchronous answer is exactly what a block-cache HIT looks like, so
// this covers the C stream's `next`/`seek` bookkeeping without needing JSPI.
const fixture = fs.readFileSync(pdfPath);
const hostReads = [];
let hostFails = false;
const imports = {
  ...wasi.getImportObject(),
  ink: {
    host_read(off, dst, len) {
      const at = Number(off);
      hostReads.push([at, len]);
      if (hostFails) return -1;
      const n = Math.max(0, Math.min(len, fixture.length - at));
      if (n > 0) new Uint8Array(e.memory.buffer, dst, n).set(fixture.subarray(at, at + n));
      return n;
    },
  },
};
const instance = await WebAssembly.instantiate(mod, imports);
wasi.initialize(instance);
const e = instance.exports;

for (const name of [
  "ink_alloc",
  "ink_free",
  "ink_open",
  "ink_open_stream",
  "ink_page_count",
  "ink_page_size",
  "ink_render",
  "ink_render_width",
  "ink_render_height",
  "ink_close",
  "memory",
]) {
  check(e[name] !== undefined, `export \`${name}\` is present`);
}
if (failures > 0) process.exit(1);

// ---- open ----
const pdf = fs.readFileSync(pdfPath);
const buf = e.ink_alloc(pdf.length);
check(buf !== 0, "ink_alloc returned a buffer");
new Uint8Array(e.memory.buffer, buf, pdf.length).set(pdf);

const doc = e.ink_open(buf, pdf.length); // no magic: MuPDF sniffs the content
check(doc >= 1, "ink_open returned a handle", `got ${doc}`);
equal(e.ink_page_count(doc), 2, "ink_page_count");

// ---- page size, in points ----
const scratch = e.ink_alloc(8);
check(e.ink_page_size(doc, 0, scratch, scratch + 4) === 0, "ink_page_size(page 0) succeeded");
let dv = new DataView(e.memory.buffer);
equal(dv.getFloat32(scratch, true), 200, "page 0 width (pt)");
equal(dv.getFloat32(scratch + 4, true), 100, "page 0 height (pt)");
check(e.ink_page_size(doc, 1, scratch, scratch + 4) === 0, "ink_page_size(page 1) succeeded");
dv = new DataView(e.memory.buffer);
equal(dv.getFloat32(scratch, true), 300, "page 1 width (pt)");
equal(dv.getFloat32(scratch + 4, true), 150, "page 1 height (pt)");

// Out-of-range page and stale handles must be rejected, not dereferenced.
check(e.ink_page_size(doc, 99, scratch, scratch + 4) < 0, "page 99 rejected");
check(e.ink_page_count(doc + 100) < 0, "out-of-range handle rejected");

// ---- render ----
const scale = 2;
const packed = e.ink_render(doc, 0, scale);
check(packed > 0n, "ink_render succeeded", `got ${packed}`);
const ptr = Number(packed >> 32n);
const len = Number(packed & 0xffffffffn);
const width = e.ink_render_width();
const height = e.ink_render_height();
equal(width, 400, "rendered width (200pt @ 2x)");
equal(height, 200, "rendered height (100pt @ 2x)");
equal(len, width * height * 4, "packed length matches w*h*4 (RGBA)");

const px = new Uint8Array(e.memory.buffer, ptr, len);

// Alpha must be fully opaque everywhere: that is what makes the promised
// "straight RGBA" identical to MuPDF's premultiplied buffer.
let transparent = 0;
for (let i = 3; i < px.length; i += 4) if (px[i] !== 255) transparent += 1;
equal(transparent, 0, "every pixel is opaque");

// PDF's origin is bottom-left, the pixmap's is top-left. The 60x40 rect at
// (20,20) therefore lands at x 40..160, y 200-120=80..160 in device pixels.
function rgb(x, y) {
  const o = (y * width + x) * 4;
  return [px[o], px[o + 1], px[o + 2]];
}
check(rgb(100, 120).every((c) => c < 32), "centre of the rectangle is black", rgb(100, 120));
check(rgb(300, 40).every((c) => c > 224), "outside the rectangle is white", rgb(300, 40));

let dark = 0;
for (let i = 0; i < px.length; i += 4) if (px[i] < 128) dark += 1;
// 60pt x 40pt at 2x = 120 x 80 = 9600 px. Antialiasing moves the edges by a
// pixel at most, so a few percent of slack is right and a stub returning a blank
// or a fully black page fails on either side.
check(
  Math.abs(dark - 9600) < 400,
  "dark pixel count matches the rectangle's area",
  `expected ~9600, got ${dark}`,
);

// Rendering page 1 must replace the buffer, not accumulate.
const packed2 = e.ink_render(doc, 1, 1);
check(packed2 > 0n, "ink_render(page 1) succeeded", `got ${packed2}`);
equal(e.ink_render_width(), 300, "page 1 rendered width (300pt @ 1x)");
equal(e.ink_render_height(), 150, "page 1 rendered height (150pt @ 1x)");

// ---- close ----
e.ink_close(doc);
check(e.ink_page_count(doc) < 0, "handle is rejected after close");
e.ink_close(doc); // idempotent
e.ink_close(0);
e.ink_close(-7);
e.ink_free(scratch, 8);

// A non-document must be refused rather than opened as an empty one, and the
// buffer must still be consumed (no leak, no double free on the next open).
const junkLen = 64;
const junk = e.ink_alloc(junkLen);
new Uint8Array(e.memory.buffer, junk, junkLen).fill(0x7a);
check(e.ink_open(junk, junkLen) < 0, "garbage bytes are refused");

// ...and MuPDF's reason for refusing survives the ABI boundary.
const errLen = e.ink_error_len();
check(errLen > 0, "ink_error_len reports a message after a failure");
const message = Buffer.from(
  new Uint8Array(e.memory.buffer, e.ink_error_ptr(), errLen),
).toString("utf8");
check(message.length === errLen, "ink_error_ptr bytes match ink_error_len", message);

// And the module is still usable afterwards.
const buf2 = e.ink_alloc(pdf.length);
new Uint8Array(e.memory.buffer, buf2, pdf.length).set(pdf);
const doc2 = e.ink_open(buf2, pdf.length);
check(doc2 >= 1, "reopen after a failed open", `got ${doc2}`);
equal(e.ink_page_count(doc2), 2, "page count after reopen");
e.ink_close(doc2);

// ---- the callback stream (`ink_open_stream`) ----
// Same document, same pixels, but pulled through `ink.host_read` instead of
// handed over as a buffer. Byte-for-byte equality is the check that matters:
// a stream whose `seek`/`pos` bookkeeping is off by a window still renders
// something plausible, just of the wrong part of the file.
hostReads.length = 0;
const sdoc = e.ink_open_stream(BigInt(pdf.length));
check(sdoc >= 1, "ink_open_stream returned a handle", `got ${sdoc}`);
equal(e.ink_page_count(sdoc), 2, "ink_page_count over the stream");

const spacked = e.ink_render(sdoc, 0, 2);
check(spacked > 0n, "ink_render over the stream succeeded", `got ${spacked}`);
equal(e.ink_render_width(), 400, "streamed page 0 width");
equal(e.ink_render_height(), 200, "streamed page 0 height");
const streamed = Buffer.from(
  new Uint8Array(e.memory.buffer, Number(spacked >> 32n), Number(spacked & 0xffffffffn)),
);

const bufS = e.ink_alloc(pdf.length);
new Uint8Array(e.memory.buffer, bufS, pdf.length).set(pdf);
const wdoc = e.ink_open(bufS, pdf.length);
const wpacked = e.ink_render(wdoc, 0, 2);
const wholeFile = Buffer.from(
  new Uint8Array(e.memory.buffer, Number(wpacked >> 32n), Number(wpacked & 0xffffffffn)),
);
check(streamed.equals(wholeFile), "streamed pixels are identical to whole-file pixels");
e.ink_close(wdoc);

// The window in `ink_stream_seek` earns its place: without it this 688-byte
// fixture cost seven host reads of the same 688 bytes, because `fz_seek` has no
// in-buffer fast path and drops the window on every backwards seek.
check(hostReads.length <= 2, "the stream does not re-read what it holds", `${hostReads.length} reads`);
e.ink_close(sdoc);

// A host that cannot read must surface as a MuPDF error and leave the module
// usable — on the real path this is an aborted range fetch, not a corrupt file.
hostFails = true;
check(e.ink_open_stream(BigInt(pdf.length)) < 0, "a failing host_read fails the open");
hostFails = false;
const sdoc2 = e.ink_open_stream(BigInt(pdf.length));
check(sdoc2 >= 1, "the module still opens a stream afterwards", `got ${sdoc2}`);
e.ink_close(sdoc2);
check(e.ink_open_stream(0n) < 0, "a zero length is refused");

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log(`pdf-decode.wasm OK — rendered ${width}x${height} RGBA from ${pdf.length} PDF bytes`);
