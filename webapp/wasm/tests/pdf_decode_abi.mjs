// ABI + render check for `pdf-decode.wasm` (`zig build wasm-pdf-decode-test`).
// Real pixels from a real PDF: the fixture's page 0 is 200x100 pt with a 60x40
// pt black rectangle at (20,20), so its black-pixel count is something a stub
// cannot fake. Exports are round-tripped through the same module and
// pixel-diffed against the source page.
//
// Usage: node pdf_decode_abi.mjs <pdf-decode.wasm> <fixture.pdf>

import { WASI } from "node:wasi";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const [, , wasmPath, pdfPath] = process.argv;
if (!wasmPath || !pdfPath) {
  console.error("usage: node pdf_decode_abi.mjs <pdf-decode.wasm> <fixture.pdf>");
  process.exit(2);
}

/** A committed fixture, read relative to this file (the harness passes one). */
function fixturePath(name) {
  return fileURLToPath(new URL(`fixtures/${name}`, import.meta.url));
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

// Real WASI, so an accidental filesystem call is a wrong answer, not swallowed.
const wasi = new WASI({ version: "preview1", args: [], env: {} });
const mod = await WebAssembly.compile(fs.readFileSync(wasmPath));

// `ink.host_read` must be supplied even here (an omitted import is a link
// error). It answers synchronously, like a block-cache hit in the browser, which
// exercises the stream's `next`/`seek` bookkeeping without JSPI.
let fixture = fs.readFileSync(pdfPath);
const savedFixture = fixture;
const hostReads = [];
let hostFails = false;
/** Past this offset the host answers 0, an empty range. */
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

const pdf = fs.readFileSync(pdfPath);
const buf = e.ink_alloc(pdf.length);
check(buf !== 0, "ink_alloc returned a buffer");
new Uint8Array(e.memory.buffer, buf, pdf.length).set(pdf);

const doc = e.ink_open(buf, pdf.length); // no magic: MuPDF sniffs the content
check(doc >= 1, "ink_open returned a handle", `got ${doc}`);
equal(e.ink_page_count(doc), 2, "ink_page_count");

const scratch = e.ink_alloc(8);
check(e.ink_page_size(doc, 0, scratch, scratch + 4) === 0, "ink_page_size(page 0) succeeded");
let dv = new DataView(e.memory.buffer);
equal(dv.getFloat32(scratch, true), 200, "page 0 width (pt)");
equal(dv.getFloat32(scratch + 4, true), 100, "page 0 height (pt)");
check(e.ink_page_size(doc, 1, scratch, scratch + 4) === 0, "ink_page_size(page 1) succeeded");
dv = new DataView(e.memory.buffer);
equal(dv.getFloat32(scratch, true), 300, "page 1 width (pt)");
equal(dv.getFloat32(scratch + 4, true), 150, "page 1 height (pt)");

check(e.ink_page_size(doc, 99, scratch, scratch + 4) < 0, "page 99 rejected");
check(e.ink_page_count(doc + 100) < 0, "out-of-range handle rejected");

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

let transparent = 0;
for (let i = 3; i < px.length; i += 4) if (px[i] !== 255) transparent += 1;
equal(transparent, 0, "every pixel is opaque");

// PDF's origin is bottom-left: the rect lands at x 40..160, y 80..160 in pixels.
function rgb(x, y) {
  const o = (y * width + x) * 4;
  return [px[o], px[o + 1], px[o + 2]];
}
check(rgb(100, 120).every((c) => c < 32), "centre of the rectangle is black", rgb(100, 120));
check(rgb(300, 40).every((c) => c > 224), "outside the rectangle is white", rgb(300, 40));

let dark = 0;
for (let i = 0; i < px.length; i += 4) if (px[i] < 128) dark += 1;
// 120 x 80 = 9600 px, with a few percent of antialiasing slack.
check(
  Math.abs(dark - 9600) < 400,
  "dark pixel count matches the rectangle's area",
  `expected ~9600, got ${dark}`,
);

const packed2 = e.ink_render(doc, 1, 1);
check(packed2 > 0n, "ink_render(page 1) succeeded", `got ${packed2}`);
equal(e.ink_render_width(), 300, "page 1 rendered width (300pt @ 1x)");
equal(e.ink_render_height(), 150, "page 1 rendered height (150pt @ 1x)");

e.ink_close(doc);
check(e.ink_page_count(doc) < 0, "handle is rejected after close");
e.ink_close(doc); // idempotent
e.ink_close(0);
e.ink_close(-7);
e.ink_free(scratch, 8);

// A non-document is refused, and its buffer still consumed.
const junkLen = 64;
const junk = e.ink_alloc(junkLen);
new Uint8Array(e.memory.buffer, junk, junkLen).fill(0x7a);
check(e.ink_open(junk, junkLen) < 0, "garbage bytes are refused");

const errLen = e.ink_error_len();
check(errLen > 0, "ink_error_len reports a message after a failure");
const message = Buffer.from(
  new Uint8Array(e.memory.buffer, e.ink_error_ptr(), errLen),
).toString("utf8");
check(message.length === errLen, "ink_error_ptr bytes match ink_error_len", message);

const buf2 = e.ink_alloc(pdf.length);
new Uint8Array(e.memory.buffer, buf2, pdf.length).set(pdf);
const doc2 = e.ink_open(buf2, pdf.length);
check(doc2 >= 1, "reopen after a failed open", `got ${doc2}`);
equal(e.ink_page_count(doc2), 2, "page count after reopen");
e.ink_close(doc2);

// ---- the callback stream (`ink_open_stream`) ----
// Byte-for-byte equality: an off-by-a-window stream still renders something.
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

// Without the in-window seek this fixture cost seven host reads.
check(hostReads.length <= 2, "the stream does not re-read what it holds", `${hostReads.length} reads`);
e.ink_close(sdoc);

// A failing host read (an aborted range fetch) is a MuPDF error, and the module
// stays usable.
hostFails = true;
check(e.ink_open_stream(BigInt(pdf.length)) < 0, "a failing host_read fails the open");
hostFails = false;
const sdoc2 = e.ink_open_stream(BigInt(pdf.length));
check(sdoc2 >= 1, "the module still opens a stream afterwards", `got ${sdoc2}`);
e.ink_close(sdoc2);
check(e.ink_open_stream(0n) < 0, "a zero length is refused");

// ---- the export round trip (`ink_export_page`) ----
// One page at the source's point size; untouched pixels byte-identical to the
// source; ink dark exactly where the matrix put it in display space (a
// misplaced ink keeps the same dark-pixel count, so position is checked).

/** Renders `page` and copies the pixels out (the module's buffer is reused). */
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
 * A minimal one-page PDF built here so the page dictionary under test is
 * visible at the call site. All ASCII, so string length is byte length.
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
 * An N-page PDF where every page carries `/Annots`, as `/Link`s (no appearance
 * stream, so no pixels change). Three objects per page.
 */
function annotatedPdf(count, mediaBox = [0, 0, 200, 100], padBytes = 0) {
  const bodies = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${Array.from({ length: count }, (_, i) => `${3 + i * 3} 0 R`).join(" ")}]` +
      ` /Count ${count} >>`,
  ];
  for (let i = 0; i < count; i++) {
    // A distinct rectangle per page, so a swapped page shows in the diff.
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
  // Unreferenced filler to exceed one 32 KB host read.
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

function coverage(w, h, boxes) {
  const a = new Uint8Array(w * h);
  for (const [x0, y0, x1, y1, value] of boxes) {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) a[y * w + x] = value;
  }
  return a;
}

function exportPage(handle, page, alpha, w, h, m) {
  const at = e.ink_alloc(alpha.length);
  if (!at) return null;
  new Uint8Array(e.memory.buffer, at, alpha.length).set(alpha);
  const packed = e.ink_export_page(handle, page, at, w, h, ...m);
  let bytes = null;
  if (packed > 0n) {
    // After the call: the export can grow memory and detach the old view.
    bytes = Buffer.from(
      new Uint8Array(e.memory.buffer, Number(packed >> 32n), Number(packed & 0xffffffffn)),
    );
  }
  e.ink_free(at, alpha.length);
  e.ink_export_free();
  return { packed, bytes };
}

function within(boxes, x, y, slack) {
  return boxes.some(
    ([x0, y0, x1, y1]) =>
      x >= x0 - slack && x < x1 + slack && y >= y0 - slack && y < y1 + slack,
  );
}

/**
 * Exports, reopens and diffs. `t.inked` lists every display-space box the
 * coverage paints (scale 1); `t.solid` the full-coverage subset. One pixel of
 * slack on each boundary for anti-aliasing; more would hide misplacement.
 */
function roundTrip(label, t) {
  const src = openBytes(t.source);
  check(src >= 1, `${label}: source opens`, `got ${src}`);
  if (src < 1) return;
  const before = renderCopy(src, 0, 1);
  check(before !== null, `${label}: source renders`);

  // Check the fixture: the painted region must start out blank.
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

  // Outside the ink byte-identical, inside the solid ink dark; both counted.
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

// --- upright, with a half-tone patch ---
// Coverage is 100x50, not the page's size, so `2 0 0 2 0 0` does real work.
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

// The alpha-128 column stays grey (8-bit /SMask, not a stencil).
if (upright) {
  const at = (x, y) => upright.after.px[(y * upright.after.w + x) * 4];
  const grey = at(95, 20);
  check(grey > 96 && grey < 160, "half coverage renders as mid grey (8-bit SMask)", `got ${grey}`);
  check(at(95, 5) === 255, "the alpha-0 margin above it is untouched", `got ${at(95, 5)}`);
}

// --- /Rotate 90 ---
// The page displays as 100x200; ink placed in unrotated space lands 90 degrees
// out with the same pixel count.
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

// --- an off-origin /MediaBox with a /CropBox inside it ---
// Display (0,0) is the crop box's top-left, not user-space (0,0).
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

// --- refusals ---
// A non-PDF is refused with a message for the rasterising fallback.
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

// Argument hygiene, against a live document: on a closed handle every check
// would pass via the handle lookup alone.
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
// An unloadable page is the shim's refusal (-2 with a message), not the ABI's.
equal(e.ink_export_page(argdoc, 99, alphaAt, 4, 4, 1, 0, 0, 1, 0, 0), -2n, "a missing page is refused");
e.ink_close(argdoc);
equal(e.ink_export_page(argdoc, 0, alphaAt, 4, 4, 1, 0, 0, 1, 0, 0), -1n, "a dead handle is refused");
e.ink_free(alphaAt, 16);

e.ink_export_free();
e.ink_export_free();

// ---- whole-document export (`ink_annotate_page` + `ink_export_incremental`) ----
// The original's own annotations must survive (grafting drops them; asserted
// both ways below), the original is a verbatim prefix, and ink lands only on
// the annotated page.

function takeExport(packed) {
  if (packed <= 0n) return null;
  const bytes = Buffer.from(
    new Uint8Array(e.memory.buffer, Number(packed >> 32n), Number(packed & 0xffffffffn)),
  );
  e.ink_export_free();
  return bytes;
}

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

// --- the round trip ---
// Three pages with a /Link each; only page 1 is written on.
const source = annotatedPdf(3);
check(/\/Annots/.test(source.toString("latin1")), "the fixture really has /Annots");

const wdoc2 = openBytes(source);
check(wdoc2 >= 1, "the annotated fixture opens", `got ${wdoc2}`);
const beforePages = [0, 1, 2].map((p) => renderCopy(wdoc2, p, 1));
check(
  beforePages.every((f) => f && f.w === 200 && f.h === 100),
  "the fixture's three pages render",
);

const inkBox = [[20, 10, 80, 30]];
const mask = coverage(100, 50, [[10, 5, 40, 15, 255]]);
equal(annotate(wdoc2, 1, mask, 100, 50, [2, 0, 0, 2, 0, 0]), 0, "ink_annotate_page(page 1)");

const delta = takeExport(e.ink_export_incremental(wdoc2));
check(delta !== null, "ink_export_incremental produced a delta", errorText());
e.ink_close(wdoc2);

if (delta) {
  // A delta, not a document: small, and no header.
  check(
    delta.subarray(0, 5).toString("latin1") !== "%PDF-",
    "the delta is not a whole document",
  );
  check(delta.length > 0, "the delta is not empty");
  // The fixture's content streams are uncompressed ASCII, so a rewrite would
  // carry them here.
  check(
    delta.indexOf(Buffer.from("re f", "latin1")) === -1,
    "the delta does not carry the original's content streams",
  );

  // The rewritten page object must keep its /Annots, which the prefix check
  // cannot see.
  check(
    /\/Annots/.test(delta.toString("latin1")),
    "the rewritten page keeps its own /Annots",
  );

  const whole = Buffer.concat([source, delta]);
  check(source.equals(whole.subarray(0, source.length)), "the original is a verbatim prefix");

  const rdoc2 = openBytes(whole);
  check(rdoc2 >= 1, "the concatenation opens as a PDF", `got ${rdoc2}`);
  if (rdoc2 >= 1) {
    equal(e.ink_page_count(rdoc2), 3, "the export still has three pages");

    // A parser still finds the link; `ink_page_count` proves the delta's xref
    // offsets resolve.
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

// --- two annotated pages sharing one /Resources dictionary ---
// Under a fixed XObject name page 0 would draw page 1's ink.
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

// --- a page whose /Resources are inherited from /Pages ---
// Writing a fresh /Resources onto the page would shadow the inherited font; only
// a diff of the page's own pixels sees it.
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
  check(inkyBefore > 200, "the inherited font really draws text", `${inkyBefore} dark px`);

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
    // Tolerance 8: a transparent full-page image over antialiased grey rounds
    // by a unit; losing the font is a difference of 255.
    let disturbed = 0;
    for (let y = 0; y < beforeInk.h; y++) {
      for (let x = 0; x < beforeInk.w; x++) {
        const o = (y * beforeInk.w + x) * 4;
        if (!within(inkedBox, x, y, 1) && Math.abs(f.px[o] - beforeInk.px[o]) > 8) disturbed += 1;
      }
    }
    let darkAfter = 0;
    for (let i = 0; i < f.px.length; i += 4) if (f.px[i] < 128) darkAfter += 1;
    check(
      Math.abs(darkAfter - (inkyBefore + 600)) < 40,
      "inherited: the page keeps its text AND gains the ink",
      `before ${inkyBefore}, after ${darkAfter}`,
    );
    equal(disturbed, 0, "inherited: the page's own text survives the annotation");
    e.ink_close(out);
  }
}

// --- and the per-page path fails the same assertion ---
// If `pdf_graft_page` ever copies /Annots this goes red.
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

// --- refusal: junk before the version marker ---
// `pdf_write_document` never applies `doc->bias`, so the shim refuses.
const biased = Buffer.concat([Buffer.from("%not a pdf yet\n"), annotatedPdf(1)]);
const bdoc = openBytes(biased);
check(bdoc >= 1, "MuPDF opens a file with junk before %PDF-", `got ${bdoc}`);
equal(annotate(bdoc, 0, mask, 100, 50, [2, 0, 0, 2, 0, 0]), -2, "a biased file is refused");
check(/%PDF-/.test(errorText()), "the bias refusal names the cause", errorText());
equal(e.ink_export_incremental(bdoc), -2n, "...and the write refuses as well");
check(/%PDF-/.test(errorText()), "the write's refusal names the same cause", errorText());
e.ink_close(bdoc);

// --- refusal: a repaired file ---
// Pre-empted in `ink_annotate_page`, before any page is mutated.
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

// --- refusal: nothing was annotated ---
const edoc = openBytes(annotatedPdf(1));
equal(e.ink_export_incremental(edoc), -2n, "an unannotated document is refused");
check(/no ink/i.test(errorText()), "...and says nothing was added", errorText());
e.ink_close(edoc);

// --- argument hygiene, against a live handle ---
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

const hdoc2 = openBytes(
  Buffer.from("<html><body><p>a document MuPDF opens but cannot annotate</p></body></html>"),
);
const alphaAt3 = e.ink_alloc(16);
new Uint8Array(e.memory.buffer, alphaAt3, 16).fill(255);
equal(e.ink_annotate_page(hdoc2, 0, alphaAt3, 4, 4, 1, 0, 0, 1, 0, 0), -2, "a non-PDF cannot be annotated");
equal(e.ink_export_incremental(hdoc2), -2n, "a non-PDF cannot be written incrementally");
e.ink_free(alphaAt3, 16);
e.ink_close(hdoc2);

// --- the streamed path ---
// The incremental write reads the whole original back through `host_read`.
if (delta) {
  fixture = annotatedPdf(3);
  check(fixture.equals(source), "the streamed run uses the same bytes as the buffered one");
  const sdoc3 = e.ink_open_stream(BigInt(fixture.length));
  check(sdoc3 >= 1, "the annotated fixture opens as a stream", `got ${sdoc3}`);
  equal(annotate(sdoc3, 1, mask, 100, 50, [2, 0, 0, 2, 0, 0]), 0, "annotate over the stream");
  const streamDelta = takeExport(e.ink_export_incremental(sdoc3));
  check(streamDelta !== null, "the streamed incremental export succeeds", errorText());
  if (streamDelta) {
    // Length, not bytes: the trailer's /ID differs per write.
    equal(streamDelta.length, delta.length, "the streamed delta is the same size");
    const sWhole = Buffer.concat([fixture, streamDelta]);
    const sOut = openBytes(sWhole);
    check(sOut >= 1, "the streamed concatenation opens", `got ${sOut}`);
    equal(e.ink_page_count(sOut), 3, "...with all three pages");
    e.ink_close(sOut);
  }
  e.ink_close(sdoc3);

  // A source that goes short mid-file (a host answering 0) must be refused, not
  // yield a delta with wrong offsets.
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

// ---- the page's links (`ink_page_links`) ----
// Assertions are on coordinates and exact uris: a box origin not at (0,0) and
// /Rotate 90 both put rects in the wrong space invisibly, and refused schemes
// must leave no record.

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
 * A two-page PDF whose first page carries `annots`, so an internal link
 * resolving to 1 is distinguishable from a shim answering 0.
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

  // Seven in, three out: https, the internal GoTo, mailto.
  equal(got.links.length, 3, "links: four refused schemes leave no record");
  check(
    !/javascript/i.test(got.json) && !/file:/.test(got.json) && !/data:/.test(got.json),
    "links: no refused uri survives ANYWHERE in the payload",
    got.json,
  );

  // The annot at (20,20)-(80,60) on a 100pt page displays at y 40.
  const ext = got.links.find((l) => l.uri.startsWith("https:"));
  check(ext !== undefined, "links: the external link is there");
  equal(ext.x, 20, "links: external x");
  equal(ext.y, 40, "links: external y (PDF y-up -> display y-down)");
  equal(ext.w, 60, "links: external w");
  equal(ext.h, 40, "links: external h");
  equal(ext.page, -1, "links: an external link resolves to no page");
  equal(ext.uri, "https://example.invalid/a", "links: the external uri survives intact");

  const internal = got.links.find((l) => l.page >= 0);
  check(internal !== undefined, "links: the internal link is there");
  equal(internal.page, 1, "links: the internal link resolves to page 1 (0-based)");
  equal(internal.x, 100, "links: internal x");
  equal(internal.y, 40, "links: internal y");

  const mail = got.links.find((l) => l.uri.startsWith("mailto:"));
  check(mail !== undefined, "links: mailto is allowed");
  equal(mail.y, 10, "links: mailto y (PDF 70..90 on a 100pt page -> display 10..30)");

  // The rects are in the space `ink_page_size` reports.
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

  // Page 1 has no /Annots: `[]` is success.
  const empty = pageLinks(doc, 1);
  equal(empty.json, "[]", "links: a page with no annotations answers []");

  fixture = linkedPdf([0, 0, 200, 100], "", LINK_ANNOTS);
  const sdocL = e.ink_open_stream(BigInt(fixture.length));
  check(sdocL >= 1, "links: the fixture opens as a stream", `got ${sdocL}`);
  equal(pageLinks(sdocL, 0).json, got.json, "links: the streamed answer is byte-identical");
  e.ink_close(sdocL);
  fixture = savedFixture;

  e.ink_close(doc);
  equal(e.ink_page_links(doc, 0), -1n, "links: a dead handle is refused");
}

/* --- a page box that does not start at (0,0) --- */
// Media box at (50,30), crop (70,50)-(190,110): the annot at (80,60)-(110,80)
// displays at x 10, y 30, 30x20.
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

/* --- /Rotate 90 --- */
// The annot lands at x 20..60, y 20..80: 40x60, the rotated shape.
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

/* --- a hostile uri, and numbers JSON will not take --- */
// A quote/backslash/control byte in a uri, and MuPDF's `%g` writing 0.5 as `.5`.
{
  // Only values below one print as `.5`.
  const nasty = linkAnnot(
    [0.5, 10.25, 30.5, 20.75],
    // Decoded uri: https://x.invalid/?a="b"\<SOH>
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
  equal(pageLinks(doc, 0).json, "[]", "links: a link-free document answers []");
  e.ink_close(doc);
  e.ink_links_free();
  e.ink_links_free();
}

// ---- the page's words (`ink_page_words`) ----
// Boxes in page-size space (checked on /Rotate 90, where a word becomes tall),
// split near the index's tokenizer (`avaliação` is one word), and no matching:
// every word on the page comes back.

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
 * Two pages, the first with `text` in 12pt Helvetica, the second blank.
 * `/WinAnsiEncoding` is explicit: in StandardEncoding 0xE7 is not `ç`.
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

// `\347` is ç, `\343` is ã in WinAnsi; parentheses escaped.
const WORDS_TEXT = String.raw`Marmalade, avalia\347\343o \(quince\) page-range`;

let uprightWords = null;
{
  const doc = openBytes(textPdf([0, 0, 300, 100], "", WORDS_TEXT));
  check(doc >= 1, "words: the fixture opens", `got ${doc}`);
  const got = pageWords(doc, 0);
  check(typeof got === "object", "words: ink_page_words succeeds", `got ${got}`);

  // Five runs: comma, parentheses and hyphen split; cedilla and tilde do not.
  equal(
    got.words.map((w) => w.t).join(" "),
    "Marmalade avaliação quince page range",
    "words: punctuation splits a run and an accented letter does not",
  );

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
  check(
    got.words.every((w, i) => i === 0 || w.x > got.words[i - 1].x),
    "words: the runs arrive in reading order",
    got.json,
  );
  uprightWords = got.words;

  equal(pageWords(doc, 1).json, "[]", "words: a page with no text answers []");

  fixture = textPdf([0, 0, 300, 100], "", WORDS_TEXT);
  const swords = e.ink_open_stream(BigInt(fixture.length));
  check(swords >= 1, "words: the fixture opens as a stream", `got ${swords}`);
  equal(pageWords(swords, 0).json, got.json, "words: the streamed answer is byte-identical");
  e.ink_close(swords);
  fixture = savedFixture;

  e.ink_close(doc);
  equal(e.ink_page_words(doc, 0), -1n, "words: a dead handle is refused");
}

/* --- /Rotate 90: a horizontal word becomes a tall box --- */
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

/* --- the line id (`l`) --- */
// Selection joins words with spaces within a line and newlines between lines,
// and baselines are not a reliable grouping key. Asserts a word never carries
// another line's id. The `FZ_STEXT_BLOCK_STRUCT` recursion is unreachable
// (no `FZ_STEXT_COLLECT_STRUCTURE`), so it is not covered.

/**
 * Text on four baselines 20pt apart (too far for MuPDF to merge), the third
 * blank, so contiguity of ids is a real claim.
 */
function multiLinePdf(lines) {
  const content = lines
    .map(([text, y]) => `BT /F1 12 Tf 10 ${y} Td (${text}) Tj ET`)
    .join("\n");
  return buildPdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 120]" +
      " /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
  ]);
}

{
  const doc = openBytes(
    multiLinePdf([
      ["Alpha beta", 90],
      ["gamma delta", 70],
      ["   ", 50], // whitespace only: a line that contributes no word at all
      ["epsilon", 30],
    ]),
  );
  check(doc >= 1, "line ids: the fixture opens", `got ${doc}`);
  const got = pageWords(doc, 0);
  check(typeof got === "object", "line ids: ink_page_words succeeds", `got ${got}`);

  check(
    got.words.every((w) => Number.isInteger(w.l) && w.l >= 0),
    "line ids: every word carries a finite integer `l` >= 0",
    got.json,
  );

  // Non-decreasing: a reset counter would go backwards.
  check(
    got.words.every((w, i) => i === 0 || w.l >= got.words[i - 1].l),
    "line ids: `l` never goes backwards in emission order",
    got.json,
  );

  equal(
    got.words.map((w) => `${w.t}@${w.l}`).join(" "),
    "Alpha@0 beta@0 gamma@1 delta@1 epsilon@2",
    "line ids: words share an id with their line and with no other",
  );

  // Same id means same baseline; a higher id is lower on the page.
  const rowOf = (l) => got.words.filter((w) => w.l === l);
  check(
    [0, 1, 2].every((l) => {
      const row = rowOf(l);
      return row.length > 0 && row.every((w) => Math.abs(w.y - row[0].y) < 0.5);
    }),
    "line ids: every word sharing an id also shares a baseline",
    got.json,
  );
  check(
    rowOf(0)[0].y < rowOf(1)[0].y && rowOf(1)[0].y < rowOf(2)[0].y,
    "line ids: a higher id sits lower on the page",
    got.words.map((w) => `${w.l}:${w.y}`).join(" "),
  );

  // Contiguous from 0: the blank baseline spends no id, so `epsilon` is 2.
  const ids = [...new Set(got.words.map((w) => w.l))];
  equal(
    ids.join(","),
    ids.map((_, i) => i).join(","),
    "line ids: the ids are contiguous from 0 — a wordless line spends none",
  );

  // The run drained by a line ending belongs to the line that is ending.
  equal(got.words.at(-1).l, 2, "line ids: the last word on the page names the last line");

  fixture = multiLinePdf([
    ["Alpha beta", 90],
    ["gamma delta", 70],
    ["   ", 50],
    ["epsilon", 30],
  ]);
  const sline = e.ink_open_stream(BigInt(fixture.length));
  check(sline >= 1, "line ids: the fixture opens as a stream", `got ${sline}`);
  equal(pageWords(sline, 0).json, got.json, "line ids: the streamed answer is byte-identical");
  e.ink_close(sline);
  fixture = savedFixture;

  e.ink_close(doc);
}

/* --- refusals and hygiene -------------------------------------------------- */
{
  const doc = openBytes(fs.readFileSync(pdfPath));
  equal(e.ink_page_words(doc, 99), -2n, "words: a missing page is refused");
  check(e.ink_error_len() > 0, "words: ...with a message");
  equal(e.ink_page_words(doc, -1), -1n, "words: a negative page is refused");
  equal(e.ink_page_words(doc + 100, 0), -1n, "words: an out-of-range handle is refused");
  equal(pageWords(doc, 0).json, "[]", "words: a text-free document answers []");
  e.ink_close(doc);
  e.ink_words_free();
  e.ink_words_free();
}

// ---- the outline (`ink_load_outline`) ----
// The whole list is compared as one string: pre-order with `d` from 0,
// 0-based `p`, and an unresolved destination omits `p` but keeps the row.

function outlineOf(handle) {
  const packed = e.ink_load_outline(handle);
  if (packed < 0n) return packed;
  const json = Buffer.from(
    new Uint8Array(e.memory.buffer, Number(packed >> 32n), Number(packed & 0xffffffffn)),
  ).toString("utf8");
  e.ink_outline_free();
  return { json, entries: JSON.parse(json) };
}

const rowOfEntry = (o) => `${o.d}|${o.t}|${"p" in o ? o.p : "-"}`;

{
  // Six 300x200pt pages, three levels (two would pass a non-recursive walk).
  const bytes = fs.readFileSync(fixturePath("outlined-six-page.pdf"));
  const doc = openBytes(bytes);
  check(doc >= 1, "outline: the fixture opens", `got ${doc}`);
  equal(e.ink_page_count(doc), 6, "outline: the fixture has six pages");

  const got = outlineOf(doc);
  check(typeof got === "object", "outline: ink_load_outline succeeds", `got ${got}`);

  equal(
    got.entries.map(rowOfEntry).join(" "),
    "0|Part One|0 1|Chapter A|1 1|Chapter B|2 0|Part Two|3 1|Chapter C|4 2|Section C.1|5",
    "outline: the flat list carries the tree's order, depth and pages",
  );

  check(
    got.entries.every((o) => Number.isInteger(o.d) && o.d >= 0),
    "outline: every entry carries an integer `d` >= 0",
    got.json,
  );
  equal(got.entries[0].d, 0, "outline: the first entry is at depth 0");

  // A child is at most one level below its predecessor.
  check(
    got.entries.every((o, i) => i === 0 || o.d <= got.entries[i - 1].d + 1),
    "outline: depth never jumps by more than one",
    got.json,
  );

  check(
    got.entries.every((o) => Number.isInteger(o.p) && o.p >= 0 && o.p < 6),
    "outline: every `p` is a 0-based index into this document's pages",
    got.json,
  );
  equal(got.entries.at(-1).p, 5, "outline: the last entry names the last page, 0-based");

  fixture = bytes;
  const sdocOutline = e.ink_open_stream(BigInt(bytes.length));
  check(sdocOutline >= 1, "outline: the fixture opens as a stream", `got ${sdocOutline}`);
  equal(outlineOf(sdocOutline).json, got.json, "outline: the streamed answer is byte-identical");
  e.ink_close(sdocOutline);
  fixture = savedFixture;

  e.ink_close(doc);
  equal(e.ink_load_outline(doc), -1n, "outline: a dead handle is refused");
}

/* --- no outline answers [], a success --- */
{
  const doc = openBytes(fs.readFileSync(pdfPath));
  const got = outlineOf(doc);
  check(typeof got === "object", "outline: an outline-free document is not an error", `got ${got}`);
  equal(got.json, "[]", "outline: a document with no outline answers []");
  e.ink_close(doc);
}

/* --- an unresolved destination omits `p` --- */
// An external URI, a named destination naming nothing, and an empty /Title:
// each is still a row.
{
  const doc = openBytes(
    buildPdf([
      "<< /Type /Catalog /Pages 2 0 R /Outlines 3 0 R >>",
      "<< /Type /Pages /Kids [4 0 R] /Count 1 >>",
      "<< /Type /Outlines /First 5 0 R /Last 7 0 R /Count 3 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] >>",
      "<< /Title (Home) /Parent 3 0 R /Dest [4 0 R /Fit] /Next 6 0 R >>",
      "<< /Title (Website) /Parent 3 0 R /A << /S /URI /URI (https://example.com/) >>" +
        " /Prev 5 0 R /Next 7 0 R >>",
      "<< /Title () /Parent 3 0 R /Dest (nowhere-at-all) /Prev 6 0 R >>",
    ]),
  );
  check(doc >= 1, "unresolved outline: the fixture opens", `got ${doc}`);
  const got = outlineOf(doc);
  check(typeof got === "object", "unresolved outline: ink_load_outline succeeds", `got ${got}`);

  equal(
    got.entries.map(rowOfEntry).join(" "),
    "0|Home|0 0|Website|- 0||-",
    "unresolved outline: an unfollowable entry is still a row, and a blank title still a row",
  );
  // Asserted on the key: `-1` and `null` would pass a value check.
  check(
    !("p" in got.entries[1]) && !("p" in got.entries[2]),
    "unresolved outline: `p` is absent, not -1 and not null",
    got.json,
  );
  check("p" in got.entries[0], "unresolved outline: ...while a resolvable entry keeps it");
  equal(got.entries[2].t, "", "unresolved outline: an empty title arrives as \"\"");
  e.ink_close(doc);
}

/* --- deeper than the emitted depth clamps rather than drops --- */
// Forty levels: all arrive, the last eight at depth 32.
{
  const levels = 40;
  const bodies = [
    "<< /Type /Catalog /Pages 2 0 R /Outlines 3 0 R >>",
    "<< /Type /Pages /Kids [4 0 R] /Count 1 >>",
    "<< /Type /Outlines /First 5 0 R /Last 5 0 R /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] >>",
  ];
  for (let i = 0; i < levels; i++) {
    const self = 5 + i;
    const child = i + 1 < levels ? ` /First ${self + 1} 0 R /Last ${self + 1} 0 R /Count 1` : "";
    const parent = i === 0 ? 3 : self - 1; // the root's parent is /Outlines itself
    bodies.push(`<< /Title (L${i}) /Parent ${parent} 0 R /Dest [4 0 R /Fit]${child} >>`);
  }
  const doc = openBytes(buildPdf(bodies));
  check(doc >= 1, "deep outline: the fixture opens", `got ${doc}`);
  const got = outlineOf(doc);
  check(typeof got === "object", "deep outline: ink_load_outline succeeds", `got ${got}`);

  equal(got.entries.length, levels, "deep outline: every nested entry is listed");
  equal(
    got.entries.map((o) => o.t).join(","),
    Array.from({ length: levels }, (_, i) => `L${i}`).join(","),
    "deep outline: in order, with none dropped",
  );
  equal(
    got.entries.map((o) => o.d).join(","),
    Array.from({ length: levels }, (_, i) => Math.min(i, 32)).join(","),
    "deep outline: the depth CLAMPS at 32 — the deep rows stay, flattened",
  );
  e.ink_close(doc);
}

/* --- refusals and hygiene -------------------------------------------------- */
{
  equal(e.ink_load_outline(0), -1n, "outline: handle 0 is refused");
  equal(e.ink_load_outline(-1), -1n, "outline: a negative handle is refused");
  equal(e.ink_load_outline(99), -1n, "outline: an out-of-range handle is refused");
  e.ink_outline_free();
  e.ink_outline_free();
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log(`pdf-decode.wasm OK — rendered ${width}x${height} RGBA from ${pdf.length} PDF bytes`);
