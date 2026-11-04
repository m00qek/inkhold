// @vitest-environment happy-dom
// The .pdf viewer past the shared viewer seam.

import { describe, it, expect, vi } from "vitest";
import { createPdfViewer, type PdfSeam } from "../../src/pages/pdf/pdfViewer";
import type { ViewerDeps } from "../../src/pages/viewer/viewer";
import { FIT_PAGE } from "../../src/pages/viewer/viewerControls";
import type { NoteMeta } from "../../src/core/types";
import { synthesizeSummary } from "../../src/pages/library/library";
import { deps, meta, INERT_PDF_SEAM, FOLDER } from "./viewerStubs.shared";

describe(".pdf viewer, past the shared seam", () => {
  it("publishes the page it is on, so a PDF page has an address", async () => {
    const onPosition = vi.fn();
    const v = createPdfViewer(deps({ onPosition }), INERT_PDF_SEAM);
    document.body.append(v.el);
    const m = meta({ id: "n-doc", fileType: "pdf" });
    await v.open(synthesizeSummary(m), Promise.resolve(m), 0, FOLDER, "");

    onPosition.mockClear();
    // The arrow key, not the pager button: under happy-dom the buttons stay disabled.
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
    await new Promise((r) => setTimeout(r, 0));

    expect(onPosition).toHaveBeenCalled();
    const [id, page, query] = onPosition.mock.calls.at(-1)!;
    expect(id).toBe("n-doc");
    expect(page).toBe(1);
    expect(query).toBe("");
    v.destroy();
  });

  it("publishes the BIN address for a trashed file, not the live one", async () => {
    // A trashed blob is not served from `#/note/:id`, so that address would 404 on reload.
    const onPosition = vi.fn();
    const v = createPdfViewer(deps({ onPosition }), INERT_PDF_SEAM);
    document.body.append(v.el);
    const m = meta({ id: "n-gone", fileType: "pdf" });
    await v.open(synthesizeSummary(m), Promise.resolve(m), 0, { kind: "bin", folderPath: null }, "");

    onPosition.mockClear();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
    await new Promise((r) => setTimeout(r, 0));

    expect(onPosition.mock.calls.at(-1)![4]).toBe(true);
    v.destroy();
  });

  it("a new document resets the zoom READOUT, not just the scale behind it", async () => {
    // Regression: `open` reset zoom to `Fit ⇕` but the stepper kept the last document's label.
    const v = createPdfViewer(deps(), INERT_PDF_SEAM);
    document.body.append(v.el);
    const zoomIn = v.el.querySelector('[aria-label="Zoom in"]') as HTMLButtonElement;
    const readout = zoomIn.parentElement!.querySelector(".pdf-zoom") as HTMLElement;

    const first = meta({ id: "n-first", fileType: "pdf" });
    await v.open(synthesizeSummary(first), Promise.resolve(first), 0, FOLDER, "");
    expect(readout.textContent).toBe(FIT_PAGE);

    zoomIn.click();
    zoomIn.click();
    expect(readout.textContent).not.toBe(FIT_PAGE);

    const second = meta({ id: "n-second", fileType: "pdf" });
    await v.open(synthesizeSummary(second), Promise.resolve(second), 0, FOLDER, "");
    expect(readout.textContent).toBe(FIT_PAGE);
    v.destroy();
  });

  it("exports render the page FRESH, at the export's OWN scale — never the screen's", async () => {
    // An export decodes, never screenshots the on-screen canvas; asserted on the scale.
    const renders: { page: number; scale: number }[] = [];
    const seam: PdfSeam = {
      supported: () => true,
      createSession: () => ({
        open: () => Promise.resolve({ pageCount: 2, mode: "whole" as const }),
        pageSize: () => Promise.resolve({ width: 200, height: 100 }),
        pageLinks: () => Promise.resolve([]),
        outline: () => Promise.resolve([]),
        render: (page: number, scale: number) => {
          renders.push({ page, scale });
          return Promise.resolve({
            bitmap: { close: () => {} } as unknown as ImageBitmap,
            width: 400,
            height: 200,
          });
        },
        stats: () => Promise.resolve({ mode: "whole" as const, cache: null }),
        close: () => Promise.resolve(),
        destroy: () => {},
      }),
    };
    const v = createPdfViewer(deps(), seam);
    document.body.append(v.el);
    const m = meta({ id: "n-1", fileType: "pdf" });
    await v.open(synthesizeSummary(m), Promise.resolve(m), 0, FOLDER, "");

    const onScreen = renders.map((r) => r.scale);
    expect(onScreen.length).toBeGreaterThan(0);

    renders.length = 0;
    (v.el.querySelector('[aria-label="Download"]') as HTMLButtonElement).click();
    const flat = Array.from(v.el.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find(
      (b) => b.querySelector("span")!.textContent === "Flattened image",
    )!;
    flat.click();
    await vi.waitFor(() => expect(renders).toHaveLength(1));

    // 2x the PDF's own 72 dpi, not the fit scale.
    expect(renders[0]).toEqual({ page: 0, scale: 2 });
    for (const s of onScreen) expect(s).not.toBe(2);
    v.destroy();
  });

  it("the per-page PDF asks the DECODER for the page — it never rasters one", async () => {
    const renders: number[] = [];
    const exports: { page: number; ink: { width: number; height: number; matrix: readonly number[] } }[] = [];
    const seam: PdfSeam = {
      supported: () => true,
      createSession: () => ({
        open: () => Promise.resolve({ pageCount: 2, mode: "whole" as const }),
        // 200 x 100 pt: the page's own units.
        pageSize: () => Promise.resolve({ width: 200, height: 100 }),
        pageLinks: () => Promise.resolve([]),
        outline: () => Promise.resolve([]),
        render: (page: number) => {
          renders.push(page);
          return Promise.resolve({
            bitmap: { close: () => {} } as unknown as ImageBitmap,
            width: 400,
            height: 200,
          });
        },
        exportPage: (page, ink) => {
          exports.push({ page, ink });
          return Promise.resolve(new Uint8Array([0x25, 0x50, 0x44, 0x46]));
        },
        annotatePage: () => Promise.resolve(),
        exportDocument: () => Promise.resolve(new Uint8Array([0x0a])),
        stats: () => Promise.resolve({ mode: "whole" as const, cache: null }),
        close: () => Promise.resolve(),
        destroy: () => {},
      }),
    };
    const v = createPdfViewer(deps(), seam);
    document.body.append(v.el);
    const m = meta({ id: "n-1", fileType: "pdf" });
    await v.open(synthesizeSummary(m), Promise.resolve(m), 0, FOLDER, "");

    renders.length = 0;
    const clicks = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    (v.el.querySelector('[aria-label="Download"]') as HTMLButtonElement).click();
    const pdfRow = Array.from(v.el.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find(
      (b) => b.querySelector("span")?.textContent === "PDF document",
    )!;
    pdfRow.click();
    await vi.waitFor(() => expect(exports).toHaveLength(1));
    clicks.mockRestore();

    expect(renders).toEqual([]);
    expect(exports[0]!.page).toBe(0);
    expect(exports[0]!.ink).toMatchObject({ width: 1, height: 1 });
    expect(exports[0]!.ink.matrix).toEqual([200, 0, 0, 100, 0, 0]);
    v.destroy();
  });

  it("the whole-document export reads the original as a BLOB, never into memory", async () => {
    // The original is fetched as `res.blob()` (disk-backed), never `arrayBuffer()`; the
    // stub throws on the wrong call. No decodable ink means no export.
    const took: string[] = [];
    const original = new Blob([new Uint8Array([0x25, 0x50, 0x44, 0x46])]);
    const fetched: string[] = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      fetched.push(String(input));
      // Only the raw-file route is stubbed as a body; `/note-decode.wasm` reads an ArrayBuffer.
      if (!String(input).includes("/file/")) {
        return Promise.resolve({ ok: false, status: 404 } as unknown as Response);
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        blob: () => {
          took.push("blob");
          return Promise.resolve(original);
        },
        arrayBuffer: () => {
          took.push("arrayBuffer");
          throw new Error("the original must never be read into the heap");
        },
      } as unknown as Response);
    });
    const lent: Blob[] = [];
    const seam: PdfSeam = {
      supported: () => true,
      createSession: () => ({
        open: () => Promise.resolve({ pageCount: 3, mode: "stream" as const }),
        pageSize: () => Promise.resolve({ width: 200, height: 100 }),
        pageLinks: () => Promise.resolve([]),
        outline: () => Promise.resolve([]),
        render: () =>
          Promise.resolve({
            bitmap: { close: () => {} } as unknown as ImageBitmap,
            width: 400,
            height: 200,
          }),
        exportPage: () => Promise.reject(new Error("not this row")),
        annotatePage: () => Promise.resolve(),
        exportDocument: (blob: Blob) => {
          lent.push(blob);
          return Promise.resolve(new Uint8Array([0x0a]));
        },
        stats: () => Promise.resolve({ mode: "stream" as const, cache: null }),
        close: () => Promise.resolve(),
        destroy: () => {},
      }),
    };
    const toast = vi.fn();
    const api = {
      getNoteMeta: () =>
        Promise.resolve(
          meta({
            id: "mark-1",
            fileType: "mark",
            pages: [
              { index: 0, hash: "h1", width: 1404, height: 1872, sourcePage: 1, layers: [] },
              { index: 1, hash: "h2", width: 1404, height: 1872, sourcePage: 3, layers: [] },
            ] as unknown as NoteMeta["pages"],
          }),
        ),
      getPageBytes: () => Promise.resolve(new ArrayBuffer(8)),
    } as unknown as ViewerDeps["api"];
    const v = createPdfViewer(deps({ api, toast }), seam);
    document.body.append(v.el);
    const m = meta({ id: "n-1", fileType: "pdf", annotationsId: "mark-1" } as Partial<NoteMeta>);
    await v.open(synthesizeSummary(m), Promise.resolve(m), 0, FOLDER, "");
    (v.el.querySelector('[aria-label="Download"]') as HTMLButtonElement).click();
    const rowOf = (label: string) =>
      Array.from(v.el.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find(
        (b) => b.querySelector("span")?.textContent === label,
      )!;
    await vi.waitFor(() => expect(rowOf("PDF with annotations").hidden).toBe(false));

    rowOf("PDF with annotations").click();
    await vi.waitFor(() =>
      expect(toast).toHaveBeenCalledWith("Couldn't build that export. Try again."),
    );

    expect(fetched[0]).toContain("/file/n-1");
    expect(took).toEqual(["blob"]);
    expect(lent).toEqual([]);
    fetchSpy.mockRestore();
    v.destroy();
  });
});
