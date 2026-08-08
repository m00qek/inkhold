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
let fixture = fs.readFileSync(pdfPath);
const savedFixture = fixture;
const hostReads = [];
let hostFails = false;
/** Past this offset the host answers 0 — a range that came back empty. */
let hostZeroFrom = Infinity;
const imports = {
  ...wasi.getImportObject(),
  ink: {
    host_read(off, dst, len) {
      const at = Number(off);
      hostReads.push([at, len]);
      if (hostFails) return -1;
      if (at >= hostZeroFrom) return 0;
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
  "ink_page_links",
  "ink_links_free",
  "ink_page_words",
  "ink_words_free",
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
function buildPdf(bodies) {
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

function tinyPdf(mediaBox, extra, content) {
  return buildPdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [${mediaBox.join(" ")}]${extra}` +
      " /Contents 4 0 R /Resources << >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ]);
}

/**
 * An N-page PDF where EVERY page carries an `/Annots` array — the thing the
 * incremental export exists to preserve and the thing grafting destroys.
 *
 * A `/Link` is used because it has no appearance stream, so it changes no
 * pixels: the pixel diff below stays a statement about the ink alone, while
 * `/Annots` is still there to be found (or lost) in the bytes.
 *
 * Three objects per page — page, contents, annotation — so the numbering is
 * arithmetic rather than a running counter.
 */
function annotatedPdf(count, mediaBox = [0, 0, 200, 100], padBytes = 0) {
  const bodies = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${Array.from({ length: count }, (_, i) => `${3 + i * 3} 0 R`).join(" ")}]` +
      ` /Count ${count} >>`,
  ];
  for (let i = 0; i < count; i++) {
    // A distinct rectangle per page, so a page drawn in place of another shows
    // up in the diff rather than passing for it.
    const content = `0 0 0 rg\n${10 + i * 15} 20 40 30 re f`;
    bodies.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [${mediaBox.join(" ")}]` +
        ` /Contents ${4 + i * 3} 0 R /Resources << >>` +
        ` /Annots [${5 + i * 3} 0 R] >>`,
    );
    bodies.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    bodies.push(
      `<< /Type /Annot /Subtype /Link /Rect [5 5 60 20] /Border [0 0 0]` +
        ` /A << /Type /Action /S /URI /URI (https://example.invalid/p${i}) >> >>`,
    );
  }
  // Filler, so a fixture can be made big enough that reading it back takes MORE
  // THAN ONE host read (the stream's window is 32 KB). Unreferenced, which is
  // legal: an incremental write collects no garbage, so nothing prunes it.
  if (padBytes > 0) {
    bodies.push(`<< /Length ${padBytes} >>\nstream\n${"%".repeat(padBytes)}\nendstream`);
  }
  return buildPdf(bodies);
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

// ============================================================================
// The WHOLE-DOCUMENT export (`ink_annotate_page` + `ink_export_incremental`)
// ============================================================================
//
// Not a loop over `ink_export_page`: grafting drops `/Annots`, so a 77-page
// document exported that way would lose every link and highlight it had, 77
// times. This route mutates the OPEN document's pages and writes an INCREMENTAL
// UPDATE — the original's bytes verbatim, plus only what changed.
//
// THE ASSERTION THAT CARRIES THE WEIGHT is that the ORIGINAL'S OWN ANNOTATIONS
// survive, which the per-page path fails by construction; it is asserted BOTH
// ways below, against the same fixture, so the difference is visible rather than
// claimed. The rest: the original is a verbatim prefix of the output, the page
// count is unchanged, the ink lands on the annotated page and NOWHERE ELSE, and
// a reader (this module) opens the concatenation.

/** Copy the last export out and release the module's buffer. */
function takeExport(packed) {
  if (packed <= 0n) return null;
  const bytes = Buffer.from(
    new Uint8Array(e.memory.buffer, Number(packed >> 32n), Number(packed & 0xffffffffn)),
  );
  e.ink_export_free();
  return bytes;
}

/** Draw `alpha` onto `page` of the open document, in place. */
function annotate(handle, page, alpha, w, h, m) {
  const at = e.ink_alloc(alpha.length);
  new Uint8Array(e.memory.buffer, at, alpha.length).set(alpha);
  const rc = e.ink_annotate_page(handle, page, at, w, h, ...m);
  e.ink_free(at, alpha.length);
  return rc;
}

function errorText() {
  const n = e.ink_error_len();
  return Buffer.from(new Uint8Array(e.memory.buffer, e.ink_error_ptr(), n)).toString("utf8");
}

// --- the round trip ---------------------------------------------------------
// Three pages, every one of them carrying a /Link. Only page 1 is written on —
// the real corpus is 7 annotated pages out of 77, and a route that quietly
// touched the other 70 would be a different (and worse) feature.
const source = annotatedPdf(3);
check(/\/Annots/.test(source.toString("latin1")), "the fixture really has /Annots");

const wdoc2 = openBytes(source);
check(wdoc2 >= 1, "the annotated fixture opens", `got ${wdoc2}`);
const beforePages = [0, 1, 2].map((p) => renderCopy(wdoc2, p, 1));
check(
  beforePages.every((f) => f && f.w === 200 && f.h === 100),
  "the fixture's three pages render",
);

// Display x 20..80, y 10..30 on page 1 — clear of that page's own rectangle,
// which sits at display y 50..80.
const inkBox = [[20, 10, 80, 30]];
const mask = coverage(100, 50, [[10, 5, 40, 15, 255]]);
equal(annotate(wdoc2, 1, mask, 100, 50, [2, 0, 0, 2, 0, 0]), 0, "ink_annotate_page(page 1)");

const delta = takeExport(e.ink_export_incremental(wdoc2));
check(delta !== null, "ink_export_incremental produced a delta", errorText());
e.ink_close(wdoc2);

if (delta) {
  // A DELTA, NOT A DOCUMENT. It must be a small fraction of the original and
  // must NOT begin with a header — if it did, the module would be handing back
  // a whole rewritten file and the memory argument would be a fiction.
  check(
    delta.subarray(0, 5).toString("latin1") !== "%PDF-",
    "the delta is not a whole document",
  );
  check(delta.length > 0, "the delta is not empty");
  // NOTHING OF THE ORIGINAL IS RE-ENCODED — the memory claim, stated as bytes.
  // The pages' own content streams are uncompressed ASCII in the fixture, so an
  // implementation that rewrote the document rather than appending to it would
  // carry them here.
  check(
    delta.indexOf(Buffer.from("re f", "latin1")) === -1,
    "the delta does not carry the original's content streams",
  );

  // THE DIFFERENTIATOR, half one: the rewritten page object still carries the
  // annotation array it had. The page dict IS rewritten (its /Contents now
  // points at the ink), so a mutation that dropped /Annots would supersede the
  // original's copy and lose it — which the prefix check below cannot see.
  check(
    /\/Annots/.test(delta.toString("latin1")),
    "the rewritten page keeps its own /Annots",
  );

  const whole = Buffer.concat([source, delta]);
  // THE INCREMENTAL PROMISE ITSELF: nothing of the original is re-encoded.
  check(source.equals(whole.subarray(0, source.length)), "the original is a verbatim prefix");

  const rdoc2 = openBytes(whole);
  check(rdoc2 >= 1, "the concatenation opens as a PDF", `got ${rdoc2}`);
  if (rdoc2 >= 1) {
    equal(e.ink_page_count(rdoc2), 3, "the export still has three pages");

    // THE DIFFERENTIATOR, half two: a reader that actually parses the result
    // still finds the link. `ink_page_count` proves the xref offsets in the
    // delta resolve at all — an unbiased offset (trap 2) would fail here.
    for (const p of [0, 1, 2]) {
      const after = renderCopy(rdoc2, p, 1);
      const before = beforePages[p];
      check(after && after.w === before.w && after.h === before.h,
        `page ${p} of the export renders at the source's size`);
      let disturbed = 0;
      let missing = 0;
      for (let y = 0; y < before.h; y++) {
        for (let x = 0; x < before.w; x++) {
          const o = (y * before.w + x) * 4;
          const inked = p === 1 && within(inkBox, x, y, 1);
          if (!inked) {
            if (after.px[o] !== before.px[o]) disturbed += 1;
          } else if (within(inkBox, x, y, -1) && after.px[o] > 64) {
            missing += 1;
          }
        }
      }
      equal(disturbed, 0, `page ${p} is untouched outside the ink`);
      equal(missing, 0, `page ${p}: the ink is dark where it was painted`);
    }
    e.ink_close(rdoc2);
  }
}

// --- two annotated pages that SHARE one /Resources dictionary ---------------
// The common real shape — one document in the corpus gives all 26 of its pages
// the same /Resources object — and the reason the ink's XObject is named per
// page. Under a single fixed name the second annotate OVERWRITES the first
// page's entry in the dictionary they share, and page 0's content stream, still
// saying `Do` on that name, draws page 1's handwriting. The pixel diff below is
// what sees it: the two masks paint different boxes.
{
  const shared = buildPdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R /Resources 7 0 R >>",
    "<< /Length 9 >>\nstream\n0 0 0 rg\n\nendstream",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 6 0 R /Resources 7 0 R >>",
    "<< /Length 9 >>\nstream\n0 0 0 rg\n\nendstream",
    "<< >>",
  ]);
  const sdoc = openBytes(shared);
  check(sdoc >= 1, "the shared-resources fixture opens", `got ${sdoc}`);
  // Page 0's ink -> display x 20..80, y 10..30. Page 1's -> x 100..160, y 60..80.
  const m0 = coverage(100, 50, [[10, 5, 40, 15, 255]]);
  const m1 = coverage(100, 50, [[50, 30, 80, 40, 255]]);
  equal(annotate(sdoc, 0, m0, 100, 50, [2, 0, 0, 2, 0, 0]), 0, "shared: annotate page 0");
  equal(annotate(sdoc, 1, m1, 100, 50, [2, 0, 0, 2, 0, 0]), 0, "shared: annotate page 1");
  const d = takeExport(e.ink_export_incremental(sdoc));
  check(d !== null, "shared: the incremental export succeeds", errorText());
  e.ink_close(sdoc);
  if (d) {
    const out = openBytes(Buffer.concat([shared, d]));
    check(out >= 1, "shared: the concatenation opens", `got ${out}`);
    const want = [
      [[20, 10, 80, 30]],
      [[100, 60, 160, 80]],
    ];
    for (const p of [0, 1]) {
      const f = renderCopy(out, p, 1);
      let wrong = 0;
      for (let y = 0; y < f.h; y++) {
        for (let x = 0; x < f.w; x++) {
          const dark = f.px[(y * f.w + x) * 4] < 64;
          const should = within(want[p], x, y, -1);
          const mayBe = within(want[p], x, y, 1);
          if ((should && !dark) || (dark && !mayBe)) wrong += 1;
        }
      }
      equal(wrong, 0, `shared: page ${p} carries its OWN ink and no other page's`);
    }
    e.ink_close(out);
  }
}

// --- a page whose /Resources are INHERITED from its /Pages node -------------
// /Resources is one of the five keys a page may inherit, and plenty of real
// documents put it on the tree node once instead of on every page. Reading only
// the page's own key finds nothing there, and writing a fresh /Resources onto
// the page to hold the ink then SHADOWS the inherited one — so the page's own
// text loses the font it was set in, and the export is a page with a hole in it.
// The ink still lands correctly, which is why only a diff of the page's OWN
// pixels sees this.
{
  const text = "BT /F1 24 Tf 20 40 Td (Hello) Tj ET";
  const inherited = buildPdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 /Resources << /Font << /F1 5 0 R >> >> >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R >>",
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ]);
  const idoc = openBytes(inherited);
  check(idoc >= 1, "the inherited-resources fixture opens", `got ${idoc}`);
  const beforeInk = renderCopy(idoc, 0, 1);
  let inkyBefore = 0;
  for (let i = 0; i < beforeInk.px.length; i += 4) if (beforeInk.px[i] < 128) inkyBefore += 1;
  // A check on the FIXTURE: if the text never drew, losing it proves nothing.
  check(inkyBefore > 200, "the inherited font really draws text", `${inkyBefore} dark px`);

  // Ink well clear of the text (display y 5..15 is the top strip; the text sits
  // at display y ~36..60).
  equal(
    annotate(idoc, 0, coverage(100, 50, [[60, 1, 90, 6, 255]]), 100, 50, [2, 0, 0, 2, 0, 0]),
    0,
    "inherited: annotate",
  );
  const id = takeExport(e.ink_export_incremental(idoc));
  check(id !== null, "inherited: the incremental export succeeds", errorText());
  e.ink_close(idoc);
  if (id) {
    const out = openBytes(Buffer.concat([inherited, id]));
    check(out >= 1, "inherited: the concatenation opens", `got ${out}`);
    const f = renderCopy(out, 0, 1);
    const inkedBox = [[120, 2, 180, 12]];
    // TOLERANCE OF 8, and it is not slack. The ink image covers the WHOLE page
    // (its coverage is zero outside the box, not its extent), and compositing a
    // fully transparent image over an ANTIALIASED grey rounds it by a unit —
    // the same 8-bit rounding `ink_shim_render` documents when it forces the
    // alpha channel opaque. Losing the inherited font turns 291 dark pixels
    // white, a difference of 255, so this still catches the thing it is for.
    let disturbed = 0;
    for (let y = 0; y < beforeInk.h; y++) {
      for (let x = 0; x < beforeInk.w; x++) {
        const o = (y * beforeInk.w + x) * 4;
        if (!within(inkedBox, x, y, 1) && Math.abs(f.px[o] - beforeInk.px[o]) > 8) disturbed += 1;
      }
    }
    let darkAfter = 0;
    for (let i = 0; i < f.px.length; i += 4) if (f.px[i] < 128) darkAfter += 1;
    // The ink's own 60x10 box, and the text still under it.
    check(
      Math.abs(darkAfter - (inkyBefore + 600)) < 40,
      "inherited: the page keeps its text AND gains the ink",
      `before ${inkyBefore}, after ${darkAfter}`,
    );
    equal(disturbed, 0, "inherited: the page's own text survives the annotation");
    e.ink_close(out);
  }
}

