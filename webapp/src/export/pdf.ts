// A minimal, dependency-free, DOM-free streaming PDF writer for grayscale note
// pages (one Flate /DeviceGray image each, A4 width), with an optional
// invisible text layer. Peak heap must stay about one page: pages are pulled one
// at a time and the file is yielded as chunks for a disk-backed Blob, never
// concatenated.

import type { WordBox } from "../core/types";
import { isUsableScale, withinPage, wordBoxPx } from "../core/wordBox";
import type { PdfLink } from "../core/types";
import { annotsEntry } from "./pdfAnnots";

/** A4 width in points (210 mm). */
const A4_WIDTH_PT = 595.28;

/** Text rendering mode 3: invisible, but selectable and searchable. */
const TR_INVISIBLE = 3;

/**
 * Rough Helvetica glyph advance in em, used only as the denominator of the
 * per-word `Tz` correction, so word extents are exact without AFM widths.
 */
const HELVETICA_AVG_EM = 0.5;

/** Clamp on the `Tz` correction. */
const TZ_MIN = 10;
const TZ_MAX = 1000;


/** Row-major 8-bit grayscale, `width * height` bytes. */
export interface PdfPage {
  width: number;
  height: number;
  gray: Uint8Array;
  /** Invisible text layer, or null. Pass null when `pxPerMm` is unverified. */
  textLayer?: TextLayer | null;
  /**
   * Links in this page's device pixels (`EXTERNALLINKINFO` space). Internal
   * ones are written only when {@link PdfOptions.pageCount} covers the target.
   */
  links?: readonly PdfLink[] | null;
}

export interface TextLayer {
  /** Device pixels per millimetre. Must be a verified scale, never a guess. */
  pxPerMm: number;
  words: WordBox[];
}

interface PlacedPx {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Scale `layer` to page pixels, or null to drop the whole layer when any box
 * falls outside the page (a wrong mm scale makes every box wrong). Empty or
 * zero-area words are skipped individually.
 */
export function placeWords(layer: TextLayer, widthPx: number, heightPx: number): PlacedPx[] | null {
  const { pxPerMm } = layer;
  if (!isUsableScale(pxPerMm)) return null;

  const out: PlacedPx[] = [];
  for (const word of layer.words) {
    // Shared with find-in-note's ovals (core/wordBox.ts), so they always agree.
    const box = wordBoxPx(word, pxPerMm);
    if (box === null) return null;

    if (!withinPage(box, widthPx, heightPx)) return null;

    if (box.w <= 0 || box.h <= 0) continue;
    const text = toWinAnsi(word.text);
    if (text === "") continue;
    out.push({ text, x: box.x, y: box.y, w: box.w, h: box.h });
  }
  return out;
}

/**
 * Re-encode to WinAnsiEncoding so standard-14 Helvetica needs no embedding.
 * Outside characters become `?` (keeping word shape); control chars are dropped.
 */
export function toWinAnsi(s: string): string {
  let out = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp === 0x20ac) {
      out += "\x80"; // € is WinAnsi's one common character outside Latin-1
    } else if (cp < 0x20 || cp === 0x7f) {
      continue;
    } else if (cp <= 0xff) {
      out += String.fromCharCode(cp);
    } else {
      out += "?";
    }
  }
  return out;
}

function pdfString(s: string): string {
  return s.replace(/[\\()]/g, (c) => `\\${c}`);
}

/** One byte per char; content strings are WinAnsi, so `length` is a valid `/Length`. */
function latin1Bytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream("deflate"); // zlib (RFC 1950) == PDF /FlateDecode
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(cs);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** An array, or a generator that decodes pages on demand. */
export type PdfPageSource = Iterable<PdfPage> | AsyncIterable<PdfPage>;

export interface PdfOptions {
  /**
   * Page count when the source is the whole note in order; internal links are
   * kept for targets inside it. Omit for partial exports, which drops all
   * internal links.
   */
  pageCount?: number;
}

