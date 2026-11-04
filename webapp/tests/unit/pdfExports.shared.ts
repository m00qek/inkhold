// @vitest-environment happy-dom
// Helpers shared by the pdfExports tests.

import { composeMarkExportModel } from "../../src/pages/pdf/pdfExports";
import { type CanvasFactory, type LayeredExportModel } from "../../src/export/layered";
import type { PdfInkOverlay } from "../../src/render/pdfClient";

// --- fakes ------------------------------------------------------------------

/** Everything one recorded canvas saw: its size, its draws, its fills. */
export interface Recorded {
  id: string;
  width: number;
  height: number;
  draws: { src: string; args: number[] }[];
  fills: string[];
  /** The coverage this canvas holds, 0..255: the strongest alpha seen, times `globalAlpha`. */
  alpha: number;
}

/** A canvas factory whose canvases record instead of rasterising. */
export function recorder(): { make: CanvasFactory; made: Recorded[] } {
  const made: Recorded[] = [];
  let n = 0;
  const make: CanvasFactory = (w, h) => {
    const rec: Recorded = { id: `made${n++}`, width: w, height: h, draws: [], fills: [], alpha: 0 };
    made.push(rec);
    const ctx = {
      globalAlpha: 1,
      fillStyle: "",
      fillRect(): void {
        rec.fills.push(String(ctx.fillStyle));
      },
      drawImage(src: { __id?: string; __alpha?: number }, ...args: number[]): void {
        rec.draws.push({ src: src.__id ?? "?", args });
        rec.alpha = Math.max(rec.alpha, Math.round((src.__alpha ?? 0) * ctx.globalAlpha));
      },
      /** RGB zero, alpha carried, so a reader of any channel but alpha sees no ink. */
      getImageData(_x: number, _y: number, w: number, h: number): { data: Uint8ClampedArray } {
        const data = new Uint8ClampedArray(w * h * 4);
        for (let i = 0; i < w * h; i++) data[i * 4 + 3] = rec.alpha;
        return { data };
      },
    };
    return {
      __id: rec.id,
      get __alpha(): number {
        return rec.alpha;
      },
      width: w,
      height: h,
      getContext: () => ctx,
      toBlob: (cb: (b: Blob | null) => void) => cb(new Blob([new Uint8Array([1])])),
    } as unknown as HTMLCanvasElement;
  };
  return { make, made };
}

/** A stand-in for one decoded ink layer's own canvas — identity, coverage, `toBlob`. */
export function sourceCanvas(id: string, alpha = 255): HTMLCanvasElement {
  return {
    __id: id,
    __alpha: alpha,
    width: 1404,
    height: 1872,
    toBlob: (cb: (b: Blob | null) => void) => cb(new Blob([new Uint8Array([2])])),
  } as unknown as HTMLCanvasElement;
}

export const A4 = { width: 595.276, height: 841.89 };

/** The real capture's shape: ONE ink layer, MAINLAYER, and no background slot. */
export const MAIN = { name: "Main Layer", canvas: sourceCanvas("ink"), visible: true, authoredVisible: true };

// --- 1. the composition -----------------------------------------------------

/** A composed model at a size a test can read pixel by pixel. */
export function tinyModel(
  ink: { name: string; canvas: HTMLCanvasElement; visible: boolean; authoredVisible: boolean }[],
  pageVisible = true,
): LayeredExportModel {
  return composeMarkExportModel({
    space: { width: 4, height: 3, dx: 0, dy: 0 },
    page: sourceCanvas("pdf"),
    pageVisible,
    ink,
    makeCanvas: recorder().make,
  });
}
