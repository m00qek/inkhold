// EVERYTHING THAT CROSSES THE WASM BOUNDARY AS A RECORD: a page's words, a
// page's links, a document's outline — the three payloads `pdf_shim.c` builds
// as JSON, the one parse that admits them, and the small amount of judgement
// that goes with each.
//
// No DOM, no wasm: the refusals and the arithmetic alone, so both can be tested
// at the numbers rather than by looking at a screenshot. `pdfWorkerTypes.ts`
// carries these across `postMessage`; `pages/` turns them into marks, anchors
// and rows.
//
// The rects all arrive in the page's own DISPLAY space and share one page→screen
// mapping (`placePageRect`, in `markGeometry.ts`), because one page with two
// mappings is how two overlays on it come to disagree on a rotated document.

import type { PdfLink } from "../core/types";
import { placePageRect, type Size } from "./markGeometry";

/**
 * The decoder's JSON as records, dropping anything `one` refuses.
 *
 * WHAT IS CHECKED, AND WHAT IS NOT. This JSON was written by `pdf_shim.c`
 * microseconds earlier, so its SHAPE cannot be wrong without the shim being
 * wrong — and then the ABI test fails long before a user does; checks that a
 * coordinate is finite or a depth an integer would guard nothing. What each
 * `one` checks is CONTENT, which comes out of a document that arrived by device
 * sync and carries no guarantee at all: a title's type, a `uri` that is empty
 * (nowhere to go), a box with no width (a mark that could only be drawn by
 * mistake).
 *
 * A REFUSAL IS NEVER AN EXCEPTION, at any level here. A malformed payload costs
 * the page its highlights, its links or its outline and nothing else. The page
 * still MATCHED; the server said so, and nothing on this side can take that back.
 */
