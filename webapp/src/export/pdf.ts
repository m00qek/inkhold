// A minimal, dependency-free PDF writer for grayscale note pages, with an
// optional INVISIBLE TEXT LAYER over the raster so the result is selectable and
// searchable.
//
// Ported from the earlier `src/frontend/web/pdf.js` proof-of-concept. The raster
// half is unchanged in substance — each page is one /DeviceGray image XObject,
// Flate-compressed via the browser's `CompressionStream`, sized to A4 width with
// the note's aspect preserved. The text layer is new, and is the reason this is
// worth doing at all: without it a "PDF export" is a picture of writing.
//
// ZERO DEPENDENCIES, and this file is PURE — it takes pixels in and returns
// bytes out, touching no DOM. That is what makes it unit-testable in Node; the
// canvas → grayscale step lives in `exporter.ts`, which is browser-only.
//
// IT IS ALSO STREAMING, and that is a hard requirement rather than a nicety.
// Peak JS heap must be ~ONE PAGE whatever the notebook's length: a 1404x1872
// page is 2.63 MB raw, so anything that keeps the pages — or the finished file —
// whole would put a 40-page export past the point where a phone kills the tab.
// Two rules follow, and both are load-bearing:
//
//   1. Pages arrive as an (async) ITERABLE and are pulled ONE AT A TIME. Each is
//      deflated and written out before the next is requested, so the caller can
//      decode lazily and drop each raw buffer as it goes. The old signature took
//      an array and `Promise.all`-ed the whole thing, which ran every
//      CompressionStream concurrently and piled the compressed copies up
//      alongside the raw ones.
//   2. Nothing is ever CONCATENATED. `pdfChunks` yields the file as a sequence of
//      byte runs and `buildPdf` hands that sequence straight to `new Blob(...)`,
//      which browsers back with disk rather than JS heap. Building a contiguous
//      `Uint8Array` at the end would materialise the whole file twice.
//
// The format cooperates: objects may be written in ANY order as long as the
// cross-reference table records where each one landed, so the page tree (which
// cannot be written until the page count is known) simply goes at the end.

import type { WordBox } from "../core/types";
import { isUsableScale, withinPage, wordBoxPx } from "../core/wordBox";
import type { PdfLink } from "../core/types";
import { annotsEntry } from "./pdfAnnots";

/** A4 width in PostScript points (210 mm). Pages are sized to this. */
const A4_WIDTH_PT = 595.28;

/**
 * Text rendering mode 3 = "neither fill nor stroke" — i.e. INVISIBLE. The glyphs
 * are still there for selection, copy, and search; they are simply not painted,
 * so the page looks exactly like the raster underneath it.
 */
const TR_INVISIBLE = 3;

/**
 * Rough average glyph advance for Helvetica, in em. Used only as the DENOMINATOR
 * of a per-word horizontal-scale correction: whatever this estimate gets wrong,
 * `Tz` then stretches the word so its rendered width matches its real box. So
 * word placement and word extent are exact; only the positions of characters
 * *within* a word are approximate, which no consumer of an invisible layer can
 * observe. Getting this exact would mean embedding the Helvetica AFM widths —
 * 224 numbers to improve something nobody can see.
 */
const HELVETICA_AVG_EM = 0.5;

/** Clamp on that correction, so one absurd box cannot emit a degenerate `Tz`. */
const TZ_MIN = 10;
const TZ_MAX = 1000;


/** One page's raster: row-major 8-bit grayscale, `width * height` bytes. */
export interface PdfPage {
  width: number;
  height: number;
  gray: Uint8Array;
  /**
   * The invisible text layer to place over this page, or null/absent for a
   * raster-only page. **Pass null whenever `pxPerMm` is unknown** — see
   * `NoteMeta.pxPerMm`. A missing text layer is a visible, honest limitation; a
   * mis-scaled one is not.
   */
  textLayer?: TextLayer | null;
  /**
   * The page's links, in **this page's own device pixels** (`width`/`height`
   * above) — the space `EXTERNALLINKINFO` records them in, since a `.note` page
   * IS the device panel. Absent or empty for a page with none, which is the
   * common case and must cost the file nothing.
   *
   * An INTERNAL link (`page >= 0`) names a **0-based page of the note**, and is
   * only ever written when {@link PdfOptions.pageCount} says that page is in the
   * document being built — see there.
   */
  links?: readonly PdfLink[] | null;
}

export interface TextLayer {
  /** Device pixels per millimetre. Must be a VERIFIED scale, never a guess. */
  pxPerMm: number;
  words: WordBox[];
}

