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
