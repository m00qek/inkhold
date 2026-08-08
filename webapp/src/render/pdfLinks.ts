// What a PDF's own links ARE on this side of the wire: the payload's shape, the
// schemes a viewer may follow, and where a link's rect lands on the raster.
//
// No DOM, no wasm — the arithmetic and the refusals alone, so both can be tested
// at the numbers rather than by looking at a screenshot. `pages/pdfLinkLayer.ts`
// is what turns these into anchors.
//
// A SIBLING OF `markGeometry.ts` — its PAYLOAD is, at least. The two hard
// problems stay apart: that file reconstructs the device panel's fit over the
// page it annotates, and this one has no fitting to do, because the rects arrive
// already in the page's own display space (`webapp/wasm/pdf_shim.c` makes that
// true) and the only transform left is the raster's scale.
//
// THAT SCALE NOW LIVES THERE, and the reason is arithmetic rather than taxonomy:
// find's highlights are a second thing drawn in the page's own points, and one
// page must have ONE page→screen mapping or the two overlays drift apart on a
// rotated document. `placePageRect` is that mapping; what stays here is the
// payload, the allowlist and the labels — which is where the difficulty actually
// is on this side.

import { placePageRect, type Size } from "./markGeometry";

/**
 * One link on a page, exactly as `ink_page_links` describes it.
 *
 * `x,y,w,h` are in the page's DISPLAY space — top-left origin, y down, POINTS —
 * the same space `pageSize()` reports. The decoder subtracts the page box's own
 * origin and works from `fz_bound_page`'s transformed box, so a `/Rotate`, an
 * off-origin `/MediaBox` and a `/CropBox` are all already resolved.
 *
 * `page` is the resolved 0-based target of an INTERNAL link, or -1 for an
 * external one. Resolving happens in the decoder, where the document is.
 */
export interface PdfLink {
  x: number;
  y: number;
  w: number;
  h: number;
  page: number;
  uri: string;
}

/** Where a link goes, once we have decided we are willing to go there. */
export type PdfLinkTarget =
  | { kind: "page"; page: number }
  | { kind: "external"; href: string };

/**
 * The decoder's JSON, as links — dropping any record that is not one.
 *
 * DEFENSIVE ABOUT ITS OWN SIDE OF THE WIRE, which is not paranoia about the
 * decoder so much as about the file: `uri` is text out of a document that
 * arrived by device sync, and the rect is numbers out of the same place. A
 * malformed payload costs the page its links and nothing else, because a
 * viewer that cannot list a page's links is still a viewer.
 */
export function parsePageLinks(json: string): PdfLink[] {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const out: PdfLink[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const r = item as Record<string, unknown>;
    const { x, y, w, h, page, uri } = r;
    if (typeof uri !== "string" || uri === "") continue;
    if (typeof page !== "number" || !Number.isInteger(page)) continue;
    if ([x, y, w, h].some((v) => typeof v !== "number" || !Number.isFinite(v))) continue;
    if (!((w as number) > 0) || !((h as number) > 0)) continue;
    out.push({
      x: x as number,
      y: y as number,
      w: w as number,
      h: h as number,
      page,
      uri,
    });
  }
  return out;
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
 * A REFUSAL IS NOT A LINK WITH A DEAD HREF. Rendering an anchor whose target we
 * have neutered would put a thing that looks clickable over a thing that is
 * not — the affordance would lie — so a refused link produces no element at all
 * (`pdfLinkLayer.ts` drops it) and the page underneath is what the user gets.
 *
 * The decoder already drops these before they cross (`pdf_shim.c`), and the
 * duplication is deliberate: that side keeps the PAYLOAD honest, and this side
 * is the last gate before a string becomes an `href` a browser will navigate.
 * Only one of the two is standing between a hostile file and the DOM.
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
 * NOT OPTIONAL, and the reason is that there is nothing else. The page is a
 * RASTER: an anchor over it contains no text, so without this it is an
 * unlabelled link — which reads out as its own href at best and as "link" at
 * worst, and is worse than no link at all.
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

/**
 * Where `link` lands on a page drawn at `canvas` CSS pixels.
 *
 * THE SHARED MAPPING, not one of its own. It used to be the two lines
 * `placePageRect` now holds, which was right while links were the only thing
 * this app drew in the page's own points. Find's highlights are the second, and
 * a second copy of `canvas.width / pagePt.width` is exactly how two overlays on
 * one page come to disagree — so the arithmetic moved to `markGeometry.ts`,
 * beside the transform that places the `.mark` ink on the same canvas, and both
 * callers name it.
 */
export function placeLink(link: PdfLink, pagePt: Size, canvas: Size): LinkBox {
  return placePageRect(link, pagePt, canvas);
}
