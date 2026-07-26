import { describe, it, expect } from "vitest";
import { documentFilename, exportFilename, toGray } from "../../src/export/exporter";

// The exporter's pure halves. The canvas/blob path is browser-only and is
// covered by the reader e2e specs; these are the two pieces that decide what
// lands on someone's disk and what goes into the PDF's image stream.

describe("exportFilename", () => {
  it("drops the note's extension and names the page 1-based", () => {
    expect(exportFilename("Weekly review.note", 0, "png")).toBe("Weekly review-p1.png");
    expect(exportFilename("Weekly review.note", 4, "pdf")).toBe("Weekly review-p5.pdf");
  });

  it("keeps a name that has no extension", () => {
    expect(exportFilename("Weekly review", 0, "png")).toBe("Weekly review-p1.png");
  });

  // Note names are DEVICE-AUTHORED. A slash in one would otherwise reach the
  // download attribute and be read as a path by the save dialog.
  it("strips the characters a filename cannot carry", () => {
    expect(exportFilename("a/b\\c:d*e?f\"g<h>i|j.note", 0, "png")).toBe("a-b-c-d-e-f-g-h-i-j-p1.png");
  });

  it("falls back rather than producing a name that is only an extension", () => {
    expect(exportFilename(".note", 0, "pdf")).toBe("note-p1.pdf");
    expect(exportFilename("///", 0, "pdf")).toBe("note-p1.pdf");
  });
});

describe("documentFilename", () => {
  // A whole-notebook export carries NO page suffix — that is what distinguishes
  // it on disk from the single-page one beside it.
  it("names the whole document after the note alone", () => {
    expect(documentFilename("Weekly review.note", "pdf")).toBe("Weekly review.pdf");
  });

  it("sanitises device-authored names the same way the page export does", () => {
    expect(documentFilename("a/b:c.note", "pdf")).toBe("a-b-c.pdf");
    expect(documentFilename(".note", "pdf")).toBe("note.pdf");
  });
});

describe("toGray", () => {
  it("takes one channel per pixel from opaque grayscale RGBA", () => {
    // The decoder emits R == G == B, so the red channel IS the luminance.
    const rgba = new Uint8ClampedArray([
      10, 10, 10, 255, //
      200, 200, 200, 255,
      0, 0, 0, 255,
      255, 255, 255, 255,
    ]);
    expect([...toGray(rgba, 2, 2)]).toEqual([10, 200, 0, 255]);
  });

  it("returns exactly one byte per pixel", () => {
    const rgba = new Uint8ClampedArray(7 * 5 * 4).fill(0x80);
    expect(toGray(rgba, 7, 5)).toHaveLength(35);
  });
});
