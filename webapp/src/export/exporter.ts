// Export a note page or notebook as PNG or PDF, rasterised entirely in the
// browser. Exports are download-only: they never land in the device's `EXPORT/`
// folder, staying clear of absence-means-deletion sync.

import type { Api } from "../api/types";
import type { Id, NoteMeta, PageRef, WordBox } from "../core/types";
import type { PdfLink } from "../core/types";
import type { NoteRenderer } from "../render/types";
import { buildPdf, placeWords, type PdfPage } from "./pdf";

export interface ExporterDeps {
  api: Api;
  renderer: NoteRenderer;
}

export type PdfKind = "searchable" | "raster";

export interface PdfResult {
  blob: Blob;
  filename: string;
  kind: PdfKind;
}

export interface PngResult {
  blob: Blob;
  filename: string;
}

/** 1-based page being worked on, out of `total`. */
export type ProgressFn = (done: number, total: number) => void;

export interface Exporter {
  pagePng(meta: NoteMeta, page: PageRef): Promise<PngResult>;
  pagePdf(meta: NoteMeta, page: PageRef): Promise<PdfResult>;
  /**
   * A single page's PDF from an already-flattened layer view. `image` must be at
   * the page's effective dims (landscape exports wide). Same OCR layer as
   * {@link pagePdf}, since word positions don't depend on layers.
   */
  pagePdfFromImage(meta: NoteMeta, page: PageRef, image: HTMLCanvasElement): Promise<{ blob: Blob; kind: PdfKind }>;
  /** The whole notebook as one PDF, decoded and written page by page. */
  documentPdf(meta: NoteMeta, onProgress?: ProgressFn): Promise<PdfResult>;
}

/** A filename-safe stem; device-authored names can contain `/`. */
export function filenameStem(name: string): string {
  const base = name
    .replace(/\.[^./\\]+$/, "") // the note's own extension
    .replace(/[/\\:*?"<>|]+/g, "-") // characters a filename cannot carry
    .replace(/^[-\s]+|[-\s]+$/g, ""); // ...which must not become the whole name
  return base === "" ? "note" : base;
}

export function exportFilename(name: string, pageIndex: number, ext: string): string {
  return `${filenameStem(name)}-p${pageIndex + 1}.${ext}`;
}

/** A whole-notebook export: the note's name, with no `-p` suffix. */
export function documentFilename(name: string, ext: string): string {
  return `${filenameStem(name)}.${ext}`;
}

/**
 * Decode one page at native resolution in the light theme, bypassing
 * `render/lazy.ts`'s cache (keyed by current theme, capped at display size, and
 * would put full-res bitmaps in the IndexedDB budget).
 */
async function nativeBitmap(deps: ExporterDeps, noteId: Id, page: PageRef): Promise<ImageBitmap> {
  const bytes = await deps.api.getPageBytes(noteId, page);
  const decoded = await deps.renderer.render({ bytes, noteId, page, size: "native", theme: "light" });
  return decoded.bitmap;
}

function paint(bitmap: ImageBitmap): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d context unavailable");
  ctx.drawImage(bitmap, 0, 0);
  return canvas;
}

function canvasBlob(canvas: HTMLCanvasElement, type: string): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error(`toBlob failed for ${type}`))), type);
  });
}

/** RGBA to one byte per pixel: the decoder emits opaque gray, so red is luminance. */
export function toGray(rgba: Uint8ClampedArray, width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height);
  for (let i = 0; i < out.length; i++) out[i] = rgba[i * 4]!;
  return out;
}

/**
 * `Api.getPageLinks`, probed rather than called: a stub or older `Api` without
 * it yields a PDF without annotations, never a failed export.
 */
type PageLinksFn = (id: Id, page: PageRef) => Promise<{ links: readonly PdfLink[] }>;

/**
 * The page's links, or none; never rejects. Link rects are device panel pixels,
 * so when `raster` differs from the native page (a landscape layer model's
 * effective dims) they are refused rather than guessed at a rotation.
 * Exported for its test.
 */
export async function pageLinks(
  api: Api,
  id: Id,
  page: PageRef,
  raster?: { width: number; height: number },
): Promise<readonly PdfLink[]> {
  if (raster && (raster.width !== page.width || raster.height !== page.height)) return [];
  const get = (api as unknown as { getPageLinks?: PageLinksFn }).getPageLinks;
  if (typeof get !== "function") return [];
  try {
    const got = await get.call(api, id, page);
    return got?.links ?? [];
  } catch {
    return [];
  }
}

/** The page's transcript, or none; never rejects. */
async function pageWords(api: Api, id: Id, page: PageRef): Promise<WordBox[]> {
  try {
    return (await api.getPageText(id, page)).words;
  } catch {
    return [];
  }
}