// --- and the per-page path FAILS the same assertion --------------------------
// Stated as a test rather than as a comment, because it is the entire reason
// this second route exists. If `pdf_graft_page` ever learns to copy /Annots this
// goes red, and the honest response is to re-read the plan, not to relax it.
const gdoc = openBytes(source);
const grafted = takeExport(
  (() => {
    const at = e.ink_alloc(mask.length);
    new Uint8Array(e.memory.buffer, at, mask.length).set(mask);
    const packed = e.ink_export_page(gdoc, 1, at, 100, 50, 2, 0, 0, 2, 0, 0);
    e.ink_free(at, mask.length);
    return packed;
  })(),
);
check(grafted !== null, "the per-page export of the same page succeeds");
if (grafted) {
  check(
    !/\/Annots/.test(grafted.toString("latin1")),
    "...and it has LOST the page's /Annots — which is why the incremental route exists",
  );
}
e.ink_close(gdoc);

// --- refusal: junk before the version marker (trap 2) ------------------------
// `pdf_save_document` sets `opts.bias = doc->bias` for an incremental write;
// `pdf_write_document` — the only entry point a memory-only ABI can use — never
// does, and the field it would set is internal. So every xref offset in the
// delta would be written unbiased and point at the wrong byte, producing a file
// that opens to nothing. It is detectable and not fixable from outside, so the
// shim reads `doc->bias` and refuses.
const biased = Buffer.concat([Buffer.from("%not a pdf yet\n"), annotatedPdf(1)]);
const bdoc = openBytes(biased);
check(bdoc >= 1, "MuPDF opens a file with junk before %PDF-", `got ${bdoc}`);
equal(annotate(bdoc, 0, mask, 100, 50, [2, 0, 0, 2, 0, 0]), -2, "a biased file is refused");
check(/%PDF-/.test(errorText()), "the bias refusal names the cause", errorText());
// Refused BEFORE anything is mutated: the export refuses on its own terms too,
// with the same sentence, rather than with "nothing was annotated".
equal(e.ink_export_incremental(bdoc), -2n, "...and the write refuses as well");
check(/%PDF-/.test(errorText()), "the write's refusal names the same cause", errorText());
e.ink_close(bdoc);

