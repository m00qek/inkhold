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
// The last section is the EXPORT ROUND TRIP: `ink_export_page` grafts a page
// into a one-page PDF with ink over it, and the produced bytes go straight back
// through the same module to be rendered. The assertion that carries the weight
// is a PIXEL DIFF against the source page — identical everywhere the ink is not,
// inked everywhere it is. A stub cannot fake it, and a placement that ignores
// the page's own transform fails it (which is how the `/Rotate 90` bug was
// caught; that case has a fixture of its own below).
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
  "ink_export_page",
  "ink_export_free",
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

// ============================================================================
// The export round trip (`ink_export_page`)
// ============================================================================
//
// Export a page, then REOPEN THE PRODUCED BYTES THROUGH THIS SAME MODULE and
// render them. Three things are asserted, in rising order of what they can
// catch:
//
//   1. the export is one page, at the source page's exact point size — a graft
//      that lost the geometry, or brought its siblings along, fails here;
//   2. every pixel the ink does not touch is BYTE-IDENTICAL to the source page —
//      which is the whole claim of a structure-preserving export, and is what a
//      "write a fresh raster at A4 width" implementation cannot pass;
//   3. the ink is dark exactly where the caller's matrix said, in DISPLAY space.
//
// (3) is why the `/Rotate 90` fixture below exists. Ink placed without inverting
// the page's own transform lands 90 degrees out — and note that it would still
// pass a plain "the dark pixel count went up by the ink's area" check, because
// the same number of pixels is inked, just in the wrong place.

/** Render `page` and COPY the pixels out — the module's buffer is reused. */
function renderCopy(handle, page, scale) {
  const packed = e.ink_render(handle, page, scale);
  if (packed <= 0n) return null;
  const at = Number(packed >> 32n);
  const n = Number(packed & 0xffffffffn);
  return {
    w: e.ink_render_width(),
    h: e.ink_render_height(),
    px: new Uint8Array(new Uint8Array(e.memory.buffer, at, n)),
  };
}

/**
 * A minimal one-page PDF, assembled here rather than committed as a fixture:
 * the point of these is the PAGE DICTIONARY (`/Rotate`, an off-origin box), and
 * a generator makes the thing under test visible at the call site. Every byte is
 * ASCII, so a JS string's length is the byte length the xref needs.
 */
