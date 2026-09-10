// ONE DOCUMENT'S TEXT — §1.1's other half of the index.
//
//     GET /api/controlplane/text/<md5>?v=<index_version>
//
//     {"md5":"…","v":15,"n":14055}                 the header line
//     {"p":0,"o":0,"l":142,"t":"the real text"}    one line per segment
//     {"p":1,"t":"the real text"}                  …with no byte range
//
// What this must not break:
//   * `?v=` IS HALF THE CACHE KEY. The response is `immutable` and the path
//     carries only the md5; an `index_version` bump re-derives the same md5
//     into a NEW file, so without `?v=` the browser is stranded on an old
//     parser's text with no symptom (the `PageTextVO.words` regression). The
//     server ignores it for lookup; it exists to make the URL MOVE. Omitted
//     when unknown, never guessed.
//   * Absent `o`/`l` decode as `null`, not 0: a `.txt` paragraph legitimately
//     starts at byte 0, and a defaulted 0 would map every `.note` page onto
//     the top of a file that has none.
//   * `n` is the ADDRESS SPACE, not the row count — an empty segment produces
//     no line. Read whole (nothing shows before the whole document is indexed);
//     browser-inflated gzip, no `DecompressionStream`; no cache here — the
//     HTTP cache is the on-demand story (§4.4).

import { bytesBudget } from "../api/client";
import { SearchWireError } from "./manifestCodec";

const TEXT_URL = "/api/controlplane/text";

/** One extracted segment: its ordinal, its address where the ordinal is not one,
 *  and its text. */
export interface TextSegment {
  /** The ordinal — a `.note` page, a PDF page, a `.txt` paragraph. */
  readonly p: number;
  /** The `.txt` byte offset into the raw blob. `null` for `.note` and `.pdf`,
   *  where `p` is already the address. */
  readonly o: number | null;
  /** The `.txt` byte length. `null` wherever {@link o} is. */
  readonly l: number | null;
  /** The segment's real text, unfolded — FTS5 folds it on insert, which keeps
   *  the fold single and the byte ranges usable against the raw blob. */
  readonly t: string;
}

/** One document's text record. */
export interface DocumentText {
  /** 32 lowercase hex — the blob's content address, and the route's key. */
  readonly md5: string;
  /** The record's own `v` — what it was DERIVED at. Nothing here compares it. */
  readonly indexVersion: number;
  /** `n`: the ADDRESS SPACE. Not `segments.length`. */
  readonly segmentCount: number;
  /** Only the segments that carried text, in the order the server wrote them. */
  readonly segments: readonly TextSegment[];
}

/**
 * The route answered 404. DELIBERATELY AMBIGUOUS — unreachable md5 or not yet
 * derived — because distinguishing them would tell an unauthorized caller
 * which md5s exist. NOT an empty result: rendering it as "No matches" would be
 * a confident false statement, so it reaches the viewers as their `error` state.
 */
export class DocumentTextUnavailable extends Error {
  override readonly name = "DocumentTextUnavailable";
  readonly md5: string;
  constructor(md5: string) {
    super(`no text record for ${md5}`);
    this.md5 = md5;
  }
}

/**
 * How `docSearch.ts` gets a document's text. Injectable so tests need no
 * network. `indexVersion` null means "not known", never "version 0".
 */
export type TextTransport = (
  md5: string,
  indexVersion: number | null,
  signal?: AbortSignal,
) => Promise<DocumentText>;

const MD5_HEX = /^[0-9a-f]{32}$/;

/**
 * Parse a whole text record. Refuses what it cannot read rather than
 * defaulting it: the tempting default `n = segments.length` is wrong by
 * construction, and a defaulted `o` is a byte range pointing at the top of
 * the file.
 */
export function parseDocumentText(body: string): DocumentText {
  let header: { md5: string; indexVersion: number; segmentCount: number } | null = null;
  const segments: TextSegment[] = [];

  for (const line of body.split("\n")) {
    if (line.trim().length === 0) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new SearchWireError("text record carries a line that is not JSON");
    }
    if (typeof value !== "object" || value === null) {
      throw new SearchWireError("text record carries a line that is not a record");
    }
    const record = value as Record<string, unknown>;

    if ("md5" in record) {
      // A second header is a stitched stream reaching a single-record route,
      // which would index two documents' segments under one ordinal space.
      if (header !== null) throw new SearchWireError("text record carries a second document header");
      const md5 = record["md5"];
      const v = record["v"];
      const n = record["n"];
      if (typeof md5 !== "string" || !MD5_HEX.test(md5)) {
        throw new SearchWireError("text record header carries no usable md5");
      }
      if (!Number.isInteger(v) || (v as number) < 0) {
        throw new SearchWireError(`text record ${md5} carries no usable index version`);
      }
      if (!Number.isInteger(n) || (n as number) < 0) {
        throw new SearchWireError(`text record ${md5} carries no usable segment count`);
      }
      header = { md5, indexVersion: v as number, segmentCount: n as number };
      continue;
    }

    if (header === null) {
      throw new SearchWireError("text record carries a segment line before its header");
    }
    segments.push(parseSegment(record));
  }

  // A header with nothing under it is a complete document whose text
  // extracted to nothing. No header at all is not.
  if (header === null) throw new SearchWireError("text record carries no document header");
  return { ...header, segments };
}

function parseSegment(record: Record<string, unknown>): TextSegment {
  const p = record["p"];
  const t = record["t"];
  if (!Number.isInteger(p) || (p as number) < 0) {
    throw new SearchWireError("text record carries a segment line with no usable ordinal");
  }
  if (typeof t !== "string") {
    throw new SearchWireError("text record carries a segment line with no text");
  }
  // `o` and `l` travel TOGETHER or not at all: a length with no offset would
  // silently mark from byte 0.
  const hasO = "o" in record;
  const hasL = "l" in record;
  if (hasO !== hasL) {
    throw new SearchWireError("text record carries half a byte range");
  }
  if (!hasO) return { p: p as number, o: null, l: null, t };
  const o = record["o"];
  const l = record["l"];
  if (!Number.isInteger(o) || (o as number) < 0 || !Number.isInteger(l) || (l as number) < 0) {
    throw new SearchWireError("text record carries an unusable byte range");
  }
  return { p: p as number, o: o as number, l: l as number, t };
}

/**
 * The real transport. Cookie-authenticated, and on the BYTES budget rather
 * than a total-duration cap (`indexTransport.ts`): a stall at 5% and a slow
 * success over 3G are indistinguishable to a timer, and the worst document is
 * 3.15 MB.
 */
export function httpTextTransport(): TextTransport {
  return async (md5, indexVersion, signal) => {
    const budget = bytesBudget(signal);
    // Through `URLSearchParams`: a value that happens to be URL-safe today is a
    // percent-encoding bug tomorrow.
    const query = indexVersion === null ? "" : `?${new URLSearchParams({ v: String(indexVersion) })}`;
    try {
      const res = await fetch(`${TEXT_URL}/${encodeURIComponent(md5)}${query}`, {
        credentials: "same-origin",
        signal: budget.signal,
      });
      // BYTE-IDENTICAL FOR EVERY REFUSAL — see `DocumentTextUnavailable`.
      if (res.status === 404) throw new DocumentTextUnavailable(md5);
      if (!res.ok) throw new Error(`text/${md5}: ${res.status}`);
      // `content-encoding: gzip` is inflated by the browser before this resolves.
      return parseDocumentText(await res.text());
    } finally {
      budget.done();
    }
  };
}