export function parseRecords<T>(
  json: string,
  one: (r: Record<string, unknown>) => T | null,
): T[] {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const out: T[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const kept = one(item as Record<string, unknown>);
    if (kept !== null) out.push(kept);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Words — find's locator, and the copy path's source
// ---------------------------------------------------------------------------

/**
 * One word on a page, exactly as `ink_page_words` describes it.
 *
 * `x,y,w,h` are in the page's DISPLAY space — top-left origin, y down, POINTS.
 * The decoder subtracts the page box's own origin and works from
 * `fz_bound_page`'s transformed box, so a `/Rotate`, an off-origin `/MediaBox`
 * and a `/CropBox` are all already resolved.
 *
 * `t` is a WHITESPACE-AND-PUNCTUATION run, not necessarily one index term:
 * `page-range` may arrive whole. That is a statement about the BOX's precision
 * and never about membership — the caller re-tokenises with the index's own
 * rule (`search/fold.ts`) before comparing.
 *
 * IT IS THE BOUNDING RECT OF THE RUN'S QUADS, not the quads, so text set at an
 * angle inside an upright page gets a box that CONTAINS its glyphs rather than
 * hugging them — over-covering, never a mark on the wrong words.
 */
export interface PdfWord {
  t: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /**
   * Which text LINE of the page this run came from, zero-based, in the shim's
   * own walk order — so a copied selection keeps its shape (`pdfSelection.ts`).
   * The DOCUMENT's idea of a line, from the structured-text walk, not one
   * inferred from the y coordinates here.
   */
  line: number;
}

/** An EMPTY `t` is dropped: it can match no term, so it is a box that could
 *  only ever be drawn by mistake. */
function oneWord(r: Record<string, unknown>): PdfWord | null {
  const { t, x, y, w, h, l } = r;
  if (typeof t !== "string" || t === "") return null;
  if (!((w as number) > 0) || !((h as number) > 0)) return null;
  // A MISSING LINE ID DEGRADES TO ONE LINE, rather than dropping the word (the
  // box is still correct, and find must not lose a highlight over a field it
  // does not read) or inventing a break per word (which would put a newline
  // between every pair of words in a copied passage).
  const line = typeof l === "number" && Number.isFinite(l) && l >= 0 ? Math.floor(l) : 0;
  return { t, x: x as number, y: y as number, w: w as number, h: h as number, line };
}

export function parsePageWords(json: string): PdfWord[] {
  return parseRecords(json, oneWord);
}

// ---------------------------------------------------------------------------
// Links — the document's own `/Annots`, and the only ones we will follow
// ---------------------------------------------------------------------------

// The record itself is {@link PdfLink}, in `core/types.ts`: the server produces
// the same shape for a `.note`'s links, so it is a wire type and not a decoder
// one. Everything below is what the DECODER's copy of it still needs.

/** Where a link goes, once we have decided we are willing to go there. */
export type PdfLinkTarget =
  | { kind: "page"; page: number }
  | { kind: "external"; href: string };

/** An empty `uri` is nowhere to go, and a zero-area rect is nothing to click. */
function oneLink(r: Record<string, unknown>): PdfLink | null {
  const { x, y, w, h, page, uri } = r;
  if (typeof uri !== "string" || uri === "") return null;
  if (!((w as number) > 0) || !((h as number) > 0)) return null;
  return {
    x: x as number,
    y: y as number,
    w: w as number,
    h: h as number,
    page: page as number,
    uri,
  };
}

export function parsePageLinks(json: string): PdfLink[] {
  return parseRecords(json, oneLink);
}

/**
 * The schemes a link may carry, and the only ones.
 *
 * `javascript:` above all, but `file:` and `data:` too — a PDF arrives by device
 * sync and its `uri` is attacker-controlled text, so the list is an ALLOWLIST and
 * every unknown scheme falls outside it. `//` is required for the two http ones,
 * because that is what a link to a site looks like and `http:evil` is not.
 */
const ALLOWED = ["http://", "https://", "mailto:"];

/**
 * Where `link` goes, or null if it goes nowhere we will send anyone.
 *
 * A REFUSAL IS NOT A LINK WITH A DEAD HREF: a refused link produces no element
 * at all (`linkLayer.ts` drops it), because an affordance over a target we will
 * not open would lie.
 *
 * The decoder already drops these before they cross (`pdf_shim.c`), and the
 * duplication is deliberate: that side keeps the PAYLOAD honest, and this side
 * is the last gate before a string becomes an `href` a browser will navigate.
 *
 * Anchored at index 0 and case-folded, so neither ` javascript:` (which a
 * browser trims before parsing the scheme) nor `JavaScript:` can pass as
 * "does not start with a scheme we forbid".
 */
export function linkTarget(link: PdfLink): PdfLinkTarget | null {
  if (link.page >= 0) return { kind: "page", page: link.page };
  const uri = link.uri;
  const lower = uri.toLowerCase();
  if (!ALLOWED.some((scheme) => lower.startsWith(scheme))) return null;
  return { kind: "external", href: uri };
}

/**
 * What a screen reader says for this link.
 *
 * NOT OPTIONAL: the page is a RASTER, so an anchor over it contains no text and
 * without this it is an unlabelled link.
 */
export function linkLabel(target: PdfLinkTarget): string {
  return target.kind === "page" ? `Go to page ${target.page + 1}` : target.href;
}

/** A link's box on the raster, in CSS pixels relative to the page's top-left. */
export interface LinkBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Where `link` lands on a page drawn at `canvas` CSS pixels — through the
 *  SHARED mapping, never a second copy of `canvas.width / pagePt.width`. */
export function placeLink(link: PdfLink, pagePt: Size, canvas: Size): LinkBox {
  return placePageRect(link, pagePt, canvas);
}

// ---------------------------------------------------------------------------
// Outline — the document's own table of contents, flattened
// ---------------------------------------------------------------------------

/**
 * One entry of the document's outline, exactly as `ink_load_outline` describes
 * it — in DOCUMENT ORDER (pre-order, depth-first), so the array is already the
 * order the panel draws.
 *
 * FLAT, WITH A DEPTH, RATHER THAN A TREE: MuPDF's `fz_outline` is a tree, but
 * the panel draws a list — one row per entry, indented — so a tree would be
 * marshalled, rebuilt and flattened again to draw it.
 */
export interface PdfOutlineEntry {
  /** Nesting depth; 0 for a top-level entry. */
  depth: number;
  /** The entry's own text. May be empty. */
  title: string;
  /**
   * 0-based page index — handed straight to the viewer's `go(page)` — or `null`
   * when the destination will not resolve.
   *
   * `null` IS A REAL STATE AND NOT AN ERROR: a PDF's outline can name a
   * destination that no longer exists. The entry is still a line the document's
   * author wrote, so it is drawn — as an inert row, not as a jump.
   */
  page: number | null;
}

/**
 * The asymmetry here is a product decision, not a defensive habit:
 *
 *  - a non-string `title` DROPS the entry. The panel's whole content is the
 *    title; there is nothing to draw without one and nothing to guess.
 *  - an absent or unusable `p` KEEPS it, at `page: null`. Dropping it would put
 *    a hole in a table of contents, which reads as "this document has no
 *    Chapter Four" about a chapter that is right there. The shim OMITS `p` for a
 *    destination it could not resolve, so `undefined` is the expected shape.
 *  - an EMPTY title is kept, unlike an empty word: it still carries a page and a
 *    place in the nesting, where a word with no text can match no term.
 */
function oneOutline(r: Record<string, unknown>): PdfOutlineEntry | null {
  const { d, t, p } = r;
  if (typeof t !== "string") return null;
  const page = typeof p === "number" && Number.isInteger(p) && p >= 0 ? p : null;
  return { depth: d as number, title: t, page };
}

export function parseOutline(json: string): PdfOutlineEntry[] {
  return parseRecords(json, oneOutline);
}