/** A word resolved to page pixels, top-left origin. */
interface PlacedPx {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Scale `layer`'s millimetres to page pixels, or return **null to drop the whole
 * text layer**.
 *
 * THE BOUNDS CHECK IS THE POINT. Every scaled box must land inside the page. On
 * real data today the furthest edge is ~1397 px against a 1404 px page, so this
 * passes with room to spare — and it fires loudly the moment a note comes from
 * hardware whose millimetre scale we got wrong, which is the failure this whole
 * design is arranged around. It is all-or-nothing rather than per-word: if the
 * scale is wrong then every box is wrong, and silently keeping the ones that
 * happen to still fit would leave a partial layer that looks deliberate.
 *
 * Words that cannot be placed but say nothing about the scale — a zero-area box,
 * an empty string — are skipped individually instead.
 */
export function placeWords(layer: TextLayer, widthPx: number, heightPx: number): PlacedPx[] | null {
  const { pxPerMm } = layer;
  if (!isUsableScale(pxPerMm)) return null;

  const out: PlacedPx[] = [];
  for (const word of layer.words) {
    // The millimetre arithmetic and the bounds rule are SHARED with the reader's
    // find-in-note ovals (see core/wordBox.ts) so a word circled on screen and
    // the same word selectable in the export cannot disagree about where it is.
    const box = wordBoxPx(word, pxPerMm);
    if (box === null) return null;

    // Out of bounds ⇒ the scale is wrong ⇒ no text layer at all.
    if (!withinPage(box, widthPx, heightPx)) return null;

    if (box.w <= 0 || box.h <= 0) continue; // nothing to place, and not evidence of anything
    const text = toWinAnsi(word.text);
    if (text === "") continue;
    out.push({ text, x: box.x, y: box.y, w: box.w, h: box.h });
  }
  return out;
}

/**
 * Re-encode a JS string into WinAnsiEncoding, which is what the text layer
 * declares and what lets Helvetica be used with **no font embedding at all** (it
 * is one of the standard 14). WinAnsi agrees with Latin-1 over 0xA0–0xFF, which
 * covers the Portuguese accents this household actually writes — á é í ó ú, ã õ,
 * â ê ô, ç — so those survive a copy-paste intact.
 *
 * Anything outside the encoding becomes `?`: it keeps the word's shape and
 * position rather than silently shortening it. Control characters are dropped —
 * the server already skips the layout separators, so reaching one here means it
 * was inside a word.
 */
export function toWinAnsi(s: string): string {
  let out = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp === 0x20ac) {
      out += "\x80"; // € is the one common character WinAnsi puts outside Latin-1
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

/** Escape a PDF literal string's three special bytes. */
function pdfString(s: string): string {
  return s.replace(/[\\()]/g, (c) => `\\${c}`);
}

/**
 * One byte per char. Every string we build for a content stream is already
 * WinAnsi (all code points < 256), so this is both the correct encoding AND the
 * reason `content.length` can be used as `/Length` — a UTF-8 encode would make
 * the declared length disagree with the bytes for any accented word.
 */
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

/**
 * Where the pages come from. An ARRAY still satisfies this — the single-page
 * caller passes one — but the writer only ever asks for the next page, so a
 * caller with a whole notebook can hand over a generator that decodes on demand
 * and never holds more than the page in flight.
 */
export type PdfPageSource = Iterable<PdfPage> | AsyncIterable<PdfPage>;

/**
 * What the writer cannot learn from the pages themselves.
 *
 * There is exactly one such thing, and it exists only because of internal links:
 * a link to note page `k` becomes a reference to that page's object, and writing
 * a reference to an object that never gets written leaves a file whose xref is a
 * lie. A streaming writer does not know how many pages are coming, so the CALLER
 * — which is iterating `meta.pages` and knows — states it.
 */
export interface PdfOptions {
  /**
   * How many pages this document will contain, when the source is the WHOLE note
   * in note order (so document page `i` is note page `i`). Internal links are
   * kept exactly for targets inside it.
   *
   * **OMIT IT FOR ANY EXPORT THAT IS NOT THE WHOLE NOTE**, and the single-page
   * exports do: their one page is note page 7 sitting at document index 0, so
   * every internal link in it points at a page that is not in the file. Absent
   * means "no internal link can be resolved", which drops them all and keeps the
   * external ones — the honest outcome for a page lifted out of its notebook.
   */
  pageCount?: number;
}

/**
 * The page's content stream: the raster, then the invisible words.
 *
 * PDF's origin is BOTTOM-LEFT and the boxes are top-left, so every Y is flipped.
 * The text is positioned by its baseline, which sits a little above the box's
 * bottom edge so descenders stay inside it.
 */
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

    // Y flip: the box's TOP is `word.y` from the top, so its BOTTOM edge is
    // `pageH - (y + h) * ptPerPx` from the bottom. Nudge the baseline up off
    // that edge by a fraction of the size to leave room for descenders.
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
 * OBJECT NUMBERING, and why the font sits at a fixed low number.
 *
 * 1 = catalog, 2 = page tree, 3 = the shared font, then page `i` (0-based) takes
 * three consecutive numbers: `4+3i` = page, `5+3i` = content, `6+3i` = image.
 *
 * The font used to be numbered LAST, after every page — which is fine when the
 * page count is known up front and impossible when it is not: each page's
 * `/Resources` names the font object, so streaming a page out would have meant
 * predicting a number that depends on how many pages are still to come. Pinning
 * the font at 3 makes every page object self-contained, and the two objects that
 * genuinely need the total (the page tree's `/Kids` and `/Count`) are written
 * after the loop, where the total is known.
 */
const FONT_OBJ = 3;
const pageObj = (i: number): number => 4 + 3 * i;

/**
 * The whole file, as a sequence of byte runs, in write order.
 *
 * ONE PAGE IS PULLED, DEFLATED AND EMITTED BEFORE THE NEXT IS REQUESTED. That
 * ordering is the memory guarantee, and it is what `tests/unit/pdf.test.ts`
 * asserts on directly (a browser offers no peak-heap measurement worth
 * asserting against, but this interleaving is deterministic).
 *
 * Nothing here retains a page: `p` goes out of scope with each iteration, so the
 * caller's buffer is collectable the moment its compressed form exists.
 */
export async function* pdfChunks(
  pages: PdfPageSource,
  opts: PdfOptions = {},
): AsyncGenerator<Uint8Array> {
  const enc = new TextEncoder();
  const offsets: number[] = [];
  let pos = 0;

  // Every yield goes through here, so `pos` cannot drift out of step with what
  // was emitted — and `pos` is what the cross-reference table is built from.
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

  // THE FORWARD REFERENCE, and the only reason it is legal: an internal link
  // resolves a note page to an object number by arithmetic alone, so page 2 can
  // point at page 1701 before page 1701 has been written — the xref that says
  // where that object landed is written last. A target outside the document
  // resolves to null and the link is dropped rather than dangling.
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

    // A null result here means "the boxes did not survive the bounds check" —
    // the page silently becomes raster-only, which is exactly the intended
    // degradation, and it is decided PER PAGE: within one document, a recognised
    // page gets its layer and an unrecognised neighbour simply does not.
    const placed = p.textLayer ? (placeWords(p.textLayer, p.width, p.height) ?? []) : [];
    const content = latin1Bytes(contentStream(placed, p.width, pw, ph));

    // Deflate before anything is written for this page, so the raw buffer is
    // dead by the time the next one is asked for.
    const image = await deflate(p.gray);

    // INLINE, and empty for a page with no links — see `annotsEntry`. This is
    // what keeps a page at exactly three objects whatever its links, which is
    // what `pageObj` depends on and therefore what the forward reference above
    // depends on.
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

  // A source that yielded FEWER pages than the caller promised would leave every
  // internal link aimed past the end of the file — an object number the xref has
  // no row for, which is a document a strict reader refuses to open. Failing here
  // costs the export; not failing here costs the file, silently.
  if (opts.pageCount !== undefined && n < opts.pageCount) {
    throw new Error(`buildPdf: promised ${opts.pageCount} pages, got ${n}`);
  }

  // The page tree, now that the count is known. `/Kids` is the one thing that
  // grows with the notebook, and it is ~10 bytes per page.
  let kids = "";
  for (let i = 0; i < n; i++) kids += `${i > 0 ? " " : ""}${pageObj(i)} 0 R`;
  yield* obj(2, `<< /Type /Pages /Kids [ ${kids} ] /Count ${n} >>`);

  // Helvetica is one of the standard 14 fonts, so it needs no embedding and the
  // file stays a raster plus a few hundred bytes.
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

/**
 * Build a PDF from a source of grayscale pages.
 *
 * Returns a **Blob**, not bytes, and that is deliberate: `new Blob(parts)` takes
 * the chunk array as it stands, and browsers back a large Blob with disk rather
 * than JS heap. Joining the chunks into one `Uint8Array` first would put the
 * entire finished file — the raster of every page — into the heap, alongside the
 * chunks it was copied from.
 */
export async function buildPdf(pages: PdfPageSource, opts?: PdfOptions): Promise<Blob> {
  const parts: BlobPart[] = [];
  for await (const chunk of pdfChunks(pages, opts)) parts.push(chunk as BlobPart);
  return new Blob(parts, { type: "application/pdf" });
}
