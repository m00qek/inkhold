// One document's text record, for in-document find.
//
//     GET /api/controlplane/text/<md5>?v=<index_version>
//
//     {"md5":"…","v":15,"n":14055}                 the header line
//     {"p":0,"o":0,"l":142,"t":"the real text"}    one line per segment
//     {"p":1,"t":"the real text"}                  …with no byte range
//
// The response is `immutable` and keyed by md5 only, so `?v=` exists to make
// the URL move when re-derivation changes the text; omitted when unknown.
// `n` is the address space, not the row count: empty segments have no line.

import { bytesBudget } from "../api/client";
import { SearchWireError } from "./manifestCodec";

const TEXT_URL = "/api/controlplane/text";

/** One extracted segment. */
export interface TextSegment {
  readonly p: number;
  /** `.txt` byte offset into the raw blob; `null` where `p` is the address. A real 0 is a `.txt` start. */
  readonly o: number | null;
  readonly l: number | null;
  /** Unfolded; FTS5 folds on insert, keeping byte ranges valid against the blob. */
  readonly t: string;
}

export interface DocumentText {
  readonly md5: string;
  /** The record's own `v`, what it was derived at. */
  readonly indexVersion: number;
  /** `n`, the address space; not `segments.length`. */
  readonly segmentCount: number;
  readonly segments: readonly TextSegment[];
}

/**
 * The route answered 404: unreachable and not-yet-derived are deliberately
 * indistinguishable, so md5 existence does not leak. Shown as an error, never
 * as "No matches".
 */
export class DocumentTextUnavailable extends Error {
  override readonly name: string = "DocumentTextUnavailable";
  readonly md5: string;
  constructor(md5: string) {
    super(`no text record for ${md5}`);
    this.md5 = md5;
  }
}

/**
 * The 404 of a document the manifest marks pending: a server job still owes
 * it its text (a new upload, a fresh sync), so the text is on the way, not
 * missing. Told apart by the manifest, so the route itself still leaks nothing.
 */
export class DocumentTextPending extends DocumentTextUnavailable {
  override readonly name = "DocumentTextPending";
}

/** `indexVersion` null means "not known", never version 0. */
export type TextTransport = (
  md5: string,
  indexVersion: number | null,
  signal?: AbortSignal,
) => Promise<DocumentText>;

const MD5_HEX = /^[0-9a-f]{32}$/;

/** Refuses what it cannot read rather than defaulting `n` or `o`. */
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
      // A second header means a stitched stream reached a single-record route.
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

  // A header with no segments is a document whose text extracted to nothing.
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
  // `o` and `l` travel together; a lone length would mark from byte 0.
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
 * Cookie-authenticated, on the bytes budget rather than a duration cap: a
 * stall and a slow 3G success look the same to a timer.
 */
export function httpTextTransport(): TextTransport {
  return async (md5, indexVersion, signal) => {
    const budget = bytesBudget(signal);
    const query = indexVersion === null ? "" : `?${new URLSearchParams({ v: String(indexVersion) })}`;
    try {
      const res = await fetch(`${TEXT_URL}/${encodeURIComponent(md5)}${query}`, {
        credentials: "same-origin",
        signal: budget.signal,
      });
      if (res.status === 404) throw new DocumentTextUnavailable(md5);
      if (!res.ok) throw new Error(`text/${md5}: ${res.status}`);
      return parseDocumentText(await res.text());
    } finally {
      budget.done();
    }
  };
}
