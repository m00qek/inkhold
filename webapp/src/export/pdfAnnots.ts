// Link annotations for an exported `.note` page (arithmetic only, no bytes).
// The PDF is rebuilt from pixels, so links must be created here or they're lost.
// URIs pass the same `linkTarget` allowlist as the on-screen reader.

import type { Size } from "../render/markGeometry";
import { linkTarget } from "../render/pdfWire";
import type { PdfLink } from "../core/types";

export interface AnnotRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * Where `link` lands on the exported page, or null. Device rects are top-left,
 * y-down panel pixels; PDF rects are bottom-left, y-up points, so
 * y0 = page.height - (y + h) * s, with one scale s taken from width (the page
 * keeps the note's aspect). Overhanging rects are clipped; empty, degenerate or
 * non-finite ones are refused.
 */
export function annotRect(link: PdfLink, panel: Size, page: Size): AnnotRect | null {
  if (!(panel.width > 0) || !(panel.height > 0)) return null;
  if (!(page.width > 0) || !(page.height > 0)) return null;
  if (![link.x, link.y, link.w, link.h].every((v) => Number.isFinite(v))) return null;

  const left = Math.max(0, link.x);
  const top = Math.max(0, link.y);
  const right = Math.min(panel.width, link.x + link.w);
  const bottom = Math.min(panel.height, link.y + link.h);
  if (!(right > left) || !(bottom > top)) return null;

  const s = page.width / panel.width;
  return {
    x0: left * s,
    y0: page.height - bottom * s,
    x1: right * s,
    y1: page.height - top * s,
  };
}

/**
 * A JS string as a PDF string object: ASCII as an escaped literal, anything
 * else as hex UTF-16BE with a BOM, since PDFDocEncoding differs from Latin-1
 * over 0x80–0xA0.
 */
export function pdfTextString(s: string): string {
  let ascii = true;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c > 0x7e) {
      ascii = false;
      break;
    }
  }
  if (ascii) return `(${s.replace(/[\\()]/g, (c) => `\\${c}`)})`;

  let hex = "FEFF";
  for (let i = 0; i < s.length; i++) {
    hex += s.charCodeAt(i).toString(16).toUpperCase().padStart(4, "0");
  }
  return `<${hex}>`;
}

export interface AnnotContext {
  /** The page raster in device pixels (the link rects' space). */
  panel: Size;
  /** The MediaBox, in points. */
  page: Size;
  /**
   * Object number of note page `index` in this document, or null when absent
   * (e.g. a single-page export). Numbering is arithmetic, so forward references
   * work while pages stream.
   */
  pageObjOf: (index: number) => number | null;
}

/**
 * The page's `/Annots` entry with its leading space, or `""` (so link-less
 * pages are byte-identical). Inline dictionaries, not objects, keep the
 * per-page object count fixed at three. `/Border [0 0 0]` like the reader.
 */
export function annotsEntry(
  links: readonly PdfLink[] | null | undefined,
  ctx: AnnotContext,
): string {
  if (!links || links.length === 0) return "";

  const parts: string[] = [];
  for (const link of links) {
    // A refused link becomes no annotation, never a dead clickable-looking box.
    const target = linkTarget(link);
    if (target === null) continue;

    const action =
      target.kind === "external"
        ? `/A << /S /URI /URI ${pdfTextString(target.href)} >>`
        : dest(ctx.pageObjOf(target.page));
    if (action === null) continue;

    const rect = annotRect(link, ctx.panel, ctx.page);
    if (rect === null) continue;

    parts.push(
      `<< /Type /Annot /Subtype /Link /Rect [ ${num(rect.x0)} ${num(rect.y0)}` +
        ` ${num(rect.x1)} ${num(rect.y1)} ] /Border [0 0 0] ${action} >>`,
    );
  }

  return parts.length === 0 ? "" : ` /Annots [ ${parts.join(" ")} ]`;
}

/** `/XYZ null null null`: go to the page, keep the reader's zoom. Null if absent. */
function dest(obj: number | null): string | null {
  return obj === null ? null : `/Dest [ ${obj} 0 R /XYZ null null null ]`;
}

function num(v: number): string {
  return String(+v.toFixed(2));
}
