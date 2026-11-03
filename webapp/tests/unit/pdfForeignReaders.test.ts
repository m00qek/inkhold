import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPdf, type PdfPage } from "../../src/export/pdf";
import type { PdfLink } from "../../src/render/pdfWire";

// Real readers check the file: links are direct dictionaries in the page object,
// which the spec permits but convention doesn't. Poppler resolves internal targets;
// Ghostscript reports external URIs. Skipped where the binaries are absent.

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

// An unbalanced `)`: balanced parentheses are legal unescaped and prove nothing.
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
    // pdfinfo exits non-zero on a file it had to repair.
  });

  it("has poppler resolve the internal link to the page it points at", () => {
    const xml = execFileSync("pdftohtml", ["-xml", "-stdout", "-i", file], { encoding: "utf8" });
    expect(xml).toContain("link to page 3");
  });

  it("has Ghostscript re-emit the external links it read out of the page dictionary", () => {
    expect(gs).toContain("/URI(https://example.com/a\\)b?q=1)");
    expect(gs).toContain("/URI(mailto:a@b.c)");
  });

  it("has Ghostscript decode the UTF-16BE URI rather than mangling its bytes", () => {
    // `\376\377` is the BOM: gs read the hex string as text, not Latin-1.
    expect(gs).toContain("\\376\\377");
    expect(gs).toContain("\\000e\\000x\\000\\341\\000m\\000p\\000l\\000e");
  });

  it("has Ghostscript resolve the destination to a page of its own document", () => {
    const dest = /\/Dest \[(\d+) 0 R/.exec(gs);
    expect(dest).not.toBeNull();
    // Renumbered by gs, so it followed the reference rather than copying bytes.
    expect(gs).toMatch(new RegExp(`${dest![1]} 0 obj\\s*<</Type\\s*/Page`));
  });

  it("carries no trace of the refused scheme into anybody's reader", () => {
    expect(gs).not.toContain("javascript");
    expect(execFileSync("pdfinfo", [file], { encoding: "utf8" })).toMatch(/^JavaScript:\s+no$/m);
  });
});
