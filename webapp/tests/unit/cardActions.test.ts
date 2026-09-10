// @vitest-environment happy-dom
//
// `pages/cardActions.ts` — the whole-document PDF export, launched from a card's
// overflow menu.
//
// WHAT THIS IS HERE FOR: a document export is a JOB, not a click. The menu item
// that starts one closes the instant it is chosen, which was taken to mean there
// was no control left to guard — but nothing then stops a second choice from
// starting a SECOND full export beside the first. On a 1703-page notebook that
// is ~243 MB of PDF built twice at once, held as heap chunks until the Blob
// exists, and it is the natural thing to click when nothing has downloaded yet.

import { describe, it, expect, vi } from "vitest";
import { createCardActions, type CardActionsCtx } from "../../src/pages/cardActions";
import type { Entry } from "../../src/core/types";

function noteEntry(): Entry {
  return {
    kind: "note",
    id: "n-1",
    name: "20260804_145245.note",
    pageCount: 1703,
    firstPage: { index: 0, hash: "h", width: 1404, height: 1872, textHash: null, linksHash: null },
    updatedAt: 0,
    fileType: "note",
    fileHash: "abc",
    hasRecognizedText: false,
    annotationsId: null,
  };
}

interface Harness {
  menu: HTMLElement;
  toast: ReturnType<typeof vi.fn>;
  documentPdf: ReturnType<typeof vi.fn>;
  /** Let the in-flight export finish. */
  finish: () => void;
}

function harness(): Harness {
  let release!: () => void;
  const pending = new Promise<void>((r) => {
    release = r;
  });

  const documentPdf = vi.fn(async () => {
    await pending;
    return {
      blob: new Blob([new Uint8Array([1, 2, 3])], { type: "application/pdf" }),
      filename: "20260804_145245.pdf",
      kind: "raster" as const,
    };
  });

  const toast = vi.fn();
  const ctx = {
    api: { getNoteMeta: async () => ({ name: "n", pages: [{ index: 0 }] }) },
    exporter: { documentPdf },
    toast,
    handled: () => false,
    sessionDidExpire: () => {},
    onTrash: () => {},
    onRename: () => {},
    isCategoryRoot: () => false,
    onHistory: () => {},
  } as unknown as CardActionsCtx;

  const menu = createCardActions(ctx).cardMenu(noteEntry());
  document.body.append(menu);
  return { menu, toast, documentPdf, finish: release };
}

/** The "PDF document" row in the DOWNLOAD section. */
function pdfItem(menu: HTMLElement): HTMLButtonElement {
  const btn = Array.from(menu.querySelectorAll("button")).find((b) =>
    b.textContent?.includes("PDF document"),
  );
  if (!btn) throw new Error("no 'PDF document' item in the card menu");
  return btn as HTMLButtonElement;
}

describe("the whole-document PDF export, from a card", () => {
  it("STARTS ONE JOB for a second click while the first is still running", async () => {
    const h = harness();
    const item = pdfItem(h.menu);

    item.click();
    await Promise.resolve();
    item.click();
    await Promise.resolve();

    // The second click must not have launched a second export beside the first.
    expect(h.documentPdf).toHaveBeenCalledTimes(1);

    h.finish();
  });

  it("tells the user the export is already running, rather than failing silently", async () => {
    const h = harness();
    const item = pdfItem(h.menu);

    item.click();
    await Promise.resolve();
    h.toast.mockClear();
    item.click();
    await Promise.resolve();

    expect(h.toast).toHaveBeenCalledWith(
      "An export is already running — it will download when it finishes.",
    );

    h.finish();
  });

  it("lets a LATER export run once the first has finished", async () => {
    // The guard is not a one-shot latch: it has to clear, or the first export of
    // a session would be the only one the page ever allows.
    const h = harness();
    const item = pdfItem(h.menu);

    item.click();
    await Promise.resolve();
    h.finish();
    // Let the export's `finally` run.
    await new Promise((r) => setTimeout(r, 0));

    item.click();
    await Promise.resolve();
    expect(h.documentPdf).toHaveBeenCalledTimes(2);
  });
});