// --- refusal: a repaired file (trap 3) --------------------------------------
// MuPDF refuses incremental on a repaired file outright, and would do so from
// inside `pdf_write_document` AFTER the pages had been mutated. Pre-empting it
// in `ink_annotate_page` is what keeps a refusal from leaving a half-annotated
// document behind for the next render to draw.
const sound = annotatedPdf(1);
const broken = Buffer.from(
  sound.toString("latin1").replace(/startxref\n(\d+)/, (_, n) => `startxref\n${"9".repeat(n.length)}`),
  "latin1",
);
check(!sound.equals(broken), "the repair fixture really is corrupted");
const pdoc = openBytes(broken);
check(pdoc >= 1, "MuPDF repairs and opens the broken file", `got ${pdoc}`);
equal(annotate(pdoc, 0, mask, 100, 50, [2, 0, 0, 2, 0, 0]), -2, "a repaired file is refused");
check(/repair/i.test(errorText()), "the repair refusal says so", errorText());
e.ink_close(pdoc);

// --- refusal: nothing was annotated -----------------------------------------
// An empty delta concatenates to a byte-identical copy of the original, which
// the raw-download row already offers; shipping it under a name that promises
// ink would be a lie the user cannot see.
const edoc = openBytes(annotatedPdf(1));
equal(e.ink_export_incremental(edoc), -2n, "an unannotated document is refused");
check(/no ink/i.test(errorText()), "...and says nothing was added", errorText());
e.ink_close(edoc);

