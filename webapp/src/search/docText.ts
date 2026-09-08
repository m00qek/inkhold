// ONE DOCUMENT'S TEXT — `golden-search.md` §1.1's other half of the index.
//
//     GET /api/controlplane/text/<md5>?v=<index_version>
//
// The terms stream (`termsStream.ts`) carries the whole library's FOLDED terms,
// one row per page, and answers "which document". This route carries ONE
// document's REAL TEXT, one row per segment, and answers "where in it". Same
// engine, same tokenizer, same `idx_query` fold — the difference is the data,
// which is the entire point of §1.1.
//
// ## The record, and the two fields that are only sometimes there
//
//     {"md5":"…","v":15,"n":14055}                 the header line
//     {"p":0,"o":0,"l":142,"t":"the real text"}    one line per segment
//     {"p":1,"t":"the real text"}                  …with no byte range
//
//   * `p` is the ordinal, and in `.note` and `.pdf` the ordinal IS the address:
//     a page number, which every viewer already deep-links to.
//   * `o`/`l` appear only for `.txt`, where the ordinal is a paragraph index and
//     the ADDRESS is a byte range in the raw blob. `txtFind.ts`'s `byteToCharMap`
//     is the sole conversion from that range to the UTF-16 index the viewer
//     holds, which is why the range has to travel.
//   * `n` is the ADDRESS SPACE, not the row count — a segment that extracted to
//     nothing produces no line, exactly as in the terms record.
//
// The absent `o`/`l` are decoded as `null` rather than 0: a `.txt` paragraph
// legitimately starts at byte 0, so a defaulted 0 would be indistinguishable
// from the real first paragraph and would map every `.note` page onto the top of
// a file that has none.
//
// The text is UNFOLDED — accents intact, unlike `terms/`. FTS5 folds it on
// insert, which is what keeps the fold single, and it is what makes the byte
// ranges usable: they address the raw blob the viewer itself decoded.
//
// ## `?v=` IS HALF THE CACHE KEY, and without it the immutability is a lie
//
// The stored file is keyed by `(md5, index_version)`, and the PATH carries only
// the md5. An `index_version` bump re-derives the same md5 into a NEW file and
// unlinks the old one — so a long-lived `immutable` response on a bare
// `/text/{md5}` would strand the browser on text an old parser produced, on a URL
// that cannot change to say so. That is the `PageTextVO.words` regression this
// repo's cache-policy pin exists to prevent.
//
// So the version rides the query string, exactly as `?v={fileHash}` does for raw
// bytes and `?v={textHash}` for page text — the established convention here
// rather than a new idea. The server ignores it for lookup (it always serves the
// current version); it exists to make the URL MOVE.
//
// It is OMITTED when unknown rather than guessed at: a session that has never
// managed a manifest sync has no version to send, and a URL that merely fails to
// move is better than one asserting a version nobody has.
//
// ## `Content-Encoding`, NOT `DecompressionStream`
//
// The body is ONE ordinary gzip stream and the browser inflates it natively.
// Reaching for `DecompressionStream` here would be decompressing an
// already-decompressed body — the same trap `termsStream.ts` names.
//
// ## …and unlike the terms stream, this one IS read whole
//
// `termsStream.ts` is a generator because its first document is usable at 8 ms
// of a 193 ms stream (§3.2) and manifest order is priority order. There is no
// such win here: this is one document, and nothing can be shown until it has
// been INDEXED — `SearchIndex.build` takes the whole document under one
// transaction (24k autocommitted inserts would be 24k FTS5 segments). So the
// body is read whole, parsed whole, and handed over. The worst real document is
// 3.15 MB of text / 14,055 segments and builds in 363 ms (§8.1).
//
// ## There is no cache here, deliberately
//
// §4.4: `text/<md5>` is content-addressed and `cache-control: private,
// immutable`, so the HTTP cache is the offline story and it costs no code. A
// second store on this side would be a byte budget over something the browser is
// already budgeting, and it would have to be invalidated by a hash that cannot
// change. `docSearch.ts` holds the ONE document it has indexed and nothing more.