// ============================================================================
// The two history rows — and the fact that they are two.
// ============================================================================
//
// A `.pdf` has no version history the app can paint, so `canPreviewHistory`
// excludes it and must go on excluding it: offering "Version history" on a PDF
// would promise a past document, and there is none. What a PDF can have is a
// paired `.mark`, whose every superseded version is retained AND charged to the
// user's quota — and which has no card of its own, because the server folds a
// paired mark out of every listing. Before this row the only way to reach any of
// it was to trash the PDF, which unpairs the mark and lets it list.
//
// So the row exists, and its LABEL is the point: what is versioned here is the
// handwriting, not the file on screen, and the menu is the first place that can
// say so.

/** The labels of every row in a card's ⋯ menu, in document order. */
function rowLabels(entry: Entry, over: Partial<CardActionsCtx> = {}): string[] {
  const ctx = {
    api: {},
    exporter: {},
    toast: () => {},
    handled: () => false,
    sessionDidExpire: () => {},
    onTrash: () => {},
    onRename: () => {},
    isCategoryRoot: () => false,
    onHistory: () => {},
    onAnnotationHistory: () => {},
    ...over,
  } as unknown as CardActionsCtx;
  const menu = createCardActions(ctx).cardMenu(entry);
  return Array.from(menu.querySelectorAll<HTMLButtonElement>("button[role=menuitem]")).map(
    (b) => b.textContent ?? "",
  );
}

function pdfEntry(annotationsId: string | null): Entry {
  return {
    kind: "note",
    id: "178",
    name: "Appliance manual.pdf",
    pageCount: 4,
    firstPage: { index: 0, hash: "h", width: 612, height: 792, textHash: null, linksHash: null },
    updatedAt: 0,
    fileType: "pdf",
    fileHash: "abc",
    hasRecognizedText: false,
    annotationsId,
  };
}

describe("the card's history rows", () => {
  it("offers ANNOTATION history on a PDF that has a paired mark", () => {
    expect(rowLabels(pdfEntry("179"))).toContain("Annotation history");
    // And never the note wording, which would claim the document has versions.
    expect(rowLabels(pdfEntry("179"))).not.toContain("Version history");
  });

  it("offers NOTHING on a PDF with no mark — there is no history to reach", () => {
    const labels = rowLabels(pdfEntry(null));
    expect(labels).not.toContain("Annotation history");
    expect(labels).not.toContain("Version history");
    // The rest of the menu is untouched: a plain PDF still trashes and renames.
    expect(labels).toEqual(expect.arrayContaining(["Rename", "Move to bin"]));
  });

  it("hands the panel the MARK's id under the DOCUMENT's name", () => {
    // `foo.pdf.mark` is a filename the device invented; the heading has to be the
    // one the reader recognises, so the id and the name come from different files
    // — which is exactly why this is a separate seam from `onHistory`.
    const onAnnotationHistory = vi.fn();
    const entry = pdfEntry("179");
    const ctx = {
      api: {},
      exporter: {},
      toast: () => {},
      handled: () => false,
      sessionDidExpire: () => {},
      onTrash: () => {},
      onRename: () => {},
      isCategoryRoot: () => false,
      onHistory: () => {},
      onAnnotationHistory,
    } as unknown as CardActionsCtx;
    const menu = createCardActions(ctx).cardMenu(entry);
    document.body.append(menu);
    const row = Array.from(menu.querySelectorAll<HTMLButtonElement>("button[role=menuitem]")).find(
      (b) => b.textContent === "Annotation history",
    );
    row?.click();
    expect(onAnnotationHistory).toHaveBeenCalledTimes(1);
    expect(onAnnotationHistory.mock.calls[0]?.[0]).toBe(entry);
    expect(onAnnotationHistory.mock.calls[0]?.[1]).toBe("179");
  });

  it("leaves a .note's own Version history exactly where it was", () => {
    const labels = rowLabels(noteEntry());
    expect(labels).toContain("Version history");
    expect(labels).not.toContain("Annotation history");
  });

  it("offers neither on a folder", () => {
    const folder: Entry = { kind: "folder", id: "f-1", name: "Manuals", updatedAt: 0 };
    const labels = rowLabels(folder);
    expect(labels).not.toContain("Version history");
    expect(labels).not.toContain("Annotation history");
  });
});
