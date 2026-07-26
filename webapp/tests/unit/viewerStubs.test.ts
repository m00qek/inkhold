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
import type { Viewer, ViewerDeps, ReaderOrigin } from "../../src/pages/viewer";
import type { NoteMeta } from "../../src/core/types";

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

const FOLDER: ReaderOrigin = { kind: "folder", folderPath: "Note / Files" };

/** The two stubs share a contract, so the table drives one body over both. */
const STUBS: { name: string; make: (d: ViewerDeps) => Viewer; type: string; mark: string }[] = [
  { name: ".spd", make: createSpdViewer, type: "spd", mark: "SPD" },
  { name: ".txt", make: (d) => createTxtViewer(d, INERT_TXT_SEAM), type: "txt", mark: "TXT" },
];

describe.each(STUBS)("$name stub viewer", ({ make, type, mark }) => {
  it("conforms to Viewer and starts hidden", () => {
    const v = make(deps());
    expect(typeof v.open).toBe("function");
    expect(typeof v.hide).toBe("function");
    expect(typeof v.destroy).toBe("function");
    expect(v.el).toBeInstanceOf(HTMLElement);
    expect((v.el as HTMLElement).hidden).toBe(true);
  });

  it("open() reveals the placeholder, the file name and the type", () => {
    const v = make(deps());
    document.body.append(v.el);
    v.open(meta({ fileType: type }), 0, FOLDER, "");

    expect(v.el.hidden).toBe(false);
    const placeholder = v.el.querySelector(".viewer__placeholder")!;
    expect(placeholder.textContent).toContain("Kitchen sketch");
    expect(placeholder.querySelector(".viewer__mark")!.textContent).toBe(mark);
    v.destroy();
  });

  it("hosts a role=toolbar with Back, Download and Move to bin", () => {
    const v = make(deps());
    const bar = v.el.querySelector('[role="toolbar"]')!;
    expect(bar).not.toBeNull();
    expect(bar.querySelector(".viewer__back")).not.toBeNull();
    // Both universal actions carry their accessible name.
    expect(bar.querySelector('[aria-label="Download"]')).not.toBeNull();
    expect(bar.querySelector('[aria-label="Move to bin"]')).not.toBeNull();
  });

  it("Move to bin is NEUTRAL (never the danger styling) and labelled", () => {
    const v = make(deps());
    const moveBin = v.el.querySelector('[aria-label="Move to bin"]') as HTMLElement;
    expect(moveBin.className).not.toContain("is-danger");
    expect(moveBin.textContent).toContain("Move to bin");
  });

  it("Back routes through onBack", () => {
    const onBack = vi.fn();
    const v = make(deps({ onBack }));
    document.body.append(v.el);
    v.open(meta({ fileType: type }), 0, FOLDER, "");
    (v.el.querySelector(".viewer__back") as HTMLButtonElement).click();
    expect(onBack).toHaveBeenCalledTimes(1);
    v.destroy();
  });

  it("Move to bin hands the open file to onMoveToBin (the one trash path)", () => {
    const onMoveToBin = vi.fn();
    const v = make(deps({ onMoveToBin }));
    document.body.append(v.el);
    const m = meta({ id: "n-files", name: "readme", fileType: type });
    v.open(m, 0, FOLDER, "");
    (v.el.querySelector('[aria-label="Move to bin"]') as HTMLButtonElement).click();
    expect(onMoveToBin).toHaveBeenCalledTimes(1);
    expect(onMoveToBin.mock.calls[0]![0]).toMatchObject({ id: "n-files", name: "readme" });
    v.destroy();
  });

  it("the bin context swaps the file zone: the retention countdown + a ⋯ menu instead of Move to bin", () => {
    const v = make(deps());
    document.body.append(v.el);
    const moveBin = v.el.querySelector('[aria-label="Move to bin"]') as HTMLElement;
    // The bin-mode cluster — the SAME `|— retention —| ⋯` a bin ROW shows. Its two
    // decisions are menu items, not bare buttons: Restore then Delete permanently.
    const cluster = v.el.querySelector(".viewer__bin-actions") as HTMLElement;
    const items = () => Array.from(cluster.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));

    // From the bin the file is ALREADY trashed: re-trashing is nonsense, and its
    // two real decisions are Restore and Delete permanently.
    v.open(meta({ fileType: type }), 0, { kind: "bin", folderPath: "Note / Files", retention: { daysLeft: 30, soon: false, retentionDays: 30 } }, "");
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
    v.open(meta({ fileType: type }), 0, FOLDER, "");
    expect(moveBin.hidden).toBe(false);
    expect(cluster.hidden).toBe(true);
    v.destroy();
  });

  it("the ⋯ menu's Restore and Delete permanently hand the open file to the shell's bin callbacks", () => {
    const onRestore = vi.fn();
    const onPurge = vi.fn();
    const v = make(deps({ onRestore, onPurge }));
    document.body.append(v.el);
    const m = meta({ id: "n-gone", name: "trashed", fileType: type });
    v.open(m, 0, { kind: "bin", folderPath: null, retention: { daysLeft: 4, soon: true, retentionDays: 30 } }, "");

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

  it("Back names where it returns to, per origin", () => {
    const v = make(deps());
    const label = v.el.querySelector(".viewer__back-label") as HTMLElement;
    v.open(meta({ fileType: type }), 0, { kind: "folder", folderPath: "Note / Files" }, "");
    expect(label.textContent).toBe("Files");
    v.open(meta({ fileType: type }), 0, { kind: "search", folderPath: "Note / Files" }, "");
    expect(label.textContent).toBe("Search");
    v.open(meta({ fileType: type }), 0, { kind: "bin", folderPath: null }, "");
    expect(label.textContent).toBe("Recycle bin");
    v.open(meta({ fileType: type }), 0, { kind: "folder", folderPath: null }, "");
    expect(label.textContent).toBe("Library");
    v.destroy();
  });

  it("points Download at the versioned raw-file URL with the attachment flag", () => {
    const v = make(deps());
    document.body.append(v.el);
    v.open(meta({ id: "n-1", fileHash: "b".repeat(32), fileType: type }), 0, FOLDER, "");
    const trigger = v.el.querySelector('[aria-label="Download"]') as HTMLElement;

    if (type === "spd") {
      // The `.spd` Download is a MENU (export matrix + the raw `.spd`); the raw
      // file is one item that navigates to the versioned URL on click via a
      // transient `<a download>`. Open the menu and capture that anchor's href.
      expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
      trigger.click();
      const raw = Array.from(v.el.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find((b) =>
        b.textContent?.includes("Atelier sketch"),
      )!;
      expect(raw).toBeTruthy();
      expect(raw.disabled).toBe(false);
      let href: string | null = null;
      const clickSpy = vi
        .spyOn(HTMLAnchorElement.prototype, "click")
        .mockImplementation(function (this: HTMLAnchorElement) {
          href = this.getAttribute("href");
        });
      raw.click();
      clickSpy.mockRestore();
      expect(href).toMatch(/^\/file\/n-1\?v=b{32}&download=1$/);
    } else {
      const dl = trigger as HTMLAnchorElement;
      expect(dl.hidden).toBe(false);
      expect(dl.getAttribute("href")).toMatch(/^\/file\/n-1\?v=b{32}&download=1$/);
    }
    v.destroy();
  });

  it("in the bin context, Download points at the BIN-scoped raw route", () => {
    // The live `/file/{id}` goes through `Files.get` (`deleted = 0`) and 404s
    // for anything trashed — the reader's precedent is that download from the
    // bin stays offered, so it has to come off the bin's own route.
    const v = make(deps());
    document.body.append(v.el);
    v.open(meta({ id: "n-1", fileHash: "b".repeat(32), fileType: type }), 0, { kind: "bin", folderPath: null }, "");
    const trigger = v.el.querySelector('[aria-label="Download"]') as HTMLElement;

    if (type === "spd") {
      trigger.click();
      const raw = Array.from(v.el.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find((b) =>
        b.textContent?.includes("Atelier sketch"),
      )!;
      let href: string | null = null;
      const clickSpy = vi
        .spyOn(HTMLAnchorElement.prototype, "click")
        .mockImplementation(function (this: HTMLAnchorElement) {
          href = this.getAttribute("href");
        });
      raw.click();
      clickSpy.mockRestore();
      expect(href).toMatch(/^\/api\/controlplane\/bin\/file\/n-1\?v=b{32}&download=1$/);
    } else {
      const dl = trigger as HTMLAnchorElement;
      expect(dl.getAttribute("href")).toMatch(/^\/api\/controlplane\/bin\/file\/n-1\?v=b{32}&download=1$/);
    }
    v.destroy();
  });

  it("hide() takes it back off the layer", () => {
    const v = make(deps());
    document.body.append(v.el);
    v.open(meta({ fileType: type }), 0, FOLDER, "");
    expect(v.el.hidden).toBe(false);
    v.hide();
    expect(v.el.hidden).toBe(true);
    v.destroy();
  });
});