// --- argument hygiene, against a LIVE handle --------------------------------
// Aimed at a closed handle these would all come back -1 from the lookup alone
// and the checks could be deleted with the suite still green.
const adoc = openBytes(annotatedPdf(2));
const alphaAt2 = e.ink_alloc(16);
new Uint8Array(e.memory.buffer, alphaAt2, 16).fill(255);
equal(e.ink_annotate_page(adoc, 0, alphaAt2, 4, 4, 1, 0, 0, 1, 0, 0), 0, "annotate accepts good arguments");
equal(e.ink_annotate_page(adoc, 0, alphaAt2, 0, 4, 1, 0, 0, 1, 0, 0), -1, "a zero width is refused");
equal(e.ink_annotate_page(adoc, 0, alphaAt2, 4, 0, 1, 0, 0, 1, 0, 0), -1, "a zero height is refused");
equal(e.ink_annotate_page(adoc, 0, 0, 4, 4, 1, 0, 0, 1, 0, 0), -1, "a null coverage pointer is refused");
equal(e.ink_annotate_page(adoc, -1, alphaAt2, 4, 4, 1, 0, 0, 1, 0, 0), -1, "a negative page is refused");
equal(e.ink_annotate_page(adoc, 0, alphaAt2, 4, 4, NaN, 0, 0, 1, 0, 0), -1, "a NaN matrix is refused");
equal(
  e.ink_annotate_page(adoc, 0, alphaAt2, 4, 4, 1, 0, 0, Infinity, 0, 0),
  -1,
  "an infinite matrix is refused",
);
equal(e.ink_annotate_page(adoc, 99, alphaAt2, 4, 4, 1, 0, 0, 1, 0, 0), -2, "a missing page is refused");
e.ink_close(adoc);
equal(e.ink_annotate_page(adoc, 0, alphaAt2, 4, 4, 1, 0, 0, 1, 0, 0), -1, "a dead handle is refused");
equal(e.ink_export_incremental(adoc), -1n, "the write refuses a dead handle");
e.ink_free(alphaAt2, 16);

// A document MuPDF opens but that has no PDF objects at all.
const hdoc2 = openBytes(
  Buffer.from("<html><body><p>a document MuPDF opens but cannot annotate</p></body></html>"),
);
const alphaAt3 = e.ink_alloc(16);
new Uint8Array(e.memory.buffer, alphaAt3, 16).fill(255);
equal(e.ink_annotate_page(hdoc2, 0, alphaAt3, 4, 4, 1, 0, 0, 1, 0, 0), -2, "a non-PDF cannot be annotated");
equal(e.ink_export_incremental(hdoc2), -2n, "a non-PDF cannot be written incrementally");
e.ink_free(alphaAt3, 16);
e.ink_close(hdoc2);

// --- the streamed path -------------------------------------------------------
// The real viewer opens a large document over `ink.host_read`, and the
// incremental write READS THE WHOLE ORIGINAL back through it (MuPDF's copy of
// the file it is appending to, which the shim sinks). That the delta is the same
// either way is what says the sink is honest about its offsets.
if (delta) {
  fixture = annotatedPdf(3);
  check(fixture.equals(source), "the streamed run uses the same bytes as the buffered one");
  const sdoc3 = e.ink_open_stream(BigInt(fixture.length));
  check(sdoc3 >= 1, "the annotated fixture opens as a stream", `got ${sdoc3}`);
  equal(annotate(sdoc3, 1, mask, 100, 50, [2, 0, 0, 2, 0, 0]), 0, "annotate over the stream");
  const streamDelta = takeExport(e.ink_export_incremental(sdoc3));
  check(streamDelta !== null, "the streamed incremental export succeeds", errorText());
  if (streamDelta) {
    // NOT byte-equality: the trailer's /ID is regenerated per write, so two
    // deltas of the same edit differ in those bytes and nowhere else. Length is
    // the check that stays true and still catches a sink that dropped or
    // duplicated the original.
    equal(streamDelta.length, delta.length, "the streamed delta is the same size");
    const sWhole = Buffer.concat([fixture, streamDelta]);
    const sOut = openBytes(sWhole);
    check(sOut >= 1, "the streamed concatenation opens", `got ${sOut}`);
    equal(e.ink_page_count(sOut), 3, "...with all three pages");
    e.ink_close(sOut);
  }
  e.ink_close(sdoc3);

  // AND WHAT HAPPENS WHEN THE SOURCE GOES SHORT. The delta is produced by
  // SINKING MuPDF's copy of the original — everything below the original's
  // length is dropped on the floor — so a `doc->file` that stops early would
  // sink the real objects too and hand back a delta whose offsets are all
  // wrong: a file that opens to a blank page rather than one that fails. The
  // shim checks the cursor against the delta it produced, which is what turns
  // that into a refusal. A host answering 0 mid-file is an empty range
  // response, which is exactly how this arrives in a browser.
  fixture = annotatedPdf(3, [0, 0, 200, 100], 40 * 1024);
  const zdoc = e.ink_open_stream(BigInt(fixture.length));
  check(zdoc >= 1, "the stream opens before the host goes short", `got ${zdoc}`);
  equal(annotate(zdoc, 1, mask, 100, 50, [2, 0, 0, 2, 0, 0]), 0, "annotate before the host fails");
  hostZeroFrom = 32 * 1024;
  equal(e.ink_export_incremental(zdoc), -2n, "a truncated original fails the write");
  hostZeroFrom = Infinity;
  e.ink_close(zdoc);

  fixture = savedFixture;
}

