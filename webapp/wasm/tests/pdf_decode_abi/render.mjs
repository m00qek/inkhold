// Opening a buffer, rendering real pixels, and the error path.

import { check, e, equal, pdf } from "./harness.mjs";

const buf = e.ink_alloc(pdf.length);
check(buf !== 0, "ink_alloc returned a buffer");
new Uint8Array(e.memory.buffer, buf, pdf.length).set(pdf);

export const doc = e.ink_open(buf, pdf.length); // no magic: MuPDF sniffs the content
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

export const scale = 2;
export const packed = e.ink_render(doc, 0, scale);
check(packed > 0n, "ink_render succeeded", `got ${packed}`);
const ptr = Number(packed >> 32n);
const len = Number(packed & 0xffffffffn);
export const width = e.ink_render_width();
export const height = e.ink_render_height();
equal(width, 400, "rendered width (200pt @ 2x)");
equal(height, 200, "rendered height (100pt @ 2x)");
equal(len, width * height * 4, "packed length matches w*h*4 (RGBA)");

export const px = new Uint8Array(e.memory.buffer, ptr, len);

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

export let dark = 0;
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
