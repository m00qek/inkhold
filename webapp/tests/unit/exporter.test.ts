import { describe, it, expect, vi } from "vitest";
import {
  documentFilename,
  exportFilename,
  pageLinks,
  savedPdfMessage,
  toGray,
} from "../../src/export/exporter";
import type { Api } from "../../src/api/types";
import type { Id, PageRef } from "../../src/core/types";
import type { PdfLink } from "../../src/render/pdfWire";

describe("exportFilename", () => {
  it("drops the note's extension and names the page 1-based", () => {
    expect(exportFilename("Weekly review.note", 0, "png")).toBe("Weekly review-p1.png");
    expect(exportFilename("Weekly review.note", 4, "pdf")).toBe("Weekly review-p5.pdf");
  });

  it("keeps a name that has no extension", () => {
    expect(exportFilename("Weekly review", 0, "png")).toBe("Weekly review-p1.png");
  });

  // Note names are device-authored; a slash would read as a path in the save dialog.
  it("strips the characters a filename cannot carry", () => {
    expect(exportFilename("a/b\\c:d*e?f\"g<h>i|j.note", 0, "png")).toBe("a-b-c-d-e-f-g-h-i-j-p1.png");
  });

  it("falls back rather than producing a name that is only an extension", () => {
    expect(exportFilename(".note", 0, "pdf")).toBe("note-p1.pdf");
    expect(exportFilename("///", 0, "pdf")).toBe("note-p1.pdf");
  });
});

describe("documentFilename", () => {
  it("names the whole document after the note alone", () => {
    expect(documentFilename("Weekly review.note", "pdf")).toBe("Weekly review.pdf");
  });

  it("sanitises device-authored names the same way the page export does", () => {
    expect(documentFilename("a/b:c.note", "pdf")).toBe("a-b-c.pdf");
    expect(documentFilename(".note", "pdf")).toBe("note.pdf");
  });
});

const PAGE: PageRef = {
  index: 2,
  sourcePage: null,
  hash: "h" as unknown as PageRef["hash"],
  width: 1404,
  height: 1872,
  textHash: null,
};
const ID = "n-1" as unknown as Id;
const LINKS: PdfLink[] = [{ x: 1, y: 2, w: 3, h: 4, page: -1, uri: "https://example.com/" }];

function api(over: Record<string, unknown>): Api {
  return over as unknown as Api;
}

describe("pageLinks", () => {
  it("asks the endpoint for the page it was given, and hands back its links", async () => {
    const getPageLinks = vi.fn().mockResolvedValue({ links: LINKS });
    expect(await pageLinks(api({ getPageLinks }), ID, PAGE)).toEqual(LINKS);
    expect(getPageLinks).toHaveBeenCalledWith(ID, PAGE);
  });

  // Probed, not called: an `Api` without the endpoint yields a PDF without annotations.
  it("answers with no links at all when the client cannot serve them", async () => {
    expect(await pageLinks(api({}), ID, PAGE)).toEqual([]);
    expect(await pageLinks(api({ getPageLinks: "not a function" }), ID, PAGE)).toEqual([]);
  });

  it("swallows a failed request rather than costing the user their export", async () => {
    const dead = api({ getPageLinks: () => Promise.reject(new Error("offline")) });
    await expect(pageLinks(dead, ID, PAGE)).resolves.toEqual([]);
  });

  it("survives an answer that is not the shape it expects", async () => {
    await expect(pageLinks(api({ getPageLinks: () => Promise.resolve({}) }), ID, PAGE)).resolves.toEqual([]);
    await expect(pageLinks(api({ getPageLinks: () => Promise.resolve(null) }), ID, PAGE)).resolves.toEqual([]);
  });

  // Link rects are device panel pixels; a landscape page's effective dims are turned.
  it("refuses links for a raster that is not the page at its native size", async () => {
    const getPageLinks = vi.fn().mockResolvedValue({ links: LINKS });
    const a = api({ getPageLinks });
    expect(await pageLinks(a, ID, PAGE, { width: 1872, height: 1404 })).toEqual([]);
    expect(getPageLinks).not.toHaveBeenCalled();

    expect(await pageLinks(a, ID, PAGE, { width: 1404, height: 1872 })).toEqual(LINKS);
  });

  it("calls the endpoint AS a method, so a client that uses `this` still works", async () => {
    // Calling the bare reference would strip `this` from the client.
    const client = {
      base: "/note",
      getPageLinks(): Promise<{ links: PdfLink[] }> {
        return Promise.resolve({ links: this.base === "/note" ? LINKS : [] });
      },
    };
    expect(await pageLinks(api(client), ID, PAGE)).toEqual(LINKS);
  });
});

describe("toGray", () => {
  it("takes one channel per pixel from opaque grayscale RGBA", () => {
    // The decoder emits R == G == B, so the red channel is the luminance.
    const rgba = new Uint8ClampedArray([
      10, 10, 10, 255,
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

describe("savedPdfMessage", () => {
  it("answers whether the text can be selected, not how that was decided", () => {
    const raster = savedPdfMessage("notes.pdf", "raster");
    expect(raster).toContain("cannot be selected or searched");
    expect(raster).not.toMatch(/verified|placement|device|raster/i);

    const searchable = savedPdfMessage("notes.pdf", "searchable");
    expect(searchable).toContain("can be selected and searched");
  });

  it("names the file in both, and says nothing about a count for a single page", () => {
    expect(savedPdfMessage("page-p3.pdf", "searchable")).toContain("page-p3.pdf");
    expect(savedPdfMessage("page-p3.pdf", "searchable")).not.toMatch(/\bpages\b/);
  });

  it("counts pages, and does not say '1 pages'", () => {
    expect(savedPdfMessage("n.pdf", "raster", 1703)).toContain("1703 pages");
    expect(savedPdfMessage("n.pdf", "raster", 1)).toContain("1 page.");
    expect(savedPdfMessage("n.pdf", "raster", 1)).not.toContain("1 pages");
  });

  it("does not call a 1703-page export 'an image'", () => {
    expect(savedPdfMessage("n.pdf", "raster", 1703)).toContain("The pages are images");
    expect(savedPdfMessage("n.pdf", "raster", 1)).toContain("The page is an image");
    expect(savedPdfMessage("n.pdf", "raster")).toContain("The page is an image");
  });
});