// ============================================================================
// The page's own LINKS (`ink_page_links`)
// ============================================================================
//
// The claim is not "a link exists" — a shim that returned a plausible-looking
// array would pass that, and so would one whose rects are in the wrong space.
// Every assertion below is on COORDINATES or on an exact uri, because the two
// ways this feature goes wrong are both invisible to a presence check:
//
//   1. THE PAGE BOX ORIGIN. `ink_page_size` hands over `fz_bound_page`'s EXTENT
//      and throws its origin away, so a page whose box does not start at (0,0)
//      would put link rects in a space the client has never heard of. The
//      `cropped` fixture below has its media box at (50,30) and takes a 120x60
//      crop out of it; the link rects have to be measured from the CROP box's
//      top-left, which is the only origin `ink_page_size` describes.
//
//   2. ROTATION. `fz_bound_page` reports the TRANSFORMED box, so a /Rotate 90
//      page reports its rotated extent and its links must land in that same
//      rotated space. This is where the export put ink ninety degrees out, with
//      exactly the right number of inked pixels — so it is verified on a
//      fixture rather than reasoned about.
//
// And the third thing, which is not geometry: the uri comes out of a file that
// arrived by device sync. `javascript:` — and `file:` and `data:` — must not
// survive at all, not survive with a flag for someone downstream to check.

/** The links on `page`, parsed. Throws if the payload is not valid JSON. */
function pageLinks(handle, page) {
  const packed = e.ink_page_links(handle, page);
  if (packed < 0n) return packed;
  const json = Buffer.from(
    new Uint8Array(e.memory.buffer, Number(packed >> 32n), Number(packed & 0xffffffffn)),
  ).toString("utf8");
  e.ink_links_free();
  return { json, links: JSON.parse(json) };
}

/**
 * A TWO-PAGE PDF whose first page carries `annots` — two, so an internal link
 * has somewhere to go and a resolved target of 1 is distinguishable from a
 * shim that answers 0 for everything.
 */
