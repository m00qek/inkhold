// The page's links (`ink_page_links`).

import fs from "node:fs";
import { check, e, equal, host, pdfPath, savedFixture } from "./harness.mjs";
import { doc, packed } from "./render.mjs";
import { buildPdf, openBytes } from "./fixtures.mjs";
import { upright } from "./export_page.mjs";

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

  host.fixture = linkedPdf([0, 0, 200, 100], "", LINK_ANNOTS);
  const sdocL = e.ink_open_stream(BigInt(host.fixture.length));
  check(sdocL >= 1, "links: the fixture opens as a stream", `got ${sdocL}`);
  equal(pageLinks(sdocL, 0).json, got.json, "links: the streamed answer is byte-identical");
  e.ink_close(sdocL);
  host.fixture = savedFixture;

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
