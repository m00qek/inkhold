// The READER for the stitched terms stream — §2.2's JSONL
// records, parsed as they land. The writer is `derive_search.zig`'s
// `writeHeader` plus its per-page line, stitched into one gzip member by
// `search/index_stream.zig`. Pure: no wasm, no IndexedDB, no `fetch`.
//
//     {"md5":"…","v":7,"n":14055}          the header line
//     {"p":0,"t":"reuniao orcamento"}      one line per page WITH TEXT
//
// What this must not break:
//   * A generator, not `await response.text()`: on the real tier-1 payload the
//     first document is usable at 8 ms of a 193 ms stream (§3.2), and manifest
//     order is priority order. The parser holds one document plus one partial line.
//   * A record has NO TERMINATOR — the server accumulates nothing — so a
//     document cannot be released until the NEXT header line arrives, or the
//     stream ends.
//   * `v` is the record's OWN version, and half the cache key (§3.3: key what
//     ARRIVED). `n` is the ADDRESS SPACE, not the row count: a page with no
//     text produces no line, and a header with nothing under it is complete.
//   * The body is one native-gzip stream; no `DecompressionStream`.

import { SearchWireError } from "./manifestCodec";

/** One page's folded terms — the FTS5 row §4.1 inserts verbatim. */
export interface TermsPage {
  /** The page/paragraph ordinal, which is every viewer's existing deep-link address. */
  readonly p: number;
  /** Space-separated terms, already folded by the server's own tokenizer. */
  readonly t: string;
}

/** One document's terms record: the header line plus every page line under it. */
export interface TermsDocument {
  /** 32 lowercase hex. Half the cache key. */
  readonly md5: string;
  /** The record's own `v` — the other half of the cache key. */
  readonly indexVersion: number;
  /** `n`: the document's ADDRESS SPACE. NOT `pages.length`. */
  readonly pageCount: number;
  /** Only the pages that carried text, in the order the server wrote them. */
  readonly pages: readonly TermsPage[];
}

const MD5_HEX = /^[0-9a-f]{32}$/;

/**
 * Decode a response body to text progressively. `fatal: true`: the terms are
 * valid UTF-8 by construction, and an index quietly full of U+FFFD matches
 * nothing a user can type and reports no error.
 */
export async function* textChunks(body: ReadableStream<BufferSource>): AsyncGenerator<string> {
  const reader = body.pipeThrough(new TextDecoderStream("utf-8", { fatal: true })).getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value) yield value;
    }
  } finally {
    // A consumer that stops early must not leave the body locked and the
    // connection held open.
    reader.releaseLock();
  }
}

/**
 * Parse the JSONL into documents, yielding each the moment its last line is
 * in hand — which is the next header, or the end of the stream.
 *
 * @throws SearchWireError on a line this build cannot read, a page line with
 * no header before it, or a body that ends mid-line. The last is truncation,
 * and it matters for `manifestCodec.ts`'s reason: a stream that merely ran
 * out is otherwise a shorter, well-formed answer. Documents already yielded
 * stay yielded; the rest are simply still missing at the next manifest.
 */
export async function* parseTermsJsonl(chunks: AsyncIterable<string>): AsyncGenerator<TermsDocument> {
  let buffer = "";
  let open: { md5: string; indexVersion: number; pageCount: number; pages: TermsPage[] } | null = null;

  for await (const chunk of chunks) {
    buffer += chunk;
    let nl = buffer.indexOf("\n");
    while (nl >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      const record = parseLine(line);
      if (record !== null) {
        if ("md5" in record) {
          if (open !== null) yield freeze(open);
          open = { ...record, pages: [] };
        } else {
          if (open === null) {
            throw new SearchWireError("terms stream carries a page line before any document header");
          }
          open.pages.push(record);
        }
      }
      nl = buffer.indexOf("\n");
    }
  }

  // Every record ends in a newline, so anything left is half a line. The
  // gzip trailer would also have failed, but a client that only checked for a
  // resolved `fetch` is exactly §3.1's victim.
  if (buffer.trim().length > 0) {
    throw new SearchWireError("terms stream ends mid-line");
  }
  if (open !== null) yield freeze(open);
}

function freeze(doc: {
  md5: string;
  indexVersion: number;
  pageCount: number;
  pages: TermsPage[];
}): TermsDocument {
  return { md5: doc.md5, indexVersion: doc.indexVersion, pageCount: doc.pageCount, pages: doc.pages };
}

/**
 * One line: a header, a page, or nothing (a blank line between fragments).
 * MISSING FIELDS ARE REFUSED, NOT DEFAULTED: the tempting `n = pages.length`
 * would turn a format change into a client that silently believes every
 * document is shorter than it is.
 */
function parseLine(line: string): { md5: string; indexVersion: number; pageCount: number } | TermsPage | null {
  if (line.trim().length === 0) return null;

  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new SearchWireError("terms stream carries a line that is not JSON");
  }
  if (typeof value !== "object" || value === null) {
    throw new SearchWireError("terms stream carries a line that is not a record");
  }
  const record = value as Record<string, unknown>;

  if ("md5" in record) {
    const md5 = record["md5"];
    const v = record["v"];
    const n = record["n"];
    if (typeof md5 !== "string" || !MD5_HEX.test(md5)) {
      throw new SearchWireError("terms record header carries no usable md5");
    }
    if (!Number.isInteger(v) || (v as number) < 0) {
      throw new SearchWireError(`terms record ${md5} carries no usable index version`);
    }
    if (!Number.isInteger(n) || (n as number) < 0) {
      throw new SearchWireError(`terms record ${md5} carries no usable page count`);
    }
    return { md5, indexVersion: v as number, pageCount: n as number };
  }

  const p = record["p"];
  const t = record["t"];
  if (!Number.isInteger(p) || (p as number) < 0) {
    throw new SearchWireError("terms stream carries a page line with no usable ordinal");
  }
  if (typeof t !== "string") {
    throw new SearchWireError("terms stream carries a page line with no terms");
  }
  return { p: p as number, t };
}