function linkedPdf(mediaBox, extra, annots) {
  const refs = annots.map((_, i) => `${6 + i} 0 R`).join(" ");
  return buildPdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [${mediaBox.join(" ")}]${extra}` +
      ` /Contents 4 0 R /Resources << >> /Annots [${refs}] >>`,
    "<< /Length 9 >>\nstream\n0 0 0 rg\n\nendstream",
    `<< /Type /Page /Parent 2 0 R /MediaBox [${mediaBox.join(" ")}]${extra}` +
      " /Contents 4 0 R /Resources << >> >>",
    ...annots,
  ]);
}

function linkAnnot(rect, action) {
  return `<< /Type /Annot /Subtype /Link /Rect [${rect.join(" ")}] /Border [0 0 0]` +
    ` /A << ${action} >> >>`;
}

/** One of each: two we follow, one internal, and four we refuse. */
const LINK_ANNOTS = [
  linkAnnot([20, 20, 80, 60], "/S /URI /URI (https://example.invalid/a)"),
  linkAnnot([100, 20, 160, 60], "/S /GoTo /D [5 0 R /XYZ 0 100 0]"),
  linkAnnot([20, 70, 80, 90], "/S /URI /URI (javascript:alert\\(1\\))"),
  linkAnnot([100, 70, 160, 90], "/S /URI /URI (mailto:someone@example.invalid)"),
  linkAnnot([0, 0, 10, 10], "/S /URI /URI (file:///etc/passwd)"),
  linkAnnot([10, 0, 20, 10], "/S /URI /URI (data:text/html,<script>x</script>)"),
  linkAnnot([20, 0, 30, 10], "/S /URI /URI (JavaScript:alert\\(2\\))"),
];

/* --- upright: the rects, the resolved target, and what does NOT survive ---- */
{
  const doc = openBytes(linkedPdf([0, 0, 200, 100], "", LINK_ANNOTS));
  check(doc >= 1, "links: the fixture opens", `got ${doc}`);
  const got = pageLinks(doc, 0);
  check(typeof got === "object", "links: ink_page_links succeeds", `got ${got}`);

  // THE ALLOWLIST. Seven annotations in, three out: https, the internal GoTo,
  // and mailto. `javascript:` (both spellings), `file:` and `data:` are not
  // dropped to a neutered href — they produce no record at all, so nothing
  // downstream can render an affordance that lies about where it goes.
  equal(got.links.length, 3, "links: four refused schemes leave no record");
  check(
    !/javascript/i.test(got.json) && !/file:/.test(got.json) && !/data:/.test(got.json),
    "links: no refused uri survives ANYWHERE in the payload",
    got.json,
  );

  // PDF's origin is bottom-left and this space's is top-left, so the annot at
  // (20,20)-(80,60) on a 100pt-tall page displays at y 100-60 = 40.
  const ext = got.links.find((l) => l.uri.startsWith("https:"));
  check(ext !== undefined, "links: the external link is there");
  equal(ext.x, 20, "links: external x");
  equal(ext.y, 40, "links: external y (PDF y-up -> display y-down)");
  equal(ext.w, 60, "links: external w");
  equal(ext.h, 40, "links: external h");
  equal(ext.page, -1, "links: an external link resolves to no page");
  equal(ext.uri, "https://example.invalid/a", "links: the external uri survives intact");

  // RESOLVED IN C. The client never sees `5 0 R`; it sees the page number.
  const internal = got.links.find((l) => l.page >= 0);
  check(internal !== undefined, "links: the internal link is there");
  equal(internal.page, 1, "links: the internal link resolves to page 1 (0-based)");
  equal(internal.x, 100, "links: internal x");
  equal(internal.y, 40, "links: internal y");

  const mail = got.links.find((l) => l.uri.startsWith("mailto:"));
  check(mail !== undefined, "links: mailto is allowed");
  equal(mail.y, 10, "links: mailto y (PDF 70..90 on a 100pt page -> display 10..30)");

  // THE SPACE THE RECTS ARE IN IS THE SPACE `ink_page_size` REPORTS. Stated as
  // an assertion rather than as a comment, because it is the whole contract:
  // the client's transform is one scale, and that is only true if these agree.
  const at = e.ink_alloc(8);
  e.ink_page_size(doc, 0, at, at + 4);
  const sz = new DataView(e.memory.buffer);
  equal(sz.getFloat32(at, true), 200, "links: the page measures 200pt wide");
  equal(sz.getFloat32(at + 4, true), 100, "links: the page measures 100pt tall");
  check(
    got.links.every((l) => l.x >= 0 && l.y >= 0 && l.x + l.w <= 200 && l.y + l.h <= 100),
    "links: every rect lies inside the page ink_page_size describes",
    got.json,
  );
  e.ink_free(at, 8);

  // Page 1 has no /Annots at all. `[]` is a SUCCESS — "no links" and "could not
  // read this page" are different answers and the caller acts differently.
  const empty = pageLinks(doc, 1);
  equal(empty.json, "[]", "links: a page with no annotations answers []");

  // The same document over the CALLBACK STREAM. Listing links loads the page
  // and resolving the internal destination walks the xref again, so both go
  // through `ink_host_read` on this path — and the answer has to be identical.
  fixture = linkedPdf([0, 0, 200, 100], "", LINK_ANNOTS);
  const sdocL = e.ink_open_stream(BigInt(fixture.length));
  check(sdocL >= 1, "links: the fixture opens as a stream", `got ${sdocL}`);
  equal(pageLinks(sdocL, 0).json, got.json, "links: the streamed answer is byte-identical");
  e.ink_close(sdocL);
  fixture = savedFixture;

  e.ink_close(doc);
  equal(e.ink_page_links(doc, 0), -1n, "links: a dead handle is refused");
}

/* --- TRAP 1: a page box that does not start at (0,0) ----------------------- */
// Media box at (50,30), crop box (70,50)-(190,110) inside it. `ink_page_size`
// reports 120x60 — the crop box's extent, its origin discarded — so a link rect
// must be measured from the CROP BOX'S TOP-LEFT, which in PDF coordinates is
// (70,110). The annot at (80,60)-(110,80) is therefore at display x 80-70 = 10,
// y 110-80 = 30, 30 wide and 20 tall. Any implementation that measures from
// user-space (0,0) puts it at x 80, y -50: off the page, and the same "a link
// exists" check passes either way.
{
  const cropAnnots = [
    linkAnnot([80, 60, 110, 80], "/S /URI /URI (https://example.invalid/crop)"),
  ];
  const doc = openBytes(linkedPdf([50, 30, 250, 130], " /CropBox [70 50 190 110]", cropAnnots));
  check(doc >= 1, "cropped links: the fixture opens", `got ${doc}`);
  const at = e.ink_alloc(8);
  e.ink_page_size(doc, 0, at, at + 4);
  const sz = new DataView(e.memory.buffer);
  equal(sz.getFloat32(at, true), 120, "cropped links: the page measures the CROP box's width");
  equal(sz.getFloat32(at + 4, true), 60, "cropped links: ...and its height");
  e.ink_free(at, 8);

  const got = pageLinks(doc, 0);
  equal(got.links.length, 1, "cropped links: one link", got.json);
  equal(got.links[0].x, 10, "cropped links: x is measured from the crop box's left edge");
  equal(got.links[0].y, 30, "cropped links: y is measured from the crop box's TOP edge");
  equal(got.links[0].w, 30, "cropped links: w");
  equal(got.links[0].h, 20, "cropped links: h");
  e.ink_close(doc);
}

/* --- TRAP 2: /Rotate 90 ---------------------------------------------------- */
// A 200x100 page with /Rotate 90 DISPLAYS as 100x200, and `ink_page_size` says
// so. The link rects have to be in that same rotated space, or the client scales
// them against a width they were never measured in. The annot at (20,20)-(80,60)
// lands at display x 20..60, y 20..80 — note that its extent is 40x60 where the
// unrotated one is 60x40, so a shim that forgot the rotation produces a box of
// the wrong SHAPE as well as the wrong place.
{
  const rotAnnots = [linkAnnot([20, 20, 80, 60], "/S /URI /URI (https://example.invalid/rot)")];
  const doc = openBytes(linkedPdf([0, 0, 200, 100], " /Rotate 90", rotAnnots));
  check(doc >= 1, "rotated links: the fixture opens", `got ${doc}`);
  const at = e.ink_alloc(8);
  e.ink_page_size(doc, 0, at, at + 4);
  const sz = new DataView(e.memory.buffer);
  equal(sz.getFloat32(at, true), 100, "rotated links: /Rotate 90 swaps the reported width");
  equal(sz.getFloat32(at + 4, true), 200, "rotated links: ...and the height");
  e.ink_free(at, 8);

  const got = pageLinks(doc, 0);
  equal(got.links.length, 1, "rotated links: one link", got.json);
  equal(got.links[0].x, 20, "rotated links: x, in the ROTATED space");
  equal(got.links[0].y, 20, "rotated links: y, in the ROTATED space");
  equal(got.links[0].w, 40, "rotated links: the rect is 40 wide, not 60");
  equal(got.links[0].h, 60, "rotated links: the rect is 60 tall, not 40");
  e.ink_close(doc);
}

/* --- a hostile uri, and the numbers JSON will not take --------------------- */
// Two ways the payload stops being parseable, both of which take the whole
// page's links down rather than one link:
//
//   - a uri carrying a quote, a backslash or a control byte, which would close
//     the string and let the file write its own fields;
//   - MuPDF's own `%g`, which writes 0.5 as `.5` (printf.c, `fmtfloat`) — legal
//     nowhere in JSON. One half-point edge would be enough, so the shim formats
//     its own numbers and this fixture has a rect on half-points.
{
  // x0 = 0.5 ON PURPOSE: `%g` writes a value BELOW ONE as `.5`, and only below
  // one — a rect at 10.5 comes out fine and would let the bug through.
  const nasty = linkAnnot(
    [0.5, 10.25, 30.5, 20.75],
    // PDF literal-string escapes: `\\` is one backslash, `\001` is one control
    // byte. The decoded uri is: https://x.invalid/?a="b"\<SOH>
    String.raw`/S /URI /URI (https://x.invalid/?a="b"\\\001)`,
  );
  const doc = openBytes(linkedPdf([0, 0, 200, 100], "", [nasty]));
  check(doc >= 1, "hostile links: the fixture opens", `got ${doc}`);
  const got = pageLinks(doc, 0); // JSON.parse inside — a bad payload throws here
  equal(got.links.length, 1, "hostile links: the link survives escaping", got.json);
  equal(
    got.links[0].uri,
    'https://x.invalid/?a="b"\\\u0001',
    "hostile links: the quote, the backslash and the control byte round-trip",
  );
  check(
    got.json.includes('\\"') && got.json.includes("\\\\") && got.json.includes("\\u0001"),
    "hostile links: they are ESCAPED in the payload, not passed through",
    got.json,
  );
  // Display y of the PDF rect 10.25..20.75 on a 100pt page is 79.25..89.75.
  equal(got.links[0].x, 0.5, "hostile links: a sub-1 x is a valid JSON number, not `.5`");
  equal(got.links[0].y, 79.25, "hostile links: a quarter-point y survives too");
  equal(got.links[0].w, 30, "hostile links: w");
  equal(got.links[0].h, 10.5, "hostile links: h");
  e.ink_close(doc);
}