/** The page content stream: the raster, then the invisible words (Y flipped). */
function contentStream(placed: PlacedPx[], widthPx: number, pageW: number, pageH: number): string {
  let s = `q ${pageW} 0 0 ${pageH} 0 0 cm /Im0 Do Q`;
  if (placed.length === 0) return s;

  const ptPerPx = pageW / widthPx;
  const n = (v: number): string => v.toFixed(3);

  for (const word of placed) {
    const size = word.h * ptPerPx;
    const targetW = word.w * ptPerPx;
    const estimatedW = HELVETICA_AVG_EM * size * word.text.length;
    const tz = estimatedW > 0 ? clamp((100 * targetW) / estimatedW, TZ_MIN, TZ_MAX) : 100;

    // Baseline nudged up off the box bottom to leave room for descenders.
    const baseline = pageH - (word.y + word.h) * ptPerPx + size * 0.15;

    s +=
      ` BT ${TR_INVISIBLE} Tr /F1 ${n(size)} Tf ${n(tz)} Tz` +
      ` 1 0 0 1 ${n(word.x * ptPerPx)} ${n(baseline)} Tm (${pdfString(word.text)}) Tj ET`;
  }
  return s;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * Object numbering: 1 catalog, 2 page tree, 3 font, then page `i` takes
 * `4+3i` page, `5+3i` content, `6+3i` image. Fixed numbering lets pages stream
 * and links forward-reference pages not yet written; the page tree goes last.
 */
const FONT_OBJ = 3;
const pageObj = (i: number): number => 4 + 3 * i;

/**
 * The file as byte runs in write order. Each page is pulled, deflated and
 * emitted before the next is requested; `tests/unit/pdf.test.ts` asserts it.
 */
export async function* pdfChunks(
  pages: PdfPageSource,
  opts: PdfOptions = {},
): AsyncGenerator<Uint8Array> {
  const enc = new TextEncoder();
  const offsets: number[] = [];
  let pos = 0;

  // All output goes through here so `pos` (the xref source) cannot drift.
  const emit = function* (chunk: string | Uint8Array): Generator<Uint8Array> {
    const b = typeof chunk === "string" ? enc.encode(chunk) : chunk;
    pos += b.length;
    yield b;
  };
  const obj = function* (num: number, body: string): Generator<Uint8Array> {
    offsets[num] = pos;
    yield* emit(`${num} 0 obj\n${body}\nendobj\n`);
  };
  const streamObj = function* (num: number, dict: string, data: Uint8Array): Generator<Uint8Array> {
    offsets[num] = pos;
    yield* emit(`${num} 0 obj\n${dict}\nstream\n`);
    yield* emit(data);
    yield* emit("\nendstream\nendobj\n");
  };

  const pageObjOf = (index: number): number | null => {
    const total = opts.pageCount;
    if (total === undefined || !Number.isInteger(index)) return null;
    return index >= 0 && index < total ? pageObj(index) : null;
  };

  yield* emit("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");
  yield* obj(1, "<< /Type /Catalog /Pages 2 0 R >>");

  let n = 0;
  for await (const p of pages) {
    const i = n++;
    const pw = A4_WIDTH_PT;
    const ph = +(A4_WIDTH_PT * (p.height / p.width)).toFixed(2);

    // Null means the bounds check failed: this page alone goes raster-only.
    const placed = p.textLayer ? (placeWords(p.textLayer, p.width, p.height) ?? []) : [];
    const content = latin1Bytes(contentStream(placed, p.width, pw, ph));

    const image = await deflate(p.gray);

    const annots = annotsEntry(p.links, {
      panel: { width: p.width, height: p.height },
      page: { width: pw, height: ph },
      pageObjOf,
    });

    yield* obj(
      pageObj(i),
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}]` +
        ` /Resources << /XObject << /Im0 ${pageObj(i) + 2} 0 R >>` +
        ` /Font << /F1 ${FONT_OBJ} 0 R >> >>` +
        ` /Contents ${pageObj(i) + 1} 0 R${annots} >>`,
    );
    yield* streamObj(pageObj(i) + 1, `<< /Length ${content.length} >>`, content);
    yield* streamObj(
      pageObj(i) + 2,
      `<< /Type /XObject /Subtype /Image /Width ${p.width} /Height ${p.height}` +
        ` /ColorSpace /DeviceGray /BitsPerComponent 8` +
        ` /Filter /FlateDecode /Length ${image.length} >>`,
      image,
    );
  }

  if (n === 0) throw new Error("buildPdf: no pages");

  // Fewer pages than promised would leave internal links past the xref; fail.
  if (opts.pageCount !== undefined && n < opts.pageCount) {
    throw new Error(`buildPdf: promised ${opts.pageCount} pages, got ${n}`);
  }

  let kids = "";
  for (let i = 0; i < n; i++) kids += `${i > 0 ? " " : ""}${pageObj(i)} 0 R`;
  yield* obj(2, `<< /Type /Pages /Kids [ ${kids} ] /Count ${n} >>`);

  yield* obj(
    FONT_OBJ,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
  );

  const xrefOffset = pos;
  const count = pageObj(n); // highest object number + 1
  yield* emit(`xref\n0 ${count}\n`);
  yield* emit("0000000000 65535 f \n");
  for (let num = 1; num < count; num++) {
    yield* emit(`${String(offsets[num] ?? 0).padStart(10, "0")} 00000 n \n`);
  }
  yield* emit(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);
}

/** Build a PDF as a Blob, which browsers back with disk rather than JS heap. */

export async function buildPdf(pages: PdfPageSource, opts?: PdfOptions): Promise<Blob> {
  const parts: BlobPart[] = [];
  for await (const chunk of pdfChunks(pages, opts)) parts.push(chunk as BlobPart);
  return new Blob(parts, { type: "application/pdf" });
}
