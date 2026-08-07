import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPdf, type PdfPage } from "../../src/export/pdf";
import type { PdfLink } from "../../src/render/pdfLinks";

// THE ONLY ASSERTION THAT SETTLES THE QUESTION. Everywhere else in this suite
// the writer is checked against our own reading of the bytes, which proves the
// writer agrees with itself and nothing about the file someone else opens — and
// the file someone else opens is the entire point of an export.
//
// It matters most for the LINKS, because they are written as DIRECT dictionaries
// in the page object rather than as annotation objects. The spec permits that;
// convention is indirect, and conventions are what implementations actually
// test. So two independent readers are asked, and between them they cover both
// kinds of link:
//
//   * POPPLER (`pdfinfo`, `pdftohtml`) — the engine behind most Linux viewers.
//     Its XML output names the resolved TARGET PAGE of an internal link, which
//     is the forward reference proved from outside.
//   * GHOSTSCRIPT — reads the document and writes a new one, so an annotation it
//     did not parse simply does not appear in its output. It is the only tool
//     here that reports EXTERNAL URIs.
//
// SKIPPED, not failed, where the binaries are absent: a developer without
// poppler installed still gets the rest of the suite, and the machine that has
// them runs this on every change.

function has(bin: string): boolean {
  try {
    execFileSync("which", [bin], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const READERS = has("pdfinfo") && has("pdftohtml") && has("gs");

const W = 1404;
const H = 1872;

/** A page of white, carrying `links`. */
function page(links: PdfLink[]): PdfPage {
  return { width: W, height: H, gray: new Uint8Array(W * H).fill(0xff), links };
}

// An UNBALANCED bracket, deliberately. A PDF literal string may contain BALANCED
// parentheses unescaped, so `a(b)` proves nothing about escaping — a reader
// parses it either way. A lone `)` is the one that ends the string early and
// leaves the rest of the URI as stray tokens inside the page dictionary.
const EXTERNAL = "https://example.com/a)b?q=1";
const UNICODE = "https://exámple.com/ç";

const LINKS: PdfLink[] = [
  { x: 100, y: 60, w: 400, h: 90, page: -1, uri: EXTERNAL },
  // Page index 2 = the third page, which is where poppler must say it goes.
  { x: 700, y: 1600, w: 300, h: 80, page: 2, uri: "" },
  { x: 100, y: 900, w: 200, h: 50, page: -1, uri: UNICODE },
  { x: 100, y: 1000, w: 200, h: 50, page: -1, uri: "mailto:a@b.c" },
  { x: 100, y: 1100, w: 200, h: 50, page: -1, uri: "javascript:alert(1)" },
];

describe.skipIf(!READERS)("the exported file, read by somebody else's reader", () => {
  let dir = "";
  let file = "";
  /** Ghostscript's rewrite of our file — what IT understood, in its own words. */
  let gs = "";

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "inkhold-pdf-"));
    file = join(dir, "linked.pdf");
    const blob = await buildPdf([page(LINKS), page([]), page([])], { pageCount: 3 });
    writeFileSync(file, Buffer.from(await blob.arrayBuffer()));

    const out = join(dir, "gs.pdf");
    execFileSync(
      "gs",
      ["-q", "-dNOPAUSE", "-dBATCH", "-sDEVICE=pdfwrite", "-dCompressStreams=false", "-o", out, file],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    gs = readFileSync(out, "latin1");
  }, 30_000);

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("opens, at the page count and page size it claims", () => {
    const info = execFileSync("pdfinfo", [file], { encoding: "utf8" });
    expect(info).toMatch(/^Pages:\s+3$/m);
    expect(info).toMatch(/^Page size:\s+595\.28 x 793\.71 pts$/m);
    // pdfinfo exits non-zero on a file it had to repair, so getting here at all
    // is half the assertion.
  });

  // THE FORWARD REFERENCE, PROVED FROM OUTSIDE. Poppler resolved `10 0 R` — an
  // object our writer named before it had written it — to the third page.
  it("has poppler resolve the internal link to the page it points at", () => {
    const xml = execFileSync("pdftohtml", ["-xml", "-stdout", "-i", file], { encoding: "utf8" });
    expect(xml).toContain("link to page 3");
  });

  it("has Ghostscript re-emit the external links it read out of the page dictionary", () => {
    // Ghostscript writes its own file from what it parsed, so an inline
    // annotation it ignored would be absent here. The bracket survived escaping.
    expect(gs).toContain("/URI(https://example.com/a\\)b?q=1)");
    expect(gs).toContain("/URI(mailto:a@b.c)");
  });

  it("has Ghostscript decode the UTF-16BE URI rather than mangling its bytes", () => {
    // `\376\377` is the BOM, and each character follows as two bytes — i.e. gs
    // recognised the hex string as text and not as a Latin-1 literal.
    expect(gs).toContain("\\376\\377");
    expect(gs).toContain("\\000e\\000x\\000\\341\\000m\\000p\\000l\\000e");
  });

  it("has Ghostscript resolve the destination to a page of its own document", () => {
    const dest = /\/Dest \[(\d+) 0 R/.exec(gs);
    expect(dest).not.toBeNull();
    // Renumbered by gs, which is exactly what proves it followed the reference
    // rather than copying our bytes through.
    expect(gs).toMatch(new RegExp(`${dest![1]} 0 obj\\s*<</Type\\s*/Page`));
  });

  it("carries no trace of the refused scheme into anybody's reader", () => {
    expect(gs).not.toContain("javascript");
    expect(execFileSync("pdfinfo", [file], { encoding: "utf8" })).toMatch(/^JavaScript:\s+no$/m);
  });
});
