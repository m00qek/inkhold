// Helpers shared by the pdf tests.

import { it } from "vitest";
import { buildPdf, pdfChunks, type PdfOptions, type PdfPage } from "../../src/export/pdf";
import type { WordBox } from "../../src/core/types";

/** The verified scale for the 1404x1872 class: 1404 px over a 118.64 mm canvas. */
export const PX_PER_MM = 1404 / 118.64;

export const W = 1404;

export const H = 1872;

/** A blank page's worth of grayscale. Content is irrelevant to structure. */
export function blank(w = W, h = H): Uint8Array {
  return new Uint8Array(w * h).fill(0xff);
}

/** Words at the verified scale; the last is the lowest word of `sample-2.note` (1757 of 1872 px). */
export const WORDS: WordBox[] = [
  { text: "alpha", xMm: 10, yMm: 12, wMm: 25, hMm: 7 },
  { text: "beta", xMm: 40, yMm: 100, wMm: 18, hMm: 6 },
  { text: "Test", xMm: 89.922, yMm: 136.904, wMm: 21.3505, hMm: 11.5485 },
];

/** Latin-1 view of the file, for structural greps. */
export function text(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
}

/** The finished file as bytes; `buildPdf` returns a Blob so large ones stay off the heap. */
export async function bytesOf(pages: PdfPage[]): Promise<Uint8Array> {
  return new Uint8Array(await (await buildPdf(pages)).arrayBuffer());
}

/** A small page: these tests are about ORDER and OFFSETS, not about pixels. */
export const SW = 64;

export const SH = 32;

/** The image XObject dict for page `i` opens with this object number. */
export const imageObjOf = (num: number): number => (num - 6) / 3;

/** A page source that logs every call and scribbles 0xEE over each page's buffer
 *  once the next is requested, so a writer that banked pages shows it in the bytes. */
export async function* recordingPages(n: number, log: string[]): AsyncGenerator<PdfPage> {
  let prev: Uint8Array | null = null;
  const release = (i: number): void => {
    prev!.fill(0xee);
    prev = null;
    log.push(`release ${i}`);
  };

  for (let i = 0; i < n; i++) {
    if (prev) release(i - 1);
    log.push(`request ${i}`);
    const gray = new Uint8Array(SW * SH).fill(i + 1);
    prev = gray;
    yield { width: SW, height: SH, gray };
  }
  if (prev) release(n - 1);
}

export interface Collected {
  chunks: Uint8Array[];
  /** The deflated image stream of each page, in order. */
  images: Uint8Array[];
  bytes: Uint8Array;
}

/** Drain `pdfChunks`, noting when each page's image stream is written out. */
export async function collect(
  pages: AsyncIterable<PdfPage>,
  log?: string[],
  opts?: PdfOptions,
): Promise<Collected> {
  const chunks: Uint8Array[] = [];
  const images: Uint8Array[] = [];
  let expectImage = false;

  for await (const chunk of pdfChunks(pages, opts)) {
    if (expectImage) {
      images.push(chunk);
      expectImage = false;
    }
    const head = text(chunk.subarray(0, 160));
    const m = /^(\d+) 0 obj/.exec(head);
    if (m && head.includes("/Subtype /Image")) {
      log?.push(`write ${imageObjOf(Number(m[1]))}`);
      expectImage = true;
    }
    chunks.push(chunk);
  }

  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const bytes = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    bytes.set(c, o);
    o += c.length;
  }
  return { chunks, images, bytes };
}
