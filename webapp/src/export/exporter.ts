// Export one page of a note as a PNG or a PDF, entirely in the browser.
//
// NOTHING HERE ROUND-TRIPS TO THE SERVER FOR PIXELS. The SPA already decodes
// pages through the WASM renderer, and moving rasterisation into the browser is
// this project's settled architecture (docs/explanation/client-side-rendering.md)
// — asking a 50 MB-budget server to render a page it just streamed would undo it.
//
// Exports are DOWNLOAD-ONLY. They do not land in the device's `EXPORT/` folder,
// which is what keeps them clear of the `absence = deletion` reconciliation
// question entirely (docs/explanation/reconciliation-and-sync-safety.md).

import type { Api } from "../api/types";
import type { Id, NoteMeta, PageRef, WordBox } from "../core/types";
import type { PdfLink } from "../render/pdfLinks";
import type { NoteRenderer } from "../render/types";
import { buildPdf, placeWords, type PdfPage } from "./pdf";

export interface ExporterDeps {
  api: Api;
  renderer: NoteRenderer;
}

/** What a PDF export actually produced — the UI reports this, honestly. */
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

/** Told which page is being worked on, 1-based, out of how many. */
export type ProgressFn = (done: number, total: number) => void;

export interface Exporter {
  pagePng(meta: NoteMeta, page: PageRef): Promise<PngResult>;
  pagePdf(meta: NoteMeta, page: PageRef): Promise<PdfResult>;
  /**
   * A single page's PDF built from an ALREADY-RENDERED page image — the reader's
   * layer view, flattened by `export/layered.ts` — rather than a fresh composite
   * decode. The invisible OCR text layer is the SAME one {@link pagePdf} places
   * (word positions are device millimetres, independent of which layers are
   * drawn), so a "current" and an "original" view carry identical selectable text
   * over different pixels. `image` MUST be at the page's EFFECTIVE dims (the layer
   * model's), so a landscape page exports wide, not sheared. The caller owns the
   * filename (it knows the view); this returns the blob and its honest `kind`.
   */
  pagePdfFromImage(meta: NoteMeta, page: PageRef, image: HTMLCanvasElement): Promise<{ blob: Blob; kind: PdfKind }>;
  /**
   * The WHOLE notebook as one PDF, decoded and written page by page — see
   * `documentFilename` for the name and `export/pdf.ts` for why the writer takes
   * a generator rather than a list.
   */
  documentPdf(meta: NoteMeta, onProgress?: ProgressFn): Promise<PdfResult>;
}

/**
 * Strip the note's extension and any path, then make it safe for a filename.
 * Device-authored names reach this, so `/` and friends are not optional to
 * handle — `Save as` would otherwise interpret them. Exported for the layered
 * exports (pages/noteLayers.ts) so every export family names notes identically.
 */
