// @vitest-environment happy-dom
// The `Viewer` seam the shell dispatches to: shape, visibility, the universal
// toolbar zone, and the bin-context cluster.

import { describe, it, expect, vi } from "vitest";
import { createSpdViewer } from "../../src/pages/spdViewer";
import { createTxtViewer, type TxtSeam } from "../../src/pages/txtViewer";
import { createPdfViewer, type PdfSeam } from "../../src/pages/pdfViewer";
import type { Viewer, ViewerDeps, ReaderOrigin } from "../../src/pages/viewer";
import { FIT_PAGE } from "../../src/pages/viewerControls";
import type { NoteMeta } from "../../src/core/types";
import { synthesizeSummary } from "../../src/pages/library";

// An inert TxtSeam; render behaviour is `txtViewer.test.ts`'s.
const INERT_TXT_SEAM: TxtSeam = {
  fetchText: () => new Promise<string>(() => {}),
  loadFontSize: () => null,
  saveFontSize: () => {},
  loadZoom: () => null,
  saveZoom: () => {},
};

/** Deps whose callbacks are spies — the seam's only observable effects. */
function deps(over: Partial<ViewerDeps> = {}): ViewerDeps {
  return {
    api: {} as ViewerDeps["api"],
    renderer: {} as ViewerDeps["renderer"],
    cache: {} as ViewerDeps["cache"],
    getTheme: () => "light",
    onBack: vi.fn(),
    toast: vi.fn(),
    onSessionExpired: vi.fn(),
    onMoveToBin: vi.fn(),
    onRestore: vi.fn(),
    onPurge: vi.fn(),
    onPosition: vi.fn(),
    ...over,
  };
}

/** A file of `fileType`, enough for a stub's `open()`. */
function meta(over: Partial<NoteMeta> = {}): NoteMeta {
  return {
    id: "n-1",
    name: "Kitchen sketch",
    pages: [],
    fileType: "spd",
    fileHash: "a".repeat(32),
    size: 4096,
    pxPerMm: null,
    ...over,
  };
}

// The PDF viewer awaits its seam, so the stub answers plausibly; `paint()` then
// bails at the null 2D context, leaving the placeholder up.
const INERT_PDF_SEAM: PdfSeam = {
  supported: () => true,
  createSession: () => ({
    open: () => Promise.resolve({ pageCount: 2, mode: "whole" as const }),
    pageSize: () => Promise.resolve({ width: 200, height: 100 }),
    pageLinks: () => Promise.resolve([]),
    outline: () => Promise.resolve([]),
    render: () =>
      Promise.resolve({
        bitmap: { close: () => {} } as unknown as ImageBitmap,
        width: 200,
        height: 100,
      }),
    exportPage: () => Promise.reject(new Error("no ink_export_page in this stub")),
    annotatePage: () => Promise.reject(new Error("no ink_annotate_page in this stub")),
    exportDocument: () => Promise.reject(new Error("no ink_export_incremental in this stub")),
    stats: () => Promise.resolve({ mode: "whole" as const, cache: null }),
    close: () => Promise.resolve(),
    destroy: () => {},
  }),
};

/** A menu's raw-file row by group: "PDF document" also names per-page export rows. */
function rawRowOf(root: ParentNode, label: string): HTMLButtonElement {
  const groups = Array.from(root.querySelectorAll<HTMLElement>(".menu__pop > div"));
  const whole = groups.find((g) =>
    (g.querySelector(".menu__head")?.textContent ?? "").startsWith("Whole "),
  );
  return Array.from(
    (whole ?? root).querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
  ).find((b) => b.textContent?.includes(label))!;
}

const FOLDER: ReaderOrigin = { kind: "folder", folderPath: "Note / Files" };