/* --- refusals and hygiene -------------------------------------------------- */
{
  const doc = openBytes(fs.readFileSync(pdfPath));
  equal(e.ink_page_links(doc, 99), -2n, "links: a missing page is refused");
  check(e.ink_error_len() > 0, "links: ...with a message");
  equal(e.ink_page_links(doc, -1), -1n, "links: a negative page is refused");
  equal(e.ink_page_links(doc + 100, 0), -1n, "links: an out-of-range handle is refused");
  // A document with no links at all still answers, and answers `[]`.
  equal(pageLinks(doc, 0).json, "[]", "links: a link-free document answers []");
  e.ink_close(doc);
  // Idempotent, and safe with nothing outstanding — a viewer calls this on every
  // page turn including the ones that failed.
  e.ink_links_free();
  e.ink_links_free();
}

// ============================================================================
// The page's WORDS (`ink_page_words`) — find-in-PDF's locator
// ============================================================================
//
// What this proves is not "there is text on the page". It is the three things
// the highlight is built on, each of which fails invisibly to a presence check:
//
//   1. THE SPACE. The boxes are in the same top-left-origin, y-down, points
//      space `ink_page_size` and `ink_page_links` report — so the viewer's whole
//      transform is the raster's scale, and one mapping serves the ink, the
//      links and the highlight alike. Verified on the /Rotate 90 fixture, where
//      a horizontal word becomes a TALL box: a shim that reported unrotated
//      coordinates gives a box of the wrong SHAPE as well as the wrong place.
//
//   2. THE SPLIT. The runs are split as the index tokenises, near enough:
//      punctuation is a boundary and an accented letter is not. `avaliação` has
//      to arrive as ONE word or the Portuguese household's fold has nothing to
//      compare against.
//
//   3. NO MATCHING HAPPENS HERE. There is no needle in the ABI — the server
//      decided what matched and the client folds. That is asserted by what is
//      absent (no query argument) and by the payload carrying every word on the
//      page rather than a selected few.

/** The words on `page`, parsed. Throws if the payload is not valid JSON. */
function pageWords(handle, page) {
  const packed = e.ink_page_words(handle, page);
  if (packed < 0n) return packed;
  const json = Buffer.from(
    new Uint8Array(e.memory.buffer, Number(packed >> 32n), Number(packed & 0xffffffffn)),
  ).toString("utf8");
  e.ink_words_free();
  return { json, words: JSON.parse(json) };
}

/**
 * A two-page PDF whose FIRST page carries `text` in 12pt Helvetica and whose
 * second is blank — so "a page with words" and "a page with none" come out of
 * one fixture. `/WinAnsiEncoding` is named explicitly: without it a base-14
 * Type1 font is read in StandardEncoding, where byte 0xE7 is not `ç`, and the
 * accented-word assertion would be testing the encoding rather than the split.
 */
function textPdf(mediaBox, extra, text) {
  const content = `BT /F1 12 Tf 10 50 Td (${text}) Tj ET`;
  return buildPdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [${mediaBox.join(" ")}]${extra}` +
      " /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [${mediaBox.join(" ")}]${extra}` +
      " /Contents 7 0 R /Resources << >> >>",
    "<< /Length 9 >>\nstream\n0 0 0 rg\n\nendstream",
  ]);
}

// `\347` is ç and `\343` is ã in WinAnsi; the parentheses are escaped because a
// PDF literal string counts them.
const WORDS_TEXT = String.raw`Marmalade, avalia\347\343o \(quince\) page-range`;