export function filenameStem(name: string): string {
  const base = name
    .replace(/\.[^./\\]+$/, "") // the note's own extension
    .replace(/[/\\:*?"<>|]+/g, "-") // characters a filename cannot carry
    .replace(/^[-\s]+|[-\s]+$/g, ""); // ...which must not become the whole name
  return base === "" ? "note" : base;
}

/** A single page's export: the note's name plus the 1-based page it came from. */
export function exportFilename(name: string, pageIndex: number, ext: string): string {
  return `${filenameStem(name)}-p${pageIndex + 1}.${ext}`;
}

/**
 * A whole-notebook export: the note's name and nothing else. NO `-p` suffix —
 * the whole point of the distinction is that a file called `Weekly review.pdf`
 * sitting next to `Weekly review-p3.pdf` says which is which without opening
 * either.
 */
export function documentFilename(name: string, ext: string): string {
  return `${filenameStem(name)}.${ext}`;
}

/**
 * Decode one page at NATIVE resolution, in the light theme, straight from the
 * renderer.
 *
 * Deliberately NOT through `render/lazy.ts`'s cached `renderPage`: that path
 * exists to feed the screen, so it is keyed by the CURRENT theme and capped at
 * the "full" display tier. An export wants neither. A dark-theme export would
 * hand someone white-on-black ink to print, and a downscaled one would quietly
 * make "export" mean "export, smaller". Bypassing the cache also keeps
 * full-resolution page bitmaps out of the IndexedDB budget.
 */
async function nativeBitmap(deps: ExporterDeps, noteId: Id, page: PageRef): Promise<ImageBitmap> {
  const bytes = await deps.api.getPageBytes(noteId, page);
  const decoded = await deps.renderer.render({ bytes, noteId, page, size: "native", theme: "light" });
  return decoded.bitmap;
}

/** Draw a bitmap 1:1 onto a canvas and hand back the 2D context. */
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

/**
 * RGBA → one byte per pixel. The decoder emits opaque grayscale (see
 * `render/wasm.ts`), so the red channel IS the luminance and there is nothing to
 * average; taking one channel keeps the PDF's `/DeviceGray` image a quarter the
 * size of the RGBA it came from before Flate even sees it.
 */
export function toGray(rgba: Uint8ClampedArray, width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height);
  for (let i = 0; i < out.length; i++) out[i] = rgba[i * 4]!;
  return out;
}

/**
 * THE ONE INTEGRATION POINT with the reader half of `.note` links.
 *
 * `Api` gains `getPageLinks(id, page): Promise<PageLinks>` alongside
 * `getPageText` — same shape, same per-page immutable URL, same lazy fetch
 * (docs/scratch/note-links.md §1). It is PROBED rather than called outright, and
 * that is not defensiveness about the endpoint: an `Api` is also what the reader's
 * own stubs and any older client hand this exporter, and the answer for one that
 * cannot serve links is a PDF without annotations — never a failed export.
 *
 * The signature is stated here rather than imported so this file keeps compiling
 * either side of that change; the shape is checked at the seam, once, and a
 * mismatch degrades exactly like a missing endpoint.
 */
type PageLinksFn = (id: Id, page: PageRef) => Promise<{ links: readonly PdfLink[] }>;

/**
 * The page's links, or none — **never a rejection**. Same posture as the
 * transcript below it: a links request that fails must not cost someone their
 * export, because a PDF whose planner tabs do nothing is still the pages.
 *
 * `raster` is the size of the image the links are about to be placed on, when
 * the caller has one that might not be the page at its native size. A link's
 * rect is DEVICE PANEL PIXELS, so it only means anything over the page as the
 * device drew it — and the layered exports hand over the layer model's
 * EFFECTIVE dims, which for a landscape page is the panel on its side. Rather
 * than guess at a rotation, those links are refused here, before the request is
 * even made: a page with no annotations is honest, and annotations a quarter
 * turn out of place are not.
 *
 * EXPORTED FOR ITS TEST, which is the only way to pin the probe and that rule:
 * everything around them needs a 2D context and lives in the Playwright layer.
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

/** The page's transcript, or none — see {@link pageLinks} for the posture. */
async function pageWords(api: Api, id: Id, page: PageRef): Promise<WordBox[]> {
  try {
    return (await api.getPageText(id, page)).words;
  } catch {
    return [];
  }
}

/**
 * The page's text layer, or null when it must not be drawn.
 *
 * Two independent reasons to return null, and they are checked in this order
 * because the first is about the HARDWARE and the second is about the DATA:
 *
 *  1. `meta.pxPerMm` is null — the server has not verified the millimetre scale
 *     for this device, so any placement would be a guess. See `NoteMeta.pxPerMm`.
 *  2. The scaled boxes fail `placeWords`' bounds check — the scale we do have
 *     disagrees with this page.
 *
 * Both produce a raster-only PDF, which the caller reports as such.
 */
function textLayerFor(meta: NoteMeta, words: WordBox[], width: number, height: number) {
  if (meta.pxPerMm === null || words.length === 0) return null;
  const layer = { pxPerMm: meta.pxPerMm, words };
  const placed = placeWords(layer, width, height);
  if (placed === null || placed.length === 0) return null;
  return layer;
}

/**
 * One page, decoded and reduced to exactly what the PDF writer wants: the
 * grayscale bytes and the text layer, if any.
 *
 * THE BITMAP AND THE CANVAS ARE RELEASED HERE, before returning. For a single
 * page that is tidiness; for a 40-page document it is the difference between a
 * bounded export and a tab the phone kills — the caller holds only the `gray`
 * buffer onward, and drops that as soon as the writer has deflated it.
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

  // The words are free when the page has no recognition (`textHash === null`
  // short-circuits in the client) and an immutable cache hit otherwise — the
  // OCR panel already asked for this exact URL if it was ever opened. The links
  // are the same lazy per-page fetch, and the two go out TOGETHER: they are
  // independent, and on the 3G link this app is built for, a 1703-page export
  // would otherwise pay both round trips end to end, per page.
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
        // NO `pageCount`, and that is the whole of §2.5: one page is not the
        // document, so an internal link in it — a month tab, an index row —
        // points at a page this file does not contain. They are dropped and the
        // external links are kept. See `PdfOptions.pageCount`.
        blob: await buildPdf([pdfPage]),
        filename: exportFilename(meta.name, page.index, "pdf"),
        kind: pdfPage.textLayer ? "searchable" : "raster",
      };
    },

    async pagePdfFromImage(meta: NoteMeta, page: PageRef, image: HTMLCanvasElement) {
      const { width, height } = image;
      const ctx = image.getContext("2d");
      if (!ctx) throw new Error("2d context unavailable");
      // The layer flatten is grayscale ink on a filled sheet, so the red channel
      // IS the luminance — the same reduction `pdfPageOf` does after a composite
      // decode, and what keeps the /DeviceGray image a quarter of its RGBA size.
      const gray = toGray(ctx.getImageData(0, 0, width, height).data, width, height);

      // The words are the SAME the composite PDF places — positional, so they do
      // not care which layers were drawn into the image above. Free on a page with
      // no recognition; an immutable cache hit otherwise. A failure degrades to a
      // raster-only PDF rather than costing the user their export.
      const words = await pageWords(deps.api, meta.id, page);

      // THE LINKS ARE NOT POSITIONAL IN THE SAME WAY the words are: they are
      // device panel pixels, and this image is at the layer model's EFFECTIVE
      // dims. Handing `pageLinks` the raster it is about to place them on is
      // what makes it refuse the one case where those two differ — see there.
      const links = await pageLinks(deps.api, meta.id, page, { width, height });

      const textLayer = textLayerFor(meta, words, width, height);
      return {
        // One page, so no `pageCount` and no internal links — the same rule
        // `pagePdf` above states.
        blob: await buildPdf([{ width, height, gray, links, textLayer }]),
        kind: (textLayer ? "searchable" : "raster") as PdfKind,
      };
    },

    async documentPdf(meta: NoteMeta, onProgress?: ProgressFn): Promise<PdfResult> {
      const total = meta.pages.length;
      if (total === 0) throw new Error("documentPdf: the file has no pages");

      // Set by the generator as it goes, read only once `buildPdf` has resolved
      // — i.e. after every page has been through it. `kind` is the honest OR:
      // "searchable" means SOME page carries text, which is the truth for a
      // notebook where recognition was run on a few pages and not the rest.
      let anyText = false;

      // THE GENERATOR IS THE WHOLE DESIGN. `buildPdf` pulls one page from it,
      // deflates it, writes it out, and only then asks for the next; nothing
      // here keeps a reference to a page it has already yielded, so the raw
      // 2.63 MB buffer of page k is collectable while page k+1 is being decoded.
      // Materialising these into an array first — the obvious `for` loop — is
      // exactly the shape this export exists to avoid.
      async function* stream(): AsyncGenerator<PdfPage> {
        for (const page of meta.pages) {
          onProgress?.(page.index + 1, total);
          const pdfPage = await pdfPageOf(deps, meta, page);
          if (pdfPage.textLayer) anyText = true;
          yield pdfPage;
        }
      }

      // `pageCount` is what makes this the export that keeps INTERNAL links: the
      // document is the note, in note order, so note page `k` is document page
      // `k` and a link to it resolves — even to a page 1700 pages further on
      // that has not been written yet.
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
 * What to say when a PDF export lands.
 *
 * ONE OWNER, because this sentence was written three times — the reader's
 * per-page export, the reader's whole-document export and the library card's —
 * and three copies of a sentence are three chances for the same action to be
 * described differently depending on where it was started.
 *
 * IT SAYS WHAT THE USER GOT, NOT HOW IT WAS DECIDED. The old raster wording was
 * "image only (no verified text placement for this device)", which names an
 * internal calibration nobody can act on and does not answer the only question
 * being asked: can I select the text in this file? So the answer leads, in the
 * same verbs both ways ("selected and searched"), and the reason is left out —
 * a toast is not the place to explain how recognition is scaled.
 *
 * The searchable case is deliberately hedged. `kind` is an honest OR across the
 * document: it means SOME page carries text, which for a notebook where
 * recognition was run on a few pages is exactly right, so promising selectable
 * text outright would overclaim on all the others.
 *
 * @param pages Page count for a whole-document export; omit for a single page.
 */
export function savedPdfMessage(filename: string, kind: PdfKind, pages?: number): string {
  const scope = pages === undefined ? "" : ` — ${pages} ${pages === 1 ? "page" : "pages"}`;
  if (kind === "searchable") {
    return `Saved ${filename}${scope}. Recognised handwriting can be selected and searched.`;
  }
  // "It is an image" would be a lie about a 1703-page export, and the kind of
  // small wrongness that makes the rest of a message read as boilerplate.
  const what = pages === undefined || pages === 1 ? "The page is an image" : "The pages are images";
  return `Saved ${filename}${scope}. ${what}, so the text cannot be selected or searched.`;
}

/** Hand a generated blob to the browser as a download, then release it. */
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