function tinyPdf(mediaBox, extra, content) {
  const bodies = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [${mediaBox.join(" ")}]${extra}` +
      " /Contents 4 0 R /Resources << >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  let out = "%PDF-1.4\n";
  const offsets = [];
  bodies.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefAt = out.length;
  out += `xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n`;
  for (const at of offsets) out += `${String(at).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R >>\n`;
  out += `startxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

function openBytes(bytes) {
  const at = e.ink_alloc(bytes.length);
  new Uint8Array(e.memory.buffer, at, bytes.length).set(bytes);
  return e.ink_open(at, bytes.length);
}

/** `w*h` coverage bytes, `value` inside `[x0,x1) x [y0,y1)` and 0 elsewhere. */
function coverage(w, h, boxes) {
  const a = new Uint8Array(w * h);
  for (const [x0, y0, x1, y1, value] of boxes) {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) a[y * w + x] = value;
  }
  return a;
}

/** Export `page` with `alpha` over it, and copy the produced PDF out. */
function exportPage(handle, page, alpha, w, h, m) {
  const at = e.ink_alloc(alpha.length);
  if (!at) return null;
  new Uint8Array(e.memory.buffer, at, alpha.length).set(alpha);
  const packed = e.ink_export_page(handle, page, at, w, h, ...m);
  let bytes = null;
  if (packed > 0n) {
    // AFTER the call: the export can grow linear memory and detach the old view.
    bytes = Buffer.from(
      new Uint8Array(e.memory.buffer, Number(packed >> 32n), Number(packed & 0xffffffffn)),
    );
  }
  e.ink_free(at, alpha.length);
  e.ink_export_free();
  return { packed, bytes };
}

/** Is `(x,y)` inside any of `boxes`, each grown (or shrunk) by `slack`? */
function within(boxes, x, y, slack) {
  return boxes.some(
    ([x0, y0, x1, y1]) =>
      x >= x0 - slack && x < x1 + slack && y >= y0 - slack && y < y1 + slack,
  );
}

/**
 * The round trip proper.
 *
 * `t.inked` lists every display-space box the coverage bitmap paints into, in
 * pixels at scale 1; `t.solid` is the subset painted at full coverage. Outside
 * `inked` the page must be untouched; inside `solid` the result must be dark.
 *
 * ONE PIXEL OF SLACK ON EACH BOUNDARY, and no more. An image's edge is
 * anti-aliased into the pixel it half-covers, so a box's outline is neither
 * fully inked nor fully clean; the slack exempts that one row. Widening it
 * further would start hiding the misplacement the test is here to catch — a
 * quarter-page error has to stay a failure.
 */
function roundTrip(label, t) {
  const src = openBytes(t.source);
  check(src >= 1, `${label}: source opens`, `got ${src}`);
  if (src < 1) return;
  const before = renderCopy(src, 0, 1);
  check(before !== null, `${label}: source renders`);

  // The painted region must start out BLANK in the source, or "the ink is dark
  // there" proves nothing. This is a check on the fixture, not on the module.
  let blank = true;
  for (let y = 0; y < before.h; y++) {
    for (let x = 0; x < before.w; x++) {
      if (within(t.inked, x, y, 1) && before.px[(y * before.w + x) * 4] < 250) blank = false;
    }
  }
  check(blank, `${label}: the painted region is blank in the source page`);

  const alpha = coverage(t.alphaW, t.alphaH, t.coverage);
  const { packed, bytes } = exportPage(src, 0, alpha, t.alphaW, t.alphaH, t.matrix);
  check(packed > 0n, `${label}: ink_export_page succeeded`, `got ${packed}`);
  if (packed <= 0n) return;
  check(bytes.subarray(0, 5).toString("latin1") === "%PDF-", `${label}: the bytes are a PDF`);

  // Reopen through the same module. The source stays open so its pixels can be
  // diffed against, which also proves the export does not disturb it.
  const out = openBytes(bytes);
  check(out >= 1, `${label}: the export reopens`, `got ${out}`);
  if (out < 1) return;

  equal(e.ink_page_count(out), 1, `${label}: the export is exactly one page`);
  const scratchPt = e.ink_alloc(8);
  equal(e.ink_page_size(out, 0, scratchPt, scratchPt + 4), 0, `${label}: the export has a size`);
  const sizes = new DataView(e.memory.buffer);
  equal(sizes.getFloat32(scratchPt, true), before.w, `${label}: exported page width (pt)`);
  equal(sizes.getFloat32(scratchPt + 4, true), before.h, `${label}: exported page height (pt)`);
  e.ink_free(scratchPt, 8);

  const after = renderCopy(out, 0, 1);
  check(after !== null && after.w === before.w && after.h === before.h,
    `${label}: the export renders at the source's dimensions`);

  // THE ASSERTION THAT MATTERS. Outside the ink: byte-identical to the source
  // page. Inside the solid ink: dark. Both are counted rather than
  // short-circuited so a failure reports how wrong it is.
  let disturbed = 0;
  let missing = 0;
  for (let y = 0; y < before.h; y++) {
    for (let x = 0; x < before.w; x++) {
      const o = (y * before.w + x) * 4;
      if (!within(t.inked, x, y, 1)) {
        if (after.px[o] !== before.px[o]) disturbed += 1;
      } else if (within(t.solid, x, y, -1) && after.px[o] > 64) {
        missing += 1;
      }
    }
  }
  equal(disturbed, 0, `${label}: the page is untouched outside the ink`);
  equal(missing, 0, `${label}: the ink is dark everywhere it was painted`);
  e.ink_close(out);
  e.ink_close(src);
  return { before, after };
}

// --- Upright, with a half-tone patch ---------------------------------------
// The committed fixture's page 0: 200x100 pt, a 60x40 black rectangle at
// (20,20) in PDF (bottom-left) coordinates, i.e. display x 20..80, y 40..80.
//
// The coverage bitmap is 100x50 — deliberately NOT the page's pixel size — so
// the matrix has real work to do: `2 0 0 2 0 0` maps its pixels onto the full
// 200x100 display box. The solid patch lands at display x 20..80, y 10..30,
// clear of the rectangle.
const upright = roundTrip("upright", {
  source: fs.readFileSync(pdfPath),
  alphaW: 100,
  alphaH: 50,
  coverage: [
    [10, 5, 40, 15, 255], // solid ink            -> display x 20..80, y 10..30
    [45, 5, 50, 15, 128], // half coverage        -> display x 90..100, y 10..30
  ],
  matrix: [2, 0, 0, 2, 0, 0],
  inked: [
    [20, 10, 80, 30],
    [90, 10, 100, 30],
  ],
  solid: [[20, 10, 80, 30]],
});

// ANTI-ALIASING SURVIVES. The ink is a /DeviceGray image with an 8-bit /SMask
// rather than a 1-bit /ImageMask precisely so the pen's 16 grey levels come
// through; a stencil would render this patch solid black. Display x 90..100,
// y 10..30 is the alpha-128 column.
if (upright) {
  const at = (x, y) => upright.after.px[(y * upright.after.w + x) * 4];
  const grey = at(95, 20);
  check(grey > 96 && grey < 160, "half coverage renders as mid grey (8-bit SMask)", `got ${grey}`);
  check(at(95, 5) === 255, "the alpha-0 margin above it is untouched", `got ${at(95, 5)}`);
}

// --- /Rotate 90 -------------------------------------------------------------
// The failure this guards: `ink_page_size` reports the CROPPED, ROTATED box,
// while a content stream is written in unrotated MediaBox space. A 200x100 page
// with /Rotate 90 displays as 100x200, and its rectangle displays at x 20..60,
// y 20..80. Placing the ink without inverting the page's own transform put it 90
// degrees out — with exactly the same number of inked pixels, so only a
// positional check catches it.
const rotated = tinyPdf([0, 0, 200, 100], " /Rotate 90", "0 0 0 rg\n20 20 60 40 re f");
const rdoc = openBytes(rotated);
check(rdoc >= 1, "the /Rotate 90 fixture opens", `got ${rdoc}`);
const rscratch = e.ink_alloc(8);
e.ink_page_size(rdoc, 0, rscratch, rscratch + 4);
const rdv = new DataView(e.memory.buffer);
equal(rdv.getFloat32(rscratch, true), 100, "/Rotate 90 swaps the reported width");
equal(rdv.getFloat32(rscratch + 4, true), 200, "/Rotate 90 swaps the reported height");
e.ink_free(rscratch, 8);
e.ink_close(rdoc);

roundTrip("rotated", {
  source: rotated,
  alphaW: 50,
  alphaH: 100,
  coverage: [[5, 50, 25, 70, 255]],
  matrix: [2, 0, 0, 2, 0, 0],
  inked: [[10, 100, 50, 140]],
  solid: [[10, 100, 50, 140]],
});

// --- An off-origin /MediaBox with a /CropBox inside it -----------------------
// `pdf_page_transform_box(…, FZ_CROP_BOX)` is what makes display space start at
// the CROP box's corner rather than the user-space origin. Here the media box
// starts at (50,30) and the crop box takes a 120x60 window out of it, so a
// caller placing ink at display (0,0) means the crop box's top-left — not
// user-space (0,0), which is off the page entirely.
const cropped = tinyPdf(
  [50, 30, 250, 130],
  " /CropBox [70 50 190 110]",
  "0 0 0 rg\n80 60 30 20 re f",
);
roundTrip("cropped", {
  source: cropped,
  alphaW: 60,
  alphaH: 30,
  coverage: [[10, 2, 50, 12, 255]],
  matrix: [2, 0, 0, 2, 0, 0],
  inked: [[20, 4, 100, 24]],
  solid: [[20, 4, 100, 24]],
});

// --- Refusals ---------------------------------------------------------------
// A non-PDF has no PDF page to graft, and the caller's fallback is the
// rasterising exporter — which needs a sentence to explain itself with, so the
// refusal carries a message rather than only a code.
const html = Buffer.from("<html><body><p>a document MuPDF opens but cannot graft</p></body></html>");
const hdoc = openBytes(html);
check(hdoc >= 1, "MuPDF opens the HTML document", `got ${hdoc}`);
const alphaAt = e.ink_alloc(16);
new Uint8Array(e.memory.buffer, alphaAt, 16).fill(255);
equal(e.ink_export_page(hdoc, 0, alphaAt, 4, 4, 1, 0, 0, 1, 0, 0), -2n, "a non-PDF is refused");
const refusal = Buffer.from(
  new Uint8Array(e.memory.buffer, e.ink_error_ptr(), e.ink_error_len()),
).toString("utf8");
check(/PDF/.test(refusal), "the refusal says why", refusal);
e.ink_close(hdoc);

// Argument hygiene: a zero-sized bitmap, a null pointer, an out-of-range page
// and a non-finite matrix all have to be rejected BEFORE MuPDF sees them. A NaN
// in particular would reach the content stream as the literal `nan` and produce
// a file no reader can parse — a silently broken export, worse than a refused
// one.
//
// AGAINST A LIVE, EXPORTABLE DOCUMENT. Aiming these at a closed handle would
// have proved nothing: every one of them would come back -1 from the handle
// lookup alone, and the argument checks could all be deleted with the suite
// still green. (They were, and it was.)
const argdoc = openBytes(fs.readFileSync(pdfPath));
check(argdoc >= 1, "a live handle for the argument checks", `got ${argdoc}`);
check(
  e.ink_export_page(argdoc, 0, alphaAt, 4, 4, 1, 0, 0, 1, 0, 0) > 0n,
  "...and it does export when the arguments are good",
);
e.ink_export_free();
equal(e.ink_export_page(argdoc, 0, alphaAt, 0, 4, 1, 0, 0, 1, 0, 0), -1n, "a zero width is refused");
equal(e.ink_export_page(argdoc, 0, alphaAt, 4, 0, 1, 0, 0, 1, 0, 0), -1n, "a zero height is refused");
equal(e.ink_export_page(argdoc, 0, 0, 4, 4, 1, 0, 0, 1, 0, 0), -1n, "a null coverage pointer is refused");
equal(e.ink_export_page(argdoc, -1, alphaAt, 4, 4, 1, 0, 0, 1, 0, 0), -1n, "a negative page is refused");
equal(e.ink_export_page(argdoc, 0, alphaAt, 4, 4, NaN, 0, 0, 1, 0, 0), -1n, "a NaN matrix is refused");
equal(
  e.ink_export_page(argdoc, 0, alphaAt, 4, 4, 1, 0, 0, Infinity, 0, 0),
  -1n,
  "an infinite matrix is refused",
);
// A page MuPDF cannot load is the shim's refusal, not the ABI's, so it comes
// back as -2 with a message rather than -1.
equal(e.ink_export_page(argdoc, 99, alphaAt, 4, 4, 1, 0, 0, 1, 0, 0), -2n, "a missing page is refused");
e.ink_close(argdoc);
equal(e.ink_export_page(argdoc, 0, alphaAt, 4, 4, 1, 0, 0, 1, 0, 0), -1n, "a dead handle is refused");
e.ink_free(alphaAt, 16);

// `ink_export_free` is idempotent and safe with nothing outstanding.
e.ink_export_free();
e.ink_export_free();

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log(`pdf-decode.wasm OK — rendered ${width}x${height} RGBA from ${pdf.length} PDF bytes`);
