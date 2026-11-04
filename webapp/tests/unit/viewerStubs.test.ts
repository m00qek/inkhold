// @vitest-environment happy-dom
// The `Viewer` seam the shell dispatches to: shape, visibility, the universal
// toolbar zone, and the bin-context cluster.

import { describe, it, expect, vi } from "vitest";
import { createSpdViewer } from "../../src/pages/spd/spdViewer";
import { createTxtViewer, type TxtSeam } from "../../src/pages/txt/txtViewer";
import { createPdfViewer } from "../../src/pages/pdf/pdfViewer";
import type { Viewer, ViewerDeps } from "../../src/pages/viewer/viewer";
import type { NoteMeta } from "../../src/core/types";
import { synthesizeSummary } from "../../src/pages/library/library";
import { deps, meta, INERT_PDF_SEAM, FOLDER } from "./viewerStubs.shared";

// An inert TxtSeam; render behaviour is `txtViewer.test.ts`'s.
const INERT_TXT_SEAM: TxtSeam = {
  fetchText: () => new Promise<string>(() => {}),
  loadFontSize: () => null,
  saveFontSize: () => {},
  loadZoom: () => null,
  saveZoom: () => {},
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