/** The raw-file row's label in a viewer's Download menu, or null for a plain `<a download>`. */
const STUBS: {
  name: string;
  make: (d: ViewerDeps) => Viewer;
  type: string;
  mark: string;
  rawRow: string | null;
}[] = [
  { name: ".spd", make: createSpdViewer, type: "spd", mark: "SPD", rawRow: "Atelier sketch" },
  { name: ".txt", make: (d) => createTxtViewer(d, INERT_TXT_SEAM), type: "txt", mark: "TXT", rawRow: null },
  { name: ".pdf", make: (d) => createPdfViewer(d, INERT_PDF_SEAM), type: "pdf", mark: "PDF", rawRow: "PDF document" },
];

/** Click the raw-file row and report the href of the transient `<a download>`. */
function rawHrefOnClick(row: HTMLButtonElement): string | null {
  let href: string | null = null;
  const clickSpy = vi
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(function (this: HTMLAnchorElement) {
      href = this.getAttribute("href");
    });
  row.click();
  clickSpy.mockRestore();
  return href;
}

describe.each(STUBS)("$name stub viewer", ({ make, type, mark, rawRow }) => {
  it("conforms to Viewer and starts hidden", async () => {
    const v = make(deps());
    expect(typeof v.open).toBe("function");
    expect(typeof v.hide).toBe("function");
    expect(typeof v.destroy).toBe("function");
    expect(v.el).toBeInstanceOf(HTMLElement);
    expect((v.el as HTMLElement).hidden).toBe(true);
  });

  it("open() reveals the placeholder, the file name and the type", async () => {
    const v = make(deps());
    document.body.append(v.el);
    await v.open(synthesizeSummary(meta({ fileType: type })), Promise.resolve(meta({ fileType: type })), 0, FOLDER, "");

    expect(v.el.hidden).toBe(false);
    const placeholder = v.el.querySelector(".viewer__placeholder")!;
    expect(placeholder.textContent).toContain("Kitchen sketch");
    expect(placeholder.querySelector(".viewer__mark")!.textContent).toBe(mark);
    v.destroy();
  });

  it("hosts a role=toolbar with Back, Download and Move to bin", async () => {
    const v = make(deps());
    const bar = v.el.querySelector('[role="toolbar"]')!;
    expect(bar).not.toBeNull();
    expect(bar.querySelector(".viewer__back")).not.toBeNull();
    expect(bar.querySelector('[aria-label="Download"]')).not.toBeNull();
    expect(bar.querySelector('[aria-label="Move to bin"]')).not.toBeNull();
  });

  it("Move to bin is NEUTRAL (never the danger styling) and labelled", async () => {
    const v = make(deps());
    const moveBin = v.el.querySelector('[aria-label="Move to bin"]') as HTMLElement;
    expect(moveBin.className).not.toContain("is-danger");
    expect(moveBin.textContent).toContain("Move to bin");
  });

  it("Back routes through onBack", async () => {
    const onBack = vi.fn();
    const v = make(deps({ onBack }));
    document.body.append(v.el);
    await v.open(synthesizeSummary(meta({ fileType: type })), Promise.resolve(meta({ fileType: type })), 0, FOLDER, "");
    (v.el.querySelector(".viewer__back") as HTMLButtonElement).click();
    expect(onBack).toHaveBeenCalledTimes(1);
    v.destroy();
  });

  it("Move to bin hands the open file to onMoveToBin (the one trash path)", async () => {
    const onMoveToBin = vi.fn();
    const v = make(deps({ onMoveToBin }));
    document.body.append(v.el);
    const m = meta({ id: "n-files", name: "readme", fileType: type });
    await v.open(synthesizeSummary(m), Promise.resolve(m), 0, FOLDER, "");
    (v.el.querySelector('[aria-label="Move to bin"]') as HTMLButtonElement).click();
    expect(onMoveToBin).toHaveBeenCalledTimes(1);
    expect(onMoveToBin.mock.calls[0]![0]).toMatchObject({ id: "n-files", name: "readme" });
    v.destroy();
  });

  it("a second open drops the first file's identity before it awaits the new one", async () => {
    // Moving between two files of the same type skips `hide()` and awaits metadata; Move
    // to bin in that window must not trash the previous file.
    const onMoveToBin = vi.fn();
    const v = make(deps({ onMoveToBin }));
    document.body.append(v.el);
    const first = meta({ id: "n-first", name: "First file", fileType: type });
    await v.open(synthesizeSummary(first), Promise.resolve(first), 0, FOLDER, "");

    // Open a second file whose metadata never arrives — the window, held open.
    const second = meta({ id: "n-second", name: "Second file", fileType: type });
    void v.open(synthesizeSummary(second), new Promise<NoteMeta>(() => {}), 0, FOLDER, "");
    await new Promise((r) => setTimeout(r, 0));

    (v.el.querySelector('[aria-label="Move to bin"]') as HTMLButtonElement).click();
    expect(onMoveToBin).not.toHaveBeenCalled();
    v.destroy();
  });

  it("the bin context swaps the file zone: the retention countdown + a ⋯ menu instead of Move to bin", async () => {
    const v = make(deps());
    document.body.append(v.el);
    const moveBin = v.el.querySelector('[aria-label="Move to bin"]') as HTMLElement;
    const cluster = v.el.querySelector(".viewer__bin-actions") as HTMLElement;
    const items = () => Array.from(cluster.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));

    await v.open(synthesizeSummary(meta({ fileType: type })), Promise.resolve(meta({ fileType: type })), 0, { kind: "bin", folderPath: "Note / Files", retention: { daysLeft: 30, soon: false, retentionDays: 30 } }, "");
    expect(moveBin.hidden).toBe(true);
    expect(cluster.hidden).toBe(false);
    const trigger = cluster.querySelector(".card__more") as HTMLButtonElement;
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    const [restore, purge] = items();
    expect(restore!.textContent).toContain("Restore");
    expect(restore!.className).not.toContain("menu__item--danger");
    expect(purge!.textContent).toContain("Delete permanently");
    expect(purge!.className).toContain("menu__item--danger");
    expect(cluster.querySelector(".life__label")!.textContent).toContain("30 days left");

    await v.open(synthesizeSummary(meta({ fileType: type })), Promise.resolve(meta({ fileType: type })), 0, FOLDER, "");
    expect(moveBin.hidden).toBe(false);
    expect(cluster.hidden).toBe(true);
    v.destroy();
  });

  it("the ⋯ menu's Restore and Delete permanently hand the open file to the shell's bin callbacks", async () => {
    const onRestore = vi.fn();
    const onPurge = vi.fn();
    const v = make(deps({ onRestore, onPurge }));
    document.body.append(v.el);
    const m = meta({ id: "n-gone", name: "trashed", fileType: type });
    await v.open(synthesizeSummary(m), Promise.resolve(m), 0, { kind: "bin", folderPath: null, retention: { daysLeft: 4, soon: true, retentionDays: 30 } }, "");

    const cluster = v.el.querySelector(".viewer__bin-actions")!;
    const [restore, purge] = Array.from(cluster.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));

    restore!.click();
    expect(onRestore).toHaveBeenCalledTimes(1);
    expect(onRestore.mock.calls[0]![0]).toMatchObject({ id: "n-gone", name: "trashed" });

    purge!.click();
    expect(onPurge).toHaveBeenCalledTimes(1);
    expect(onPurge.mock.calls[0]![0]).toMatchObject({ id: "n-gone", name: "trashed" });
    v.destroy();
  });

  it("Back names where it returns to, per origin", async () => {
    const v = make(deps());
    const label = v.el.querySelector(".viewer__back-label") as HTMLElement;
    await v.open(synthesizeSummary(meta({ fileType: type })), Promise.resolve(meta({ fileType: type })), 0, { kind: "folder", folderPath: "Note / Files" }, "");
    expect(label.textContent).toBe("Files");
    await v.open(synthesizeSummary(meta({ fileType: type })), Promise.resolve(meta({ fileType: type })), 0, { kind: "search", folderPath: "Note / Files" }, "");
    expect(label.textContent).toBe("Search");
    await v.open(synthesizeSummary(meta({ fileType: type })), Promise.resolve(meta({ fileType: type })), 0, { kind: "bin", folderPath: null }, "");
    expect(label.textContent).toBe("Recycle bin");
    await v.open(synthesizeSummary(meta({ fileType: type })), Promise.resolve(meta({ fileType: type })), 0, { kind: "folder", folderPath: null }, "");
    expect(label.textContent).toBe("Library");
    v.destroy();
  });

  it("points Download at the versioned raw-file URL with the attachment flag", async () => {
    const v = make(deps());
    document.body.append(v.el);
    await v.open(synthesizeSummary(meta({ id: "n-1", fileHash: "b".repeat(32), fileType: type })), Promise.resolve(meta({ id: "n-1", fileHash: "b".repeat(32), fileType: type })), 0, FOLDER, "");
    const trigger = v.el.querySelector('[aria-label="Download"]') as HTMLElement;

    if (rawRow) {
      expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
      trigger.click();
      const raw = rawRowOf(v.el, rawRow);
      expect(raw).toBeTruthy();
      expect(raw.disabled).toBe(false);
      expect(rawHrefOnClick(raw)).toMatch(/^\/file\/n-1\?v=b{32}&download=1$/);
    } else {
      const dl = trigger as HTMLAnchorElement;
      expect(dl.hidden).toBe(false);
      expect(dl.getAttribute("href")).toMatch(/^\/file\/n-1\?v=b{32}&download=1$/);
    }
    v.destroy();
  });

  it("in the bin context, Download points at the BIN-scoped raw route", async () => {
    // The live `/file/{id}` 404s for trashed files, so download uses the bin route.
    const v = make(deps());
    document.body.append(v.el);
    await v.open(synthesizeSummary(meta({ id: "n-1", fileHash: "b".repeat(32), fileType: type })), Promise.resolve(meta({ id: "n-1", fileHash: "b".repeat(32), fileType: type })), 0, { kind: "bin", folderPath: null }, "");
    const trigger = v.el.querySelector('[aria-label="Download"]') as HTMLElement;

    if (rawRow) {
      trigger.click();
      const raw = rawRowOf(v.el, rawRow);
      expect(rawHrefOnClick(raw)).toMatch(/^\/api\/controlplane\/bin\/file\/n-1\?v=b{32}&download=1$/);
    } else {
      const dl = trigger as HTMLAnchorElement;
      expect(dl.getAttribute("href")).toMatch(/^\/api\/controlplane\/bin\/file\/n-1\?v=b{32}&download=1$/);
    }
    v.destroy();
  });

  it("hide() takes it back off the layer", async () => {
    const v = make(deps());
    document.body.append(v.el);
    await v.open(synthesizeSummary(meta({ fileType: type })), Promise.resolve(meta({ fileType: type })), 0, FOLDER, "");
    expect(v.el.hidden).toBe(false);
    v.hide();
    expect(v.el.hidden).toBe(true);
    v.destroy();
  });
});

describe.each(STUBS)("$name Download, with no address", ({ make, type, rawRow }) => {
  it("offers no route to the raw bytes, instead of pointing at the app", async () => {
    // Regression: an empty `href` resolves to the document base URL, so the PDF viewer's
    // Download navigated to the SPA itself.
    const v = make(deps());
    document.body.append(v.el);
    const m = meta({ id: "n-1", fileHash: null, fileType: type });
    await v.open(synthesizeSummary(m), Promise.resolve(m), 0, FOLDER, "");

    const trigger = v.el.querySelector('[aria-label="Download"]') as HTMLElement;
    if (rawRow) {
      trigger.click();
      const raw = rawRowOf(v.el, rawRow);
      expect(raw.disabled).toBe(true);
      expect(rawHrefOnClick(raw)).toBeNull();
    } else {
      expect((trigger as HTMLAnchorElement).hidden).toBe(true);
    }
    v.destroy();
  });
});

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
