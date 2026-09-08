// The READER for the stitched terms stream — `golden-search.md` §2.2's JSONL
// records, parsed as they land off the wire. The writer is
// `backend/services/derive_search.zig`'s `writeHeader` plus its per-page line,
// stitched into one gzip member by `backend/services/search/index_stream.zig`.
//
// Pure: no wasm, no IndexedDB, no `fetch`. It turns chunks of text into
// documents and nothing else, which is what lets the progressive property be
// tested without a network or a stream at all — hand it two chunks and assert
// the first document is out before the second arrives.
//
// ## WHY THIS IS A GENERATOR AND NOT A `json.parse` OF THE BODY
//
// MEASURED (§3.2), on the real tier-1 payload — 186 documents, 147,293 bytes on
// the wire decoding to 341,466 bytes of JSONL: **the first document is parsed
// and usable at 8 ms of a 193 ms stream.** Manifest order is tier order is
// priority order, so those first bytes are the household's own newest
// handwriting. `await response.text()` throws that away and costs 193 ms before
// anything at all exists — on the 3G link this project is calibrated for, more.
//
// So the consumer pulls documents one at a time and the parser holds exactly one
// document plus one partial line. Nothing here accumulates the body.
//
// **A document is released when the NEXT header line arrives**, or at the end of
// the stream. There is no length prefix and no terminator to release it any
// earlier — the server accumulates nothing and writes each page's terms the
// moment it folds them (§2.2), so "this document has ended" is a fact only the
// next one carries. On the real payload that is the very next line, which is why
// the 8 ms figure holds; the one document that waits is the last, and it waits
// for the end of a stream it is already at.
//
// ## `Content-Encoding`, NOT `DecompressionStream`
//
// The body is ONE ordinary single-member gzip (§3.2) and the browser inflates it
// natively before `response.body` ever yields a byte. Reaching for
// `DecompressionStream` here would be decompressing an already-decompressed
// stream. `DecompressionStream` belongs to the framed fallback in §3.2, which is
// not what the server serves.
//
// ## The record (§2.2), and the two fields that are easy to get wrong
//
//     {"md5":"…","v":7,"n":14055}          the header line
//     {"p":0,"t":"reuniao orcamento"}      one line per page WITH TEXT
//     {"p":3,"t":"reuniao acta"}
//
//   * `v` is the record's OWN content version, and it — not the manifest's
//     `indexVersion` — is half the cache key, because §3.3's rule is that the
//     client keys what it stores on what ARRIVED.
//   * `n` is the document's ADDRESS SPACE, not the row count. A page with no
//     recognised text produces NO LINE, so `pages.length < n` is the normal
//     case and a header line with nothing after it is a legitimate, complete,
//     fully-derived document whose text folded to nothing.

import { SearchWireError } from "./wire";

/** One page's folded terms — the FTS5 row `golden-search.md` §4.1 inserts verbatim. */
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
 * Decode a response body to text progressively.
 *
 * `fatal: true` for the same reason `wire.ts`'s decoder is fatal: terms reached
 * the browser having been folded by SQLite's tokenizer, so they are valid UTF-8
 * by construction, and a replacement character would mean the stream has come
 * apart. An index quietly full of U+FFFD matches nothing a user can type and
 * reports no error.
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
    // A consumer that stops early (an abort, a throw while storing) must not
    // leave the body locked and the connection held open.
    reader.releaseLock();
  }
}

/**
 * Parse the JSONL into documents, yielding each one the moment its last line is
 * in hand.
 *
 * A document is CLOSED by the next header line or by the end of the stream —
 * there is no length prefix and no terminator, because the format is designed to
 * be produced by a server that accumulates nothing (§2.2).
 *
 * @throws SearchWireError on a line this build cannot read, on a page line with
 * no header before it, and on a body that ends mid-line. That last one is the
 * truncation case, and it matters here for the same reason it matters in
 * `manifestCodec.ts`: a stream that merely ran out is otherwise a shorter,
 * perfectly well-formed answer. Documents already yielded stay yielded — a
 * caller that has stored them keeps them, and the ones that did not arrive are
 * simply still missing at the next manifest.
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

  // Every record the writer emits ends in a newline, so anything left is half a
  // line: the body stopped early. The stitched stream's own trailer would also
  // have failed to inflate, but a client that only checked for a resolved
  // `fetch` is exactly §3.1's victim, so this is checked here too.
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
 *
 * MISSING FIELDS ARE REFUSED, NOT DEFAULTED, and it is the same call
 * `manifestCodec.ts` makes about unknown tiers. The tempting default is
 * `n = pages.length`, which is wrong by construction — `n` is the address space
 * and the row count is deliberately smaller — and it would turn a format change
 * into a client that silently believes every document is shorter than it is.
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