let uprightWords = null;
{
  const doc = openBytes(textPdf([0, 0, 300, 100], "", WORDS_TEXT));
  check(doc >= 1, "words: the fixture opens", `got ${doc}`);
  const got = pageWords(doc, 0);
  check(typeof got === "object", "words: ink_page_words succeeds", `got ${got}`);

  // THE SPLIT. Five runs out of one line: the comma, the parentheses and the
  // hyphen are boundaries; the cedilla and the tilde are not.
  equal(
    got.words.map((w) => w.t).join(" "),
    "Marmalade avaliação quince page range",
    "words: punctuation splits a run and an accented letter does not",
  );

  // THE SPACE. Every box lies inside the page `ink_page_size` describes, and the
  // text sits at PDF y 50 on a 100pt page — display y ~41..50 for a 12pt face.
  const at = e.ink_alloc(8);
  e.ink_page_size(doc, 0, at, at + 4);
  const sz = new DataView(e.memory.buffer);
  equal(sz.getFloat32(at, true), 300, "words: the page measures 300pt wide");
  equal(sz.getFloat32(at + 4, true), 100, "words: the page measures 100pt tall");
  e.ink_free(at, 8);
  check(
    got.words.every((w) => w.x >= 0 && w.y >= 0 && w.x + w.w <= 300 && w.y + w.h <= 100),
    "words: every box lies inside the page ink_page_size describes",
    got.json,
  );
  const first = got.words[0];
  check(first.x >= 9 && first.x <= 11, "words: the first run starts at the text's own x", first.x);
  check(
    first.y > 35 && first.y + first.h < 55,
    "words: y is measured DOWN from the top (PDF y 50 -> display ~41)",
    `${first.y}..${first.y + first.h}`,
  );
  // Reading order, left to right — what makes a match index mean something.
  check(
    got.words.every((w, i) => i === 0 || w.x > got.words[i - 1].x),
    "words: the runs arrive in reading order",
    got.json,
  );
  uprightWords = got.words;

  // A page with no text answers `[]`, which is a SUCCESS — a scan has no words
  // and that is an answer, not a fault.
  equal(pageWords(doc, 1).json, "[]", "words: a page with no text answers []");

  // Over the CALLBACK STREAM the answer must be identical: building the
  // structured text RUNS the page, so every font and content stream it names is
  // pulled through `ink_host_read` on that path.
  fixture = textPdf([0, 0, 300, 100], "", WORDS_TEXT);
  const swords = e.ink_open_stream(BigInt(fixture.length));
  check(swords >= 1, "words: the fixture opens as a stream", `got ${swords}`);
  equal(pageWords(swords, 0).json, got.json, "words: the streamed answer is byte-identical");
  e.ink_close(swords);
  fixture = savedFixture;

  e.ink_close(doc);
  equal(e.ink_page_words(doc, 0), -1n, "words: a dead handle is refused");
}

/* --- /Rotate 90: a horizontal word becomes a TALL box ---------------------- */
// The same trap the links and the export both fell into. `ink_page_size` reports
// the rotated extent, so a word box measured in unrotated space is scaled
// against a width it was never measured in — and the failure is invisible to any
// check that only asks whether a box exists.
if (uprightWords) {
  const doc = openBytes(textPdf([0, 0, 300, 100], " /Rotate 90", WORDS_TEXT));
  check(doc >= 1, "rotated words: the fixture opens", `got ${doc}`);
  const at = e.ink_alloc(8);
  e.ink_page_size(doc, 0, at, at + 4);
  const sz = new DataView(e.memory.buffer);
  equal(sz.getFloat32(at, true), 100, "rotated words: /Rotate 90 swaps the reported width");
  equal(sz.getFloat32(at + 4, true), 300, "rotated words: ...and the height");
  e.ink_free(at, 8);

  const got = pageWords(doc, 0);
  equal(
    got.words.map((w) => w.t).join(" "),
    uprightWords.map((w) => w.t).join(" "),
    "rotated words: the same runs, in the same order",
  );
  const up = uprightWords[0];
  const rot = got.words[0];
  check(up.w > up.h, "rotated words: the upright box is wide", `${up.w}x${up.h}`);
  check(rot.h > rot.w, "rotated words: the rotated box is TALL", `${rot.w}x${rot.h}`);
  check(
    Math.abs(rot.w - up.h) < 0.5 && Math.abs(rot.h - up.w) < 0.5,
    "rotated words: the box's axes are swapped, not merely different",
    `upright ${up.w}x${up.h}, rotated ${rot.w}x${rot.h}`,
  );
  check(
    got.words.every((w) => w.x >= 0 && w.y >= 0 && w.x + w.w <= 100 && w.y + w.h <= 300),
    "rotated words: every box lies inside the ROTATED page",
    got.json,
  );
  e.ink_close(doc);
}

/* --- refusals and hygiene -------------------------------------------------- */
{
  const doc = openBytes(fs.readFileSync(pdfPath));
  equal(e.ink_page_words(doc, 99), -2n, "words: a missing page is refused");
  check(e.ink_error_len() > 0, "words: ...with a message");
  equal(e.ink_page_words(doc, -1), -1n, "words: a negative page is refused");
  equal(e.ink_page_words(doc + 100, 0), -1n, "words: an out-of-range handle is refused");
  // The committed fixture is two filled rectangles and no text at all.
  equal(pageWords(doc, 0).json, "[]", "words: a text-free document answers []");
  e.ink_close(doc);
  // Idempotent, and safe with nothing outstanding — find calls this on every page
  // turn including the ones that failed.
  e.ink_words_free();
  e.ink_words_free();
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log(`pdf-decode.wasm OK — rendered ${width}x${height} RGBA from ${pdf.length} PDF bytes`);