/**
 * The page's text layer, or null when `meta.pxPerMm` is unverified or the
 * boxes fail `placeWords`' bounds check (either way: raster-only PDF).
 */
function textLayerFor(meta: NoteMeta, words: WordBox[], width: number, height: number) {
  if (meta.pxPerMm === null || words.length === 0) return null;
  const layer = { pxPerMm: meta.pxPerMm, words };
  const placed = placeWords(layer, width, height);
  if (placed === null || placed.length === 0) return null;
  return layer;
}

/**
 * One page reduced to grayscale bytes and text layer. Releases the bitmap and
 * canvas before returning, keeping a long export's memory bounded.
 */
async function pdfPageOf(deps: ExporterDeps, meta: NoteMeta, page: PageRef): Promise<PdfPage> {
  const bitmap = await nativeBitmap(deps, meta.id, page);
  const canvas = paint(bitmap);
  const ctx = canvas.getContext("2d")!;
  const { width, height } = canvas;
  const gray = toGray(ctx.getImageData(0, 0, width, height).data, width, height);
  bitmap.close();
  canvas.width = 0;
  canvas.height = 0;

      // Words and links fetched together: independent, and paying two round
      // trips per page in series hurts a long export on a slow link.
  const [words, links] = await Promise.all([
    pageWords(deps.api, meta.id, page),
    pageLinks(deps.api, meta.id, page),
  ]);

  return { width, height, gray, links, textLayer: textLayerFor(meta, words, width, height) };
}

export function createExporter(deps: ExporterDeps): Exporter {
  return {
    async pagePng(meta: NoteMeta, page: PageRef): Promise<PngResult> {
      const canvas = paint(await nativeBitmap(deps, meta.id, page));
      return {
        blob: await canvasBlob(canvas, "image/png"),
        filename: exportFilename(meta.name, page.index, "png"),
      };
    },

    async pagePdf(meta: NoteMeta, page: PageRef): Promise<PdfResult> {
      const pdfPage = await pdfPageOf(deps, meta, page);
      return {
        // No `pageCount`: a single page drops internal links, keeps external ones.
        blob: await buildPdf([pdfPage]),
        filename: exportFilename(meta.name, page.index, "pdf"),
        kind: pdfPage.textLayer ? "searchable" : "raster",
      };
    },

    async pagePdfFromImage(meta: NoteMeta, page: PageRef, image: HTMLCanvasElement) {
      const { width, height } = image;
      const ctx = image.getContext("2d");
      if (!ctx) throw new Error("2d context unavailable");
      const gray = toGray(ctx.getImageData(0, 0, width, height).data, width, height);

      const words = await pageWords(deps.api, meta.id, page);

      // Links are device panel pixels; pass the raster dims so a mismatch is refused.
      const links = await pageLinks(deps.api, meta.id, page, { width, height });

      const textLayer = textLayerFor(meta, words, width, height);
      return {
        blob: await buildPdf([{ width, height, gray, links, textLayer }]),
        kind: (textLayer ? "searchable" : "raster") as PdfKind,
      };
    },

    async documentPdf(meta: NoteMeta, onProgress?: ProgressFn): Promise<PdfResult> {
      const total = meta.pages.length;
      if (total === 0) throw new Error("documentPdf: the file has no pages");

      // "searchable" means some page carries text.
      let anyText = false;

      // A generator, so only the page in flight is ever held; never an array.
      async function* stream(): AsyncGenerator<PdfPage> {
        for (const page of meta.pages) {
          onProgress?.(page.index + 1, total);
          const pdfPage = await pdfPageOf(deps, meta, page);
          if (pdfPage.textLayer) anyText = true;
          yield pdfPage;
        }
      }

      // `pageCount` keeps internal links: document page `k` is note page `k`.
      const blob = await buildPdf(stream(), { pageCount: total });
      return {
        blob,
        filename: documentFilename(meta.name, "pdf"),
        kind: anyText ? "searchable" : "raster",
      };
    },
  };
}

/**
 * The toast for a finished PDF export: says whether text can be selected,
 * hedged because `kind` is an OR across pages.
 *
 * @param pages Page count for a whole-document export; omit for a single page.
 */
export function savedPdfMessage(filename: string, kind: PdfKind, pages?: number): string {
  const scope = pages === undefined ? "" : ` — ${pages} ${pages === 1 ? "page" : "pages"}`;
  if (kind === "searchable") {
    return `Saved ${filename}${scope}. Recognised handwriting can be selected and searched.`;
  }
  const what = pages === undefined || pages === 1 ? "The page is an image" : "The pages are images";
  return `Saved ${filename}${scope}. ${what}, so the text cannot be selected or searched.`;
}

export function download(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
