// @vitest-environment happy-dom
// Helpers shared by the viewerStubs tests.

import { vi } from "vitest";
import { type PdfSeam } from "../../src/pages/pdfViewer";
import type { ViewerDeps, ReaderOrigin } from "../../src/pages/viewer";
import type { NoteMeta } from "../../src/core/types";

/** Deps whose callbacks are spies — the seam's only observable effects. */
export function deps(over: Partial<ViewerDeps> = {}): ViewerDeps {
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
export function meta(over: Partial<NoteMeta> = {}): NoteMeta {
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
export const INERT_PDF_SEAM: PdfSeam = {
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

export const FOLDER: ReaderOrigin = { kind: "folder", folderPath: "Note / Files" };
