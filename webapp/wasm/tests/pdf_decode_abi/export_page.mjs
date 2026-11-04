// The per-page export (`ink_export_page`): geometry and refusals.

import fs from "node:fs";
import { check, e, equal, pdfPath } from "./harness.mjs";
import { coverage, openBytes, roundTrip, tinyPdf } from "./fixtures.mjs";

// --- upright, with a half-tone patch ---
// Coverage is 100x50, not the page's size, so `2 0 0 2 0 0` does real work.
export const upright = roundTrip("upright", {
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