import { bytesBudget } from "../api/client";
import { SearchWireError } from "./wire";

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
  /** The segment's real text, unfolded — FTS5 folds it on insert. */
  readonly t: string;
}

/** One document's text record. */
export interface DocumentText {
  /** 32 lowercase hex — the blob's content address, and the route's key. */
  readonly md5: string;
  /** The record's own `v`. Carried because it is what the record was DERIVED at;
   *  nothing here compares it, and a stale one is impossible by construction —
   *  the route serves whatever the current derivation is under an immutable
   *  cache key that includes the md5. */
  readonly indexVersion: number;
  /** `n`: the ADDRESS SPACE. Not `segments.length`. */
  readonly segmentCount: number;
  /** Only the segments that carried text, in the order the server wrote them. */
  readonly segments: readonly TextSegment[];
}

/**
 * The route answered 404.
 *
 * DELIBERATELY AMBIGUOUS, and the server means it to be: the caller cannot reach
 * that md5, OR the document is not derived yet. Distinguishing them would tell an
 * unauthorized caller which md5s exist.
 *
 * It is NOT an empty result. A find that renders this as "No matches" would be a
 * confident false statement about a document that may well contain the word —
 * the exact failure `pdfFind.ts`'s honesty rule exists to prevent — so it reaches
 * the viewers as their `error` state instead.
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
 * How `docSearch.ts` gets a document's text. Injectable so tests need no network.
 *
 * `indexVersion` is the manifest's, and it is the half of the cache key the path
 * cannot carry — see the header. `null` means "not known", never "version 0".
 */
export type TextTransport = (
  md5: string,
  indexVersion: number | null,
  signal?: AbortSignal,
) => Promise<DocumentText>;

const MD5_HEX = /^[0-9a-f]{32}$/;

/**
 * Parse a whole text record.
 *
 * Refuses what it cannot read rather than defaulting it, for the reason
 * `termsStream.ts` gives: the tempting default is `n = segments.length`, which is
 * wrong by construction, and a defaulted `o` is a byte range pointing at the top
 * of the file.
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
      // ONE document per record, so a second header is not a new document — it is
      // a stitched stream reaching a route that serves single records, which
      // would otherwise index two documents' segments under one ordinal space.
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

  // A header with nothing under it is legitimate and complete — a document whose
  // text extracted to nothing. A record with no header at all is not.
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
  // `o` and `l` travel TOGETHER or not at all: half a byte range addresses
  // nothing, and a length with no offset would silently mark from byte 0.
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
 * The real transport. Cookie-authenticated like every other control-plane call,
 * and on the BYTES budget rather than a total-duration cap for the reason
 * `indexTransport.ts` gives: a stall at 5% and a slow success over a 3G link are
 * indistinguishable to a total-duration timer, and the worst document is 3.15 MB.
 */
export function httpTextTransport(): TextTransport {
  return async (md5, indexVersion, signal) => {
    const budget = bytesBudget(signal);
    // Through `URLSearchParams` rather than pasted in, for the reason
    // `indexTransport.ts` gives about the stream's `m=`: a value that only
    // happens to be URL-safe today is a percent-encoding bug tomorrow.
    const query = indexVersion === null ? "" : `?${new URLSearchParams({ v: String(indexVersion) })}`;
    try {
      const res = await fetch(`${TEXT_URL}/${encodeURIComponent(md5)}${query}`, {
        credentials: "same-origin",
        signal: budget.signal,
      });
      // BYTE-IDENTICAL FOR EVERY REFUSAL — unreachable md5, underived, no such
      // blob, malformed md5. Distinguishing them would tell an unauthorized
      // caller which md5s exist, so this does not try.
      if (res.status === 404) throw new DocumentTextUnavailable(md5);
      if (!res.ok) throw new Error(`text/${md5}: ${res.status}`);
      // `content-encoding: gzip` is inflated by the browser before this resolves.
      return parseDocumentText(await res.text());
    } finally {
      budget.done();
    }
  };
}
