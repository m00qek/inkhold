// Builders for synthetic PDFs and the export round-trip helpers.

import { check, e, equal } from "./harness.mjs";
import { packed, px, scale } from "./render.mjs";

// ---- the export round trip (`ink_export_page`) ----
// One page at the source's point size; untouched pixels byte-identical to the
// source; ink dark exactly where the matrix put it in display space (a
// misplaced ink keeps the same dark-pixel count, so position is checked).

/** Renders `page` and copies the pixels out (the module's buffer is reused). */
export function renderCopy(handle, page, scale) {
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
export function buildPdf(bodies) {
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

export function tinyPdf(mediaBox, extra, content) {
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
export function annotatedPdf(count, mediaBox = [0, 0, 200, 100], padBytes = 0) {
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

export function openBytes(bytes) {
  const at = e.ink_alloc(bytes.length);
  new Uint8Array(e.memory.buffer, at, bytes.length).set(bytes);
  return e.ink_open(at, bytes.length);
}

export function coverage(w, h, boxes) {
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

export function within(boxes, x, y, slack) {
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
export function roundTrip(label, t) {
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
