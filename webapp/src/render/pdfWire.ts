// Records crossing the PDF wasm boundary as JSON from `pdf_shim.c` (words,
// links, outline) and the judgement applied to each. No DOM, no wasm. All rects
// are in page display space and map to screen only via `placePageRect`.

import type { PdfLink } from "../core/types";
import { placePageRect, type Size } from "./markGeometry";

/**
 * The decoder's JSON as records, dropping anything `one` refuses. Shape is
 * trusted (the shim wrote it); content is not, since documents arrive by device
 * sync. A refusal never throws: it costs the page its highlights, links or
 * outline, nothing more.
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

// ---- words ----

/**
 * One word as `ink_page_words` describes it: display space (top-left, y down,
 * points; rotation and boxes already resolved). `t` is a whitespace/punctuation
 * run, so callers re-tokenise with `search/fold.ts`. The box bounds the run's
 * quads, over-covering angled text.
 */
export interface PdfWord {
  t: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Zero-based text line in the shim's structured-text order, for copy. */
  line: number;
}

/** An empty `t` is dropped: it can match no term. */
function oneWord(r: Record<string, unknown>): PdfWord | null {
  const { t, x, y, w, h, l } = r;
  if (typeof t !== "string" || t === "") return null;
  if (!((w as number) > 0) || !((h as number) > 0)) return null;
  // A missing line id degrades to line 0, not a dropped word or a break per word.
  const line = typeof l === "number" && Number.isFinite(l) && l >= 0 ? Math.floor(l) : 0;
  return { t, x: x as number, y: y as number, w: w as number, h: h as number, line };
}

export function parsePageWords(json: string): PdfWord[] {
  return parseRecords(json, oneWord);
}

// ---- links ----

// The record is {@link PdfLink} in `core/types.ts`, shared with `.note` links.

export type PdfLinkTarget =
  | { kind: "page"; page: number }
  | { kind: "external"; href: string };

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
 * Link scheme allowlist: a synced PDF's `uri` is attacker-controlled. `//` is
 * required for http(s).
 */
const ALLOWED = ["http://", "https://", "mailto:"];

/**
 * Where `link` goes, or null (no element at all). Repeats `pdf_shim.c`'s check
 * on purpose as the last gate before an `href`. Anchored and case-folded, so
 * ` javascript:` and `JavaScript:` fail.
 */
export function linkTarget(link: PdfLink): PdfLinkTarget | null {
  if (link.page >= 0) return { kind: "page", page: link.page };
  const uri = link.uri;
  const lower = uri.toLowerCase();
  if (!ALLOWED.some((scheme) => lower.startsWith(scheme))) return null;
  return { kind: "external", href: uri };
}

/** The accessible name; required since the anchor sits over a raster. */
export function linkLabel(target: PdfLinkTarget): string {
  return target.kind === "page" ? `Go to page ${target.page + 1}` : target.href;
}

export interface LinkBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** `link`'s box at `canvas` CSS px, through the shared page mapping. */
export function placeLink(link: PdfLink, pagePt: Size, canvas: Size): LinkBox {
  return placePageRect(link, pagePt, canvas);
}

// ---- outline ----

/**
 * One outline entry as `ink_load_outline` gives it: flat with a depth, in
 * pre-order, which is the panel's draw order.
 */
export interface PdfOutlineEntry {
  depth: number;
  title: string;
  /** 0-based page for `go(page)`, or null for a dangling destination (drawn inert). */
  page: number | null;
}

/**
 * A non-string `title` drops the entry; a missing `p` (the shim omits it for an
 * unresolved destination) keeps it at `page: null`, so the contents have no
 * holes. Empty titles are kept.
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
