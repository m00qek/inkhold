// @vitest-environment happy-dom
// The PDF export menu and its per-page and whole-document exports.

import { describe, it, expect, vi } from "vitest";
import { composeMarkExportModel, createPdfExports, type PdfExportState } from "../../src/pages/pdf/pdfExports";
import { type LayeredExportModel } from "../../src/export/layered";
import { createViewerExportMenu } from "../../src/pages/viewer/viewerExportMenu";
import type { PdfInkOverlay } from "../../src/render/pdfClient";

// --- fakes ------------------------------------------------------------------
import { recorder, A4, MAIN, tinyModel } from "./pdfExports.shared";

/** The menu, its policy, and handles on everything it was given. */
function mount(state: PdfExportState, over: Partial<Parameters<typeof createPdfExports>[0]> = {}) {
  const toast = vi.fn();
  const release = vi.fn();
  const menu = createViewerExportMenu({ toast, className: "viewer__export" });
  document.body.append(menu.el);
  // One recorder for the whole mount, so composed ink reaches the mask.
  const { make } = recorder();
  // Small, because the PDF row really reads every pixel of the mask.
  const model: LayeredExportModel = composeMarkExportModel({
    space: { width: 4, height: 3, dx: 0, dy: 0 },
    page: null,
    pageVisible: true,
    ink: [MAIN],
    makeCanvas: make,
  });
  /** Every `{page, ink}` the decoder was asked for. */
  const grafts: { page: number; ink: PdfInkOverlay }[] = [];
  /** Every whole-document export run, by the progress sink it was handed. */
  const documentExports: ((done: number, total: number) => void)[] = [];
  /** Which `model()` options each export asked for — `withPage` is the interesting one. */
  const asked: (Parameters<Parameters<typeof createPdfExports>[0]["model"]>[0] | undefined)[] = [];
  const exports = createPdfExports({
    menu,
    toast,
    docName: () => "Appliance manual.pdf",
    pageIndex: () => 1,
    model: (opts) => {
      asked.push(opts);
      return Promise.resolve({ model, pagePt: A4, release });
    },
    exportPagePdf: (page, ink) => {
      grafts.push({ page, ink });
      return Promise.resolve(new Uint8Array([0x25, 0x50, 0x44, 0x46]));
    },
    exportDocumentPdf: (onProgress) => {
      documentExports.push(onProgress);
      onProgress(1, 2);
      onProgress(2, 2);
      return Promise.resolve({
        blob: new Blob([new Uint8Array([0x25, 0x50, 0x44, 0x46])]),
        pages: 2,
      });
    },
    state: () => state,
    makeCanvas: make,
    ...over,
  });
  exports.refreshGroups();
  const rows = (): HTMLButtonElement[] =>
    Array.from(menu.pop.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
  const visibleRows = (): string[] =>
    rows()
      .filter((b) => !b.hidden && !(b.parentElement as HTMLElement).hidden)
      .map((b) => b.querySelector("span")!.textContent!);
  const visibleHeads = (): string[] =>
    Array.from(menu.pop.querySelectorAll<HTMLElement>(".menu__head"))
      .filter((h) => !(h.parentElement as HTMLElement).hidden)
      .map((h) => h.textContent!);
  /** A visible row by its label, within the group whose head starts with `head`. */
  const row = (head: string, label: string): HTMLButtonElement =>
    Array.from(menu.pop.querySelectorAll<HTMLElement>(":scope > div"))
      .filter((g) => (g.querySelector(".menu__head")?.textContent ?? "").startsWith(head))
      .flatMap((g) => Array.from(g.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')))
      .find((b) => b.querySelector("span")!.textContent === label)!;
  return { menu, exports, toast, release, rows, row, visibleRows, visibleHeads, grafts, asked, documentExports };
}

/** The page in front of you, in the state most tests want it. */
const PAGE: PdfExportState = {
  hasInk: false,
  tuned: false,
  pageVisible: true,
  markedPages: 0,
};

describe("the PDF export menu", () => {
  it("offers the page's flattened image, its PDF, and the raw file on a bare page", () => {
    // No ink: the ORA folds away, but the per-page PDF stays (the page with selectable text).
    const m = mount({ ...PAGE });
    expect(m.visibleHeads()).toEqual(["This page — Current view", "Whole document"]);
    expect(m.visibleRows()).toEqual(["Flattened image", "PDF document", "PDF document"]);
  });

  it("adds the layered image once the page HAS ink", () => {
    const m = mount({ ...PAGE, hasInk: true });
    expect(m.visibleHeads()).toEqual(["This page — Current view", "Whole document"]);
    expect(m.visibleRows()).toEqual([
      "Flattened image",
      "Layered image",
      "PDF document",
      "PDF document",
    ]);
  });

  it("adds the whole ORIGINAL group only once something is toggled", () => {
    const m = mount({ ...PAGE, hasInk: true, tuned: true });
    expect(m.visibleHeads()).toEqual([
      "This page — Current view",
      "This page — Original view",
      "Whole document",
    ]);
    expect(m.visibleRows()).toEqual([
      "Flattened image",
      "Layered image",
      "PDF document",
      "Flattened image",
      "Layered image",
      "PDF document",
      "PDF document",
    ]);
  });

  it("re-reads the live state on every refresh, rather than snapshotting it", () => {
    const st: PdfExportState = { ...PAGE };
    const m = mount(st, { state: () => st });
    expect(m.visibleRows()).not.toContain("Layered image");
    st.hasInk = true;
    st.tuned = true;
    m.exports.refreshGroups();
    expect(m.visibleHeads()).toContain("This page — Original view");
  });

  it("hides the ORIGINAL group's layered row too, when the page has no ink", () => {
    const m = mount({ ...PAGE, tuned: true });
    expect(m.visibleHeads()).toContain("This page — Original view");
    expect(m.visibleRows()).toEqual([
      "Flattened image",
      "PDF document",
      "Flattened image",
      "PDF document",
      "PDF document",
    ]);
  });

  it("drops the CURRENT-view PDF row when the document itself is turned off", () => {
    // A row that cannot mean anything for the current page is hidden, not disabled.
    const m = mount({ hasInk: true, tuned: true, pageVisible: false, markedPages: 0 });
    expect(m.visibleRows()).toEqual([
      "Flattened image",
      "Layered image",
      "Flattened image",
      "Layered image",
      "PDF document",
      "PDF document",
    ]);
    expect(m.row("This page — Current view", "PDF document").hidden).toBe(true);
    expect(m.row("This page — Original view", "PDF document").hidden).toBe(false);
  });

  it("names an export after the document and the 1-BASED page, and says so", async () => {
    const m = mount({ ...PAGE, hasInk: true });
    const clicks = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const ora = m.rows().find((b) => b.querySelector("span")!.textContent === "Layered image")!;
    ora.click();
    await vi.waitFor(() => expect(m.toast).toHaveBeenCalled());
    clicks.mockRestore();

    expect(m.toast).toHaveBeenCalledWith("Saved Appliance manual_p2_current.ora");
    expect(m.release).toHaveBeenCalledTimes(1);
  });

  it("releases the model even when the export itself fails", async () => {
    const release = vi.fn();
    const m = mount(
      { ...PAGE, hasInk: true },
      {
        model: () =>
          Promise.resolve({
            release,
            pagePt: A4,
            model: {
              width: 4,
              height: 4,
              layers: [
                {
                  id: 0,
                  name: "Document",
                  canvas: {
                    toBlob: (cb: (b: Blob | null) => void) => cb(null),
                  } as unknown as HTMLCanvasElement,
                  authored: { opacity: 1, visible: true },
                  current: { opacity: 1, visible: true },
                },
              ],
            },
          }),
      },
    );
    const ora = m.rows().find((b) => b.querySelector("span")!.textContent === "Layered image")!;
    ora.click();
    await vi.waitFor(() => expect(m.toast).toHaveBeenCalledWith("Couldn't build that export. Try again."));
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("disables the raw row for a file with no address, rather than pointing it at the app", () => {
    const m = mount({ ...PAGE });
    // By group: "PDF document" names three rows.
    const raw = m.row("Whole document", "PDF document");
    m.exports.setRawHref("/file/n-1?v=abc&download=1");
    expect(raw.disabled).toBe(false);
    m.exports.setRawHref(null);
    expect(raw.disabled).toBe(true);
  });
});

// --- 4. the per-page PDF row ------------------------------------------------

/** Click a row and wait for the toast that ends its run. */
async function clickAndSettle(
  m: ReturnType<typeof mount>,
  head: string,
  label: string,
): Promise<void> {
  const clicks = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  m.row(head, label).click();
  await vi.waitFor(() => expect(m.toast).toHaveBeenCalled());
  clicks.mockRestore();
}

describe("the per-page PDF export", () => {
  it("sends the DECODER the focused page and the ink mask, placed on the page", async () => {
    const m = mount({ ...PAGE, hasInk: true });
    await clickAndSettle(m, "This page — Current view", "PDF document");

    expect(m.grafts).toHaveLength(1);
    const { page, ink } = m.grafts[0]!;
    expect(page).toBe(1);
    expect({ width: ink.width, height: ink.height }).toEqual({ width: 4, height: 3 });
    expect([...new Set(ink.alpha)]).toEqual([255]);
    // A pure scale: the model is already the page rect.
    expect(ink.matrix).toEqual([A4.width / 4, 0, 0, A4.height / 3, 0, 0]);
  });

  it("asks for a model with NO PAGE RASTER — the page is grafted, not drawn", async () => {
    const m = mount({ ...PAGE, hasInk: true });
    await clickAndSettle(m, "This page — Current view", "PDF document");
    expect(m.asked).toEqual([{ withPage: false }]);
  });

  it("names the file like every other per-page export, and says what was lost", async () => {
    const m = mount({ ...PAGE, hasInk: true });
    await clickAndSettle(m, "This page — Current view", "PDF document");

    const said = String(m.toast.mock.calls[0]![0]);
    expect(said).toContain("Saved Appliance manual_p2_current.pdf");
    // The toast must say it is one page and that grafting drops `/Annots`.
    expect(said).toContain("this page only");
    expect(said).toMatch(/links/i);
    expect(said).toMatch(/annotations .* not carried over/i);
  });

  it("exports the ORIGINAL view's ink from the same page, under its own name", async () => {
    const { make } = recorder();
    const model = composeMarkExportModel({
      space: { width: 4, height: 3, dx: 0, dy: 0 },
      page: null,
      pageVisible: true,
      ink: [{ ...MAIN, visible: true, authoredVisible: false }],
      makeCanvas: make,
    });
    const m = mount(
      { ...PAGE, hasInk: true, tuned: true },
      { model: () => Promise.resolve({ model, pagePt: A4, release: vi.fn() }) },
    );

    await clickAndSettle(m, "This page — Original view", "PDF document");
    expect(String(m.toast.mock.calls[0]![0])).toContain("Appliance manual_p2_original.pdf");
    expect(m.grafts[0]!.ink).toMatchObject({ width: 1, height: 1 });
    expect([...m.grafts[0]!.ink.alpha]).toEqual([0]);
  });

  it("frees the model BEFORE the decoder is asked, not after", async () => {
    // The model is released before the long wasm call, so the two peaks don't stack.
    const order: string[] = [];
    const m = mount(
      { ...PAGE, hasInk: true },
      {
        model: () =>
          Promise.resolve({
            model: tinyModel([MAIN]),
            pagePt: A4,
            release: () => order.push("release"),
          }),
        exportPagePdf: () => {
          order.push("graft");
          return Promise.resolve(new Uint8Array([1]));
        },
      },
    );
    await clickAndSettle(m, "This page — Current view", "PDF document");
    expect(order).toEqual(["release", "graft"]);
  });

  it("toasts and RE-ENABLES the row when the decoder refuses, rather than wedging it", async () => {
    // A failure must not leave the row disabled for the life of the viewer.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const release = vi.fn();
    const m = mount(
      { ...PAGE, hasInk: true },
      {
        model: () => Promise.resolve({ model: tinyModel([MAIN]), pagePt: A4, release }),
        exportPagePdf: () => Promise.reject(new Error("ink_export_page is missing")),
      },
    );
    const row = m.row("This page — Current view", "PDF document");
    row.click();
    await vi.waitFor(() =>
      expect(m.toast).toHaveBeenCalledWith("Couldn't build that export. Try again."),
    );
    expect(row.disabled).toBe(false);
    expect(release).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[1])).toContain("ink_export_page");
    warn.mockRestore();
  });

  it("exports nothing at all when there is no page to export", async () => {
    const m = mount({ ...PAGE, hasInk: true }, { model: () => Promise.resolve(null) });
    m.row("This page — Current view", "PDF document").click();
    await new Promise((r) => setTimeout(r, 0));
    expect(m.grafts).toEqual([]);
    expect(m.toast).not.toHaveBeenCalled();
  });
});

// --- 5. the whole-document row: keeps the original's annotations ------------

describe("the whole-document PDF export", () => {
  it("hides the row on a document with no ink anywhere", () => {
    const m = mount({ ...PAGE });
    expect(m.visibleRows()).not.toContain("PDF with annotations");
    expect(m.row("Whole document", "PDF with annotations").hidden).toBe(true);
  });

  it("shows it as soon as ANY page of the document is annotated", () => {
    const m = mount({ ...PAGE, hasInk: false, markedPages: 3 });
    expect(m.visibleRows()).toEqual([
      "Flattened image",
      "PDF document",
      "PDF with annotations",
      "PDF document",
    ]);
  });

  it("re-reads `markedPages` on refresh, so a late `.mark` reveals the row", () => {
    // The mark loads after the document opens, so the row is decided late.
    const st: PdfExportState = { ...PAGE };
    const m = mount(st, { state: () => st });
    expect(m.row("Whole document", "PDF with annotations").hidden).toBe(true);
    st.markedPages = 7;
    m.exports.refreshGroups();
    expect(m.row("Whole document", "PDF with annotations").hidden).toBe(false);
  });

  it("names the file after the DOCUMENT, not after a page", async () => {
    const m = mount({ ...PAGE, markedPages: 2 });
    await clickAndSettle(m, "Whole document", "PDF with annotations");
    const said = m.toast.mock.calls.map((c) => String(c[0]));
    expect(said.at(-1)).toContain("Saved Appliance manual_annotated.pdf");
    expect(said.at(-1)).not.toMatch(/_p\d/);
  });

  it("says the original's annotations are KEPT — the opposite of the per-page row", async () => {
    // Must say annotations are kept, unlike the per-page row's warning.
    const m = mount({ ...PAGE, markedPages: 2 });
    await clickAndSettle(m, "Whole document", "PDF with annotations");
    const said = String(m.toast.mock.calls.at(-1)![0]);
    expect(said).toMatch(/preserved/i);
    expect(said).toMatch(/highlights/i);
    expect(said).not.toMatch(/not carried over/i);
    expect(said).toContain("whole document");
    expect(said).toContain("2 annotated pages");
  });

  it("counts a single annotated page in the singular", async () => {
    const m = mount(
      { ...PAGE, markedPages: 1 },
      {
        exportDocumentPdf: (onProgress) => {
          onProgress(1, 1);
          return Promise.resolve({ blob: new Blob([new Uint8Array([1])]), pages: 1 });
        },
      },
    );
    await clickAndSettle(m, "Whole document", "PDF with annotations");
    expect(String(m.toast.mock.calls.at(-1)![0])).toContain("1 annotated page.");
  });

  it("reports progress per ANNOTATED page, before the file is saved", async () => {
    // Counts the sparse marked set, with a first toast before any page number.
    const m = mount({ ...PAGE, markedPages: 2 });
    await clickAndSettle(m, "Whole document", "PDF with annotations");
    const said = m.toast.mock.calls.map((c) => String(c[0]));
    expect(said[0]).toBe("Exporting Appliance manual.pdf — fetching the original…");
    expect(said[1]).toBe("Exporting Appliance manual.pdf — page 1 of 2…");
    expect(said[2]).toBe("Exporting Appliance manual.pdf — page 2 of 2…");
    expect(said).toHaveLength(4);
  });

  it("toasts and re-enables the row when the decoder refuses the document", async () => {
    // Repaired PDFs or junk before `%PDF-` cannot take an incremental update; no fallback.
    const m = mount(
      { ...PAGE, markedPages: 2 },
      {
        exportDocumentPdf: () =>
          Promise.reject(new Error("this PDF had to be repaired to open")),
      },
    );
    const row = m.row("Whole document", "PDF with annotations");
    row.click();
    await vi.waitFor(() =>
      expect(m.toast).toHaveBeenCalledWith("Couldn't build that export. Try again."),
    );
    expect(row.disabled).toBe(false);
  });

  it("does nothing at all when no document is open", async () => {
    const m = mount({ ...PAGE, markedPages: 2 }, { docName: () => null });
    m.row("Whole document", "PDF with annotations").click();
    await new Promise((r) => setTimeout(r, 0));
    expect(m.documentExports).toEqual([]);
    expect(m.toast).not.toHaveBeenCalled();
  });
});
