// @vitest-environment happy-dom
//
// The `.spd`/`.txt` STUB viewers (src/pages/spdViewer.ts, txtViewer.ts) as DOM
// units — the multi-viewer seam the shell dispatches to (see `library.viewerFor`).
// The render is a follow-up agent's job; what is asserted here is the SEAM the
// shell depends on and that the stubs must keep once real rendering lands: they
// conform to `Viewer` (el/open/hide/destroy), open/hide toggle visibility, the
// shared toolbar's UNIVERSAL zone (Back → onBack, Download, Move to bin → the one
// `onMoveToBin` trash path) is wired, and the bin context swaps the file zone to
// the retention countdown + the shared "…" menu, whose Restore / Delete
// permanently route through `onRestore`/`onPurge` (the bin's own machinery).

import { describe, it, expect, vi } from "vitest";
import { createSpdViewer } from "../../src/pages/spdViewer";
import { createTxtViewer, type TxtSeam } from "../../src/pages/txtViewer";
import { createPdfViewer, type PdfSeam } from "../../src/pages/pdfViewer";
import type { Viewer, ViewerDeps, ReaderOrigin } from "../../src/pages/viewer";
import type { NoteMeta } from "../../src/core/types";
import { synthesizeSummary } from "../../src/pages/library";

// The `.txt` viewer is REAL — its `open()` fetches. This suite asserts only the
// shared SEAM (placeholder, universal toolbar), so it hands the viewer an inert
// TxtSeam: no network, no storage. Its render + font-size behaviour lives in
// `txtViewer.test.ts`.
const INERT_TXT_SEAM: TxtSeam = {
  fetchText: () => new Promise<string>(() => {}), // never resolves — stays on the loading placeholder
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

// The PDF viewer is REAL too — its `open()` drives MuPDF in a worker, and unlike
// the other two it AWAITS that work before returning. So its seam cannot simply
// never settle (that hangs `open()`); it answers every call plausibly and hands
// back a bitmap-shaped stub. `paint()` then bails at `getContext("2d")`, which is
// null under happy-dom, leaving the placeholder up — exactly the state this suite
// wants, since what it asserts is the shared TOOLBAR seam and not the pixels.
const INERT_PDF_SEAM: PdfSeam = {
  supported: () => true,
  createSession: () => ({
    open: () => Promise.resolve({ pageCount: 2, mode: "whole" as const }),
    pageSize: () => Promise.resolve({ width: 200, height: 100 }),
    pageLinks: () => Promise.resolve([]),
    render: () =>
      Promise.resolve({
        // Only `close()` is ever reached: `paint` closes the bitmap and returns
        // the moment the 2D context comes back null.
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

/**
 * A viewer menu's raw-file row, BY GROUP rather than by label.
 *
 * The label alone is not unique any more: the PDF viewer offers "PDF document"
 * in each per-page group as well, and those rows TRANSFORM the page (one grafts
 * it into a new one-page document) where this one is the untouched bytes. A bare
 * label search finds the first, which is a different row doing a different
 * thing. Viewers whose menu has no group headings at all fall back to the whole
 * popover, which is what `.spd` needs.
 */
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

/**
 * The raw viewers share a contract, so the table drives one body over all of
 * them. `.pdf` joined late — it shipped without Move to bin OR the bin cluster,
 * the only one of the four missing both, and nothing here noticed because it was
 * never in the table.
 */
/**
 * `rawRow` is the label of the raw-file row inside a viewer's Download MENU, or
 * null for a viewer whose Download is still a plain `<a download>`. Two of the
 * three carry a menu now: `.spd` always did, and `.pdf` gained one with its
 * per-page layered exports — the raw file survived as one row of it, which is
 * exactly what the two href tests below have to keep proving.
 */
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

/**
 * Click a menu's raw-file row and report the href the transient `<a download>`
 * would have navigated to. The row does not carry the href as an attribute — it
 * mints the anchor on click — so the click is the only way to read it.
 */
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
    // Both universal actions carry their accessible name.
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
    // THE WINDOW: the shell does NOT call `hide()` when you move between two
    // files of the SAME type (`library.activate` only hides a DIFFERENT viewer),
    // and `open()` then awaits the new file's metadata — a network round trip.
    // For that whole time the toolbar is up, with Move to bin visible and
    // enabled, pointed at whatever the viewer last held. Clicking it there must
    // not trash the file you just navigated away from.
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
    // Nothing, rather than the wrong thing: the new file is not known yet and the
    // old one is no longer this viewer's business.
    expect(onMoveToBin).not.toHaveBeenCalled();
    v.destroy();
  });

  it("the bin context swaps the file zone: the retention countdown + a ⋯ menu instead of Move to bin", async () => {
    const v = make(deps());
    document.body.append(v.el);
    const moveBin = v.el.querySelector('[aria-label="Move to bin"]') as HTMLElement;
    // The bin-mode cluster — the SAME `|— retention —| ⋯` a bin ROW shows. Its two
    // decisions are menu items, not bare buttons: Restore then Delete permanently.
    const cluster = v.el.querySelector(".viewer__bin-actions") as HTMLElement;
    const items = () => Array.from(cluster.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));

    // From the bin the file is ALREADY trashed: re-trashing is nonsense, and its
    // two real decisions are Restore and Delete permanently.
    await v.open(synthesizeSummary(meta({ fileType: type })), Promise.resolve(meta({ fileType: type })), 0, { kind: "bin", folderPath: "Note / Files", retention: { daysLeft: 30, soon: false, retentionDays: 30 } }, "");
    expect(moveBin.hidden).toBe(true);
    expect(cluster.hidden).toBe(false);
    // The trigger is a real button with the menu wiring, keyboard-operable.
    const trigger = cluster.querySelector(".card__more") as HTMLButtonElement;
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    // Restore is the SAFE direction (neutral); Delete permanently is the ONE red
    // `menu__item--danger` — the colour rule, identical to the bin row's.
    const [restore, purge] = items();
    expect(restore!.textContent).toContain("Restore");
    expect(restore!.className).not.toContain("menu__item--danger");
    expect(purge!.textContent).toContain("Delete permanently");
    expect(purge!.className).toContain("menu__item--danger");
    // The countdown mirrors the row's: the days-left label off the same `.life`.
    expect(cluster.querySelector(".life__label")!.textContent).toContain("30 days left");

    // …and a live file swaps back to Move to bin, hiding the cluster.
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

    // The destructive item still routes through `onPurge` → the bin controller's
    // confirm; the item itself does not skip it.
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
      // A MENU-based Download (export matrix + the raw file); the raw file is one
      // item that navigates to the versioned URL on click via a transient
      // `<a download>`. Open the menu and capture that anchor's href.
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
    // The live `/file/{id}` goes through `Files.get` (`deleted = 0`) and 404s
    // for anything trashed — the reader's precedent is that download from the
    // bin stays offered, so it has to come off the bin's own route.
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

// A FILE WITH NO ADDRESS must not leave a live Download pointing at the app —
// the same rule for both shapes of the control, so the table drives both.
// A plain `<a>` (`.txt`) hides; a menu (`.spd`, `.pdf`) keeps its trigger — the
// transformed exports do not need a download URL — and DISABLES its raw row.
describe.each(STUBS)("$name Download, with no address", ({ make, type, rawRow }) => {
  it("offers no route to the raw bytes, instead of pointing at the app", async () => {
    // `rawFileUrl` answers null for a hashless entry (`fileKind.ts:217`) — the
    // state the "no readable address" placeholder exists for. The PDF viewer
    // used to test the ANCHOR's href for emptiness, and an empty `href`
    // attribute resolves through the property to the document base URL: never
    // falsy, so the button stayed up and navigated to the SPA itself.
    const v = make(deps());
    document.body.append(v.el);
    const m = meta({ id: "n-1", fileHash: null, fileType: type });
    await v.open(synthesizeSummary(m), Promise.resolve(m), 0, FOLDER, "");

    const trigger = v.el.querySelector('[aria-label="Download"]') as HTMLElement;
    if (rawRow) {
      trigger.click();
      const raw = rawRowOf(v.el, rawRow);
      expect(raw.disabled).toBe(true);
      // Disabled is not enough on its own — a click must produce no navigation
      // either, since that is the failure the whole test is about.
      expect(rawHrefOnClick(raw)).toBeNull();
    } else {
      expect((trigger as HTMLAnchorElement).hidden).toBe(true);
    }
    v.destroy();
  });
});

describe(".pdf viewer, past the shared seam", () => {
  it("publishes the page it is on, so a PDF page has an address", async () => {
    // The route `#/note/:id/page/:n` is shared with the reader and `open()` has
    // always honoured it — but this viewer never wrote one BACK, so the half a
    // person uses was missing: paging to 34 and reloading returned to page 1,
    // and there was no address to send anyone. The reader has published its page
    // since it existed.
    const onPosition = vi.fn();
    const v = createPdfViewer(deps({ onPosition }), INERT_PDF_SEAM);
    document.body.append(v.el);
    const m = meta({ id: "n-doc", fileType: "pdf" });
    await v.open(synthesizeSummary(m), Promise.resolve(m), 0, FOLDER, "");

    onPosition.mockClear();
    // Paged with the ARROW KEY, not the pager button. Under happy-dom `paint()`
    // returns at the null 2D context before it reaches `syncPager`, so the
    // buttons keep the disabled state they had when the page count was still 0.
    // The key routes through the same `go()`, which is what this is about.
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
    await new Promise((r) => setTimeout(r, 0));

    expect(onPosition).toHaveBeenCalled();
    const [id, page, query] = onPosition.mock.calls.at(-1)!;
    expect(id).toBe("n-doc");
    expect(page).toBe(1); // 0-based internally; the router writes it 1-based
    expect(query).toBe(""); // a PDF has no find query to carry
    v.destroy();
  });

  it("publishes the BIN address for a trashed file, not the live one", async () => {
    // A trashed blob is not served from `#/note/:id`, so writing that address
    // would make a reload 404 to the library. The reader's rule, inherited.
    const onPosition = vi.fn();
    const v = createPdfViewer(deps({ onPosition }), INERT_PDF_SEAM);
    document.body.append(v.el);
    const m = meta({ id: "n-gone", fileType: "pdf" });
    await v.open(synthesizeSummary(m), Promise.resolve(m), 0, { kind: "bin", folderPath: null }, "");

    onPosition.mockClear();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
    await new Promise((r) => setTimeout(r, 0));

    expect(onPosition.mock.calls.at(-1)![4]).toBe(true); // the `bin` flag
    v.destroy();
  });

  it("a new document resets the zoom READOUT, not just the scale behind it", async () => {
    // `open` sets the zoom state back to Fit and renders there. The stepper owns
    // its own label, so without an explicit reset the toolbar went on showing the
    // LAST document's zoom over a page drawn at Fit — and the next step then
    // moved from the number on screen rather than from the page in front of you.
    const v = createPdfViewer(deps(), INERT_PDF_SEAM);
    document.body.append(v.el);
    // Scoped to the zoom stepper's own `.pager`: the PAGE readout carries the
    // `.zoom` class too (`pdfViewer.ts:204`), so a bare `.zoom` inside this
    // viewer resolves to two elements and finds the pager's first.
    const zoomIn = v.el.querySelector('[aria-label="Zoom in"]') as HTMLButtonElement;
    const readout = zoomIn.parentElement!.querySelector(".zoom") as HTMLElement;

    const first = meta({ id: "n-first", fileType: "pdf" });
    await v.open(synthesizeSummary(first), Promise.resolve(first), 0, FOLDER, "");
    expect(readout.textContent).toBe("Fit");

    zoomIn.click();
    zoomIn.click();
    expect(readout.textContent).not.toBe("Fit");

    const second = meta({ id: "n-second", fileType: "pdf" });
    await v.open(synthesizeSummary(second), Promise.resolve(second), 0, FOLDER, "");
    expect(readout.textContent).toBe("Fit");
    v.destroy();
  });

  it("exports render the page FRESH, at the export's OWN scale — never the screen's", async () => {
    // `export/exporter.ts` states the rule for notes (`nativeBitmap`) and it is
    // the same rule here: an export decodes, it never screenshots. The canvas on
    // screen is at whatever zoom, DPR and open-panel layout the reader happens
    // to be at — a Fit page beside two panels is a fraction of the page's real
    // resolution — and reusing it is the cheap mistake this pins shut.
    //
    // Asserted on the SCALE handed to the decoder, which is the one place the
    // difference is observable without a GPU: happy-dom has no 2D context, so
    // the flatten throws and the row toasts, but the render has already been
    // asked for by then.
    const renders: { page: number; scale: number }[] = [];
    const seam: PdfSeam = {
      supported: () => true,
      createSession: () => ({
        open: () => Promise.resolve({ pageCount: 2, mode: "whole" as const }),
        pageSize: () => Promise.resolve({ width: 200, height: 100 }),
        pageLinks: () => Promise.resolve([]),
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

    // 2x the PDF's own 72 dpi, for a page with no ink to agree with — and NOT
    // the fit scale the screen used, which in this layout is well under 1.
    expect(renders[0]).toEqual({ page: 0, scale: 2 });
    for (const s of onScreen) expect(s).not.toBe(2);
    v.destroy();
  });

  it("the per-page PDF asks the DECODER for the page — it never rasters one", async () => {
    // The row that keeps the page's own structure. Everything else in this menu
    // draws pixels; this one hands the decoder a page INDEX and an ink mask and
    // gets a document back, so a render here would be a full MuPDF raster built
    // only to be discarded — and, worse, a sign that the export was quietly
    // going through the image path after all.
    const renders: number[] = [];
    const exports: { page: number; ink: { width: number; height: number; matrix: readonly number[] } }[] = [];
    const seam: PdfSeam = {
      supported: () => true,
      createSession: () => ({
        open: () => Promise.resolve({ pageCount: 2, mode: "whole" as const }),
        // 200 x 100 pt — the page's OWN units, which is what the mask's matrix
        // has to map onto.
        pageSize: () => Promise.resolve({ width: 200, height: 100 }),
        pageLinks: () => Promise.resolve([]),
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
    // No ink on this page, so the mask is the one clear pixel stretched over the
    // page — 200 pt across it and 100 down, straight off `pageSize`.
    expect(exports[0]!.ink).toMatchObject({ width: 1, height: 1 });
    expect(exports[0]!.ink.matrix).toEqual([200, 0, 0, 100, 0, 0]);
    v.destroy();
  });

  it("the whole-document export reads the original as a BLOB, never into memory", async () => {
    // THE MEMORY ARGUMENT, at the only place in the app that could break it.
    // The exported file CONTAINS the original, so the original has to be
    // fetched — but `res.blob()` is disk-backed where `res.arrayBuffer()` would
    // put 76 MB on the JS heap of a tab that also holds a wasm module and a
    // page's worth of canvases. The stub Response below makes the wrong call
    // impossible to take quietly: it throws.
    //
    // The ink itself cannot decode here (happy-dom has no 2D context and the
    // `.mark` decoder never loads), so this also pins the OTHER half of the
    // contract: a page whose handwriting will not decode is skipped, and an
    // export where none of them decode refuses instead of saving the original
    // back under a name that promises ink.
    const took: string[] = [];
    const original = new Blob([new Uint8Array([0x25, 0x50, 0x44, 0x46])]);
    const fetched: string[] = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      fetched.push(String(input));
      // ONLY the raw-file route is stubbed as a body. The `.mark` decoder's own
      // `/note-decode.wasm` fetch goes through here too and DOES read an
      // ArrayBuffer, legitimately — conflating the two would make `took` say
      // nothing about the document.
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
    // The mark rides along after the open; wait for the row it reveals.
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

    // The raw-file route, and taken as a Blob and only as a Blob.
    expect(fetched[0]).toContain("/file/n-1");
    expect(took).toEqual(["blob"]);
    // Nothing was lent to the decoder and nothing was saved: every annotated
    // page failed to decode, so there was no export to make.
    expect(lent).toEqual([]);
    fetchSpy.mockRestore();
    v.destroy();
  });
});
