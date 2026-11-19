// The annotated-PDF export burns in the pages whose ink decodes and skips the
// rest: one corrupt `.mark` page must not cost the whole document.

import { afterEach, describe, expect, it, vi } from "vitest";
import { createPdfViewerExports } from "../../src/pages/pdf/pdfViewerExports";
import type { NoteLayersController } from "../../src/pages/noteLayers";
import type { Hash, Id, NoteMeta, PageRef } from "../../src/core/types";
import type { PdfSession } from "../../src/render/pdfClient";

const ref = (index: number): PageRef => ({
  index,
  hash: `ink${index}` as Hash,
  width: 1404,
  height: 1872,
  textHash: null,
  linksHash: null,
  sourcePage: index + 1,
});

function exportsWith(inkRaster: NoteLayersController["inkRaster"]) {
  const annotatePage = vi.fn(async () => {});
  const session = {
    pageSize: async () => ({ width: 595, height: 842 }),
    annotatePage,
    exportDocument: async () => new Uint8Array(0),
  } as unknown as PdfSession;
  const marks = new Map([
    [0, ref(0)],
    [1, ref(1)],
  ]);
  const ex = createPdfViewerExports({
    deps: { getTheme: () => "light", api: { getPageBytes: async () => new ArrayBuffer(8) } },
    state: {
      session: () => session,
      isOpen: () => true,
      generation: () => 1,
      pageIndex: () => 0,
      pageCount: () => 2,
      meta: () => ({ id: "7", fileHash: "abc" }) as unknown as NoteMeta,
      fromBin: () => false,
      markId: () => "8" as Id,
      markPages: () => marks,
    },
    dom: { canvas: {} as HTMLCanvasElement, markCtl: { inkRaster } as unknown as NoteLayersController },
  });
  return { ex, annotatePage };
}

afterEach(() => vi.unstubAllGlobals());

describe("exportDocumentPdf", () => {
  it("skips a page whose ink will not decode, and says so only when none would", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: true, blob: async () => new Blob(["%PDF-"]) }));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const inkRaster = vi.fn(async () => {
      throw new Error("this ink layer would not decode");
    });
    const { ex, annotatePage } = exportsWith(inkRaster);
    const progress: number[] = [];

    await expect(ex.exportDocumentPdf((done) => progress.push(done))).rejects.toThrow(
      "none of the annotated pages would decode",
    );
    // Both pages were tried: the first failure did not end the walk.
    expect(inkRaster).toHaveBeenCalledTimes(2);
    expect(progress).toEqual([1, 2]);
    expect(annotatePage).not.toHaveBeenCalled();
  });
});
