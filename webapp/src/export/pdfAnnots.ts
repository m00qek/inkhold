// The links an exported `.note` page carries — the arithmetic and the refusals,
// with nothing that writes bytes.
//
// WHY THIS EXISTS AT ALL, and why it is the opposite mechanism to the one the
// PDF viewer already ships: a `.pdf` keeps its own links through an export
// because that path is an INCREMENTAL UPDATE that re-encodes nothing, so the
// annotations were never touched. A `.note` has no original to preserve —
// `export/pdf.ts` builds a new document from pixels — so its links have to be
// CREATED here or they do not exist. A digital planner is mostly links (the
// teacher-planner capture carries 51,256 of them, `note-format.md` §14), and an
// export that drops them is a picture of a planner.
//
// PURE, and a sibling of `render/pdfLinks.ts` rather than part of it. That file
// places a link on a CANVAS for the reader; this one places the same link in PDF
// USER SPACE for a file someone else will open. Two different target spaces —
// one y-down in CSS pixels, one y-up in points — and the y-flip is exactly the
// difference, so keeping them apart is what lets each be tested at the numbers.
//
// The scheme allowlist is `render/pdfLinks.ts`' own (`linkTarget`), deliberately
// NOT a second copy: a URI this app would refuse to follow on screen must not be
// the one it writes into a file that leaves the machine.

import type { Size } from "../render/markGeometry";
import { linkTarget, type PdfLink } from "../render/pdfLinks";

/** A link's box in PDF user space: bottom-left origin, y UP, points. */
export interface AnnotRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * Where `link` lands on the exported page, or **null when it lands nowhere**.
 *
 * THE Y-FLIP IS THE WHOLE TRANSFORM. `EXTERNALLINKINFO` rects are device panel
 * pixels with the origin at the TOP-LEFT and y running DOWN; a PDF annotation
 * rect is user space, origin BOTTOM-LEFT, y running UP. So the box's top edge
 * becomes its larger y and its bottom edge the smaller one:
 *
 *     s  = page.width / panel.width
 *     y0 = page.height - (y + h) * s      // the box's BOTTOM
 *     y1 = page.height - y * s            // the box's TOP
 *
 * ONE SCALE, TAKEN FROM WIDTH, for the reason `placeLink` gives about its own:
 * the exported page is sized to A4 width with the note's aspect preserved, so
 * the height ratio is the same number, and deriving it from one axis means a
 * page height rounded to two decimals cannot skew every link on the page. The
 * flip's origin is `page.height` — the MediaBox's own number, not a recomputed
 * one — so a link at the very top of the panel touches the top of the page.
 *
 * A rect that HANGS OFF the page is clipped rather than dropped: a device-authored
 * box that overshoots the panel by a pixel is a real link, and refusing it would
 * cost the user a working tab to save an invisible pixel. A rect with nothing
 * left after the clip — or one that is degenerate, or not finite — is refused,
 * because there is no annotation to make out of it.
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
 * A JS string as a PDF string object.
 *
 * ASCII goes out as a literal with the three metacharacters escaped — `\`, `(`
 * and `)` — which is what a URI containing a bracket needs to not end the string
 * halfway through and leave the rest of the page dictionary as garbage.
 *
 * ANYTHING ELSE GOES OUT AS UTF-16BE WITH A BOM, hex-encoded. A literal string's
 * bytes are PDFDocEncoding, which agrees with Latin-1 over most of its range and
 * NOT over 0x80–0xA0 — so writing an accented URI raw produces a file one reader
 * opens correctly and another silently mis-decodes. The `FEFF` prefix is the only
 * thing that tells a reader which of the two it is holding.
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

  // charCodeAt yields UTF-16 code UNITS, which is already the encoding asked
  // for — a surrogate pair emits its two units in order and needs no special
  // case.
  let hex = "FEFF";
  for (let i = 0; i < s.length; i++) {
    hex += s.charCodeAt(i).toString(16).toUpperCase().padStart(4, "0");
  }
  return `<${hex}>`;
}

export interface AnnotContext {
  /** The page's raster in device pixels — the space the link rects are in. */
  panel: Size;
  /** The exported page's MediaBox, in points. */
  page: Size;
  /**
   * The object number of the 0-based note page `index` **in the document being
   * written**, or null when that page is not in it.
   *
   * A FORWARD REFERENCE IS THE POINT. Object numbering in `export/pdf.ts` is
   * arithmetic (`4 + 3i`), so a link on page 2 can name the object of page 1701
   * long before page 1701 has been written — the xref that resolves it is written
   * last, when the offsets are known. That is what lets a whole-notebook export
   * keep its internal links while still streaming one page at a time.
   *
   * Null is not a failure: a SINGLE-PAGE export contains one page, so every
   * internal link in it points at a page that is not there, and the honest
   * answer is no annotation rather than one that lands somewhere arbitrary.
   */
  pageObjOf: (index: number) => number | null;
}

/**
 * The `/Annots` entry for a page, ready to concatenate into its dictionary —
 * **including its leading space**, and `""` when there is nothing to say.
 *
 * The empty string is load-bearing: a page with no links must produce the byte
 * sequence it produced before this feature existed, so nothing regresses for the
 * notebooks (which is nearly all of them) that have none.
 *
 * DIRECT DICTIONARIES, NOT OBJECTS. Annotation objects would make the object
 * count per page depend on how many links that page has, and the whole streaming
 * design rests on that count being fixed at three — a page's own object number
 * has to be computable from its index alone, by a writer that does not yet know
 * how many pages there will be. Inline annotations are what keep the arithmetic
 * true, and they cost the writer nothing it has to remember.
 *
 * `/Border [0 0 0]` on every one, the same decision the reader's link layer
 * made: the page's own design already shows where its links are, and a reader
 * drawing boxes over a planner would put a rectangle round every day of the year.
 */
export function annotsEntry(
  links: readonly PdfLink[] | null | undefined,
  ctx: AnnotContext,
): string {
  if (!links || links.length === 0) return "";

  const parts: string[] = [];
  for (const link of links) {
    // The SAME allowlist the viewer applies, and it matters more here: this file
    // leaves the machine and is opened in a reader with its own idea of what a
    // URI may do. A refused link becomes NO ANNOTATION — never a defused one,
    // which would be a rectangle that looks clickable and is not.
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

/**
 * An internal link's destination, or null when its page is not in this document.
 *
 * `/XYZ null null null` means "this page, keep the reader's current zoom and
 * scroll where it can" — the least presumptuous destination there is. A `/Fit`
 * would rescale someone's view every time they followed a month tab.
 */
function dest(obj: number | null): string | null {
  return obj === null ? null : `/Dest [ ${obj} 0 R /XYZ null null null ]`;
}

/** Points, at a resolution no reader can tell from more. */
function num(v: number): string {
  return String(+v.toFixed(2));
}
