// Whole-document export (`ink_annotate_page` + `ink_export_incremental`).

import { check, e, equal, host, savedFixture } from "./harness.mjs";
import { dark, packed } from "./render.mjs";
import { sdoc } from "./stream.mjs";
import { annotatedPdf, buildPdf, coverage, openBytes, renderCopy, within } from "./fixtures.mjs";

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
check(/\/Annots/.test(source.toString("latin1")), "the host.fixture really has /Annots");

const wdoc2 = openBytes(source);
check(wdoc2 >= 1, "the annotated host.fixture opens", `got ${wdoc2}`);
const beforePages = [0, 1, 2].map((p) => renderCopy(wdoc2, p, 1));
check(
  beforePages.every((f) => f && f.w === 200 && f.h === 100),
  "the host.fixture's three pages render",
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
  check(sdoc >= 1, "the shared-resources host.fixture opens", `got ${sdoc}`);
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
  check(idoc >= 1, "the inherited-resources host.fixture opens", `got ${idoc}`);
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
check(!sound.equals(broken), "the repair host.fixture really is corrupted");
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
  host.fixture = annotatedPdf(3);
  check(host.fixture.equals(source), "the streamed run uses the same bytes as the buffered one");
  const sdoc3 = e.ink_open_stream(BigInt(host.fixture.length));
  check(sdoc3 >= 1, "the annotated host.fixture opens as a stream", `got ${sdoc3}`);
  equal(annotate(sdoc3, 1, mask, 100, 50, [2, 0, 0, 2, 0, 0]), 0, "annotate over the stream");
  const streamDelta = takeExport(e.ink_export_incremental(sdoc3));
  check(streamDelta !== null, "the streamed incremental export succeeds", errorText());
  if (streamDelta) {
    // Length, not bytes: the trailer's /ID differs per write.
    equal(streamDelta.length, delta.length, "the streamed delta is the same size");
    const sWhole = Buffer.concat([host.fixture, streamDelta]);
    const sOut = openBytes(sWhole);
    check(sOut >= 1, "the streamed concatenation opens", `got ${sOut}`);
    equal(e.ink_page_count(sOut), 3, "...with all three pages");
    e.ink_close(sOut);
  }
  e.ink_close(sdoc3);

  // A source that goes short mid-file (a host answering 0) must be refused, not
  // yield a delta with wrong offsets.
  host.fixture = annotatedPdf(3, [0, 0, 200, 100], 40 * 1024);
  const zdoc = e.ink_open_stream(BigInt(host.fixture.length));
  check(zdoc >= 1, "the stream opens before the host goes short", `got ${zdoc}`);
  equal(annotate(zdoc, 1, mask, 100, 50, [2, 0, 0, 2, 0, 0]), 0, "annotate before the host fails");
  host.zeroFrom = 32 * 1024;
  equal(e.ink_export_incremental(zdoc), -2n, "a truncated original fails the write");
  host.zeroFrom = Infinity;
  e.ink_close(zdoc);

  host.fixture = savedFixture;
}
