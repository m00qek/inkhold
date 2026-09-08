// What a PDF page's WORDS are on this side of the wire: the payload's shape and
// the space its boxes live in.
//
// No DOM, no wasm — the parse and its refusals alone, so both can be tested at
// the numbers. `pages/pdfFind.ts` is what turns these into a highlight.
//
// A SIBLING OF `pdfLinks.ts`, and the same kind of thing: a rect in the page's
// own display space, carrying one string. They stay separate modules because
// they are separate payloads with separate refusals — a link's `uri` is a
// navigation target and gets an allowlist, a word's `t` is text and gets none —
// but they share `placePageRect`, because a rect in page space is a rect in page
// space and two mappings for one page is how two overlays drift apart.
//
// WHY THE MODULE HANDS OVER WORDS AND NOT MATCHES. The server decides what
// matched; the client only points at it. MuPDF's own `fz_search_page` would
// have been less code and a second
// opinion: its matcher does not fold diacritics, so `avaliação` in the page
// would not answer a query the index counted as `avaliacao`, and the count on
// screen and the boxes under it would describe different things. So the fold
// happens where the other two find controllers already fold — see
// `pages/pdfFind.ts` — and this module is a locator.

/**
 * One word on a page, exactly as `ink_page_words` describes it.
 *
 * `x,y,w,h` are in the page's DISPLAY space — top-left origin, y down, POINTS —
 * the same space `pageSize()` and {@link PdfLink} report. The decoder subtracts
 * the page box's own origin and works from `fz_bound_page`'s transformed box, so
 * a `/Rotate`, an off-origin `/MediaBox` and a `/CropBox` are all already
 * resolved.
 *
 * `t` is a WHITESPACE-AND-PUNCTUATION run, not necessarily one index term:
 * `page-range` may arrive whole. That is a statement about the BOX's precision
 * and never about membership — the caller re-tokenises with the index's own rule
 * before comparing, so a run that holds two terms is one box a little wider than
 * it needed to be.
 *
 * IT IS THE BOUNDING RECT OF THE RUN'S QUADS, not the quads. Text set at an
 * angle inside an upright page therefore gets a box that CONTAINS its glyphs
 * rather than hugging them — over-covering, which under a translucent highlight
 * reads as a slightly generous mark and never as a mark on the wrong words. The
 * common case, and every case the household has, is horizontal text on a page
 * whose own rotation the decoder has already resolved, where the rect is exact.
 */
export interface PdfWord {
  t: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The decoder's JSON, as words — dropping any record that is not one.
 *
 * DEFENSIVE ABOUT ITS OWN SIDE OF THE WIRE, exactly as `parsePageLinks` is, and
 * for the same reason: `t` is text out of a document that arrived by device
 * sync. A malformed payload costs the page its highlight and nothing else —
 * which is the honesty rule's own shape. The page
 * still MATCHED; the server said so, and nothing here can take that back.
 *
 * An empty `t` is dropped rather than kept: it can match no term, so it is a box
 * that could only ever be drawn by mistake.
 */
export function parsePageWords(json: string): PdfWord[] {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const out: PdfWord[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const r = item as Record<string, unknown>;
    const { t, x, y, w, h } = r;
    if (typeof t !== "string" || t === "") continue;
    if ([x, y, w, h].some((v) => typeof v !== "number" || !Number.isFinite(v))) continue;
    if (!((w as number) > 0) || !((h as number) > 0)) continue;
    out.push({ t, x: x as number, y: y as number, w: w as number, h: h as number });
  }
  return out;
}
