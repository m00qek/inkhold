// Streaming reader for the stitched terms JSONL. Writer:
// `derive_search.zig` `writeHeader` plus per-page lines, stitched into one
// gzip member by `search/index_stream.zig`.
//
//     {"md5":"…","v":7,"n":14055}          the header line
//     {"p":0,"t":"reuniao orcamento"}      one line per page WITH TEXT
//
// Records have no terminator, so a document is released only when the next
// header arrives or the stream ends. `n` is the address space, not the row count.

import { SearchWireError } from "./manifestCodec";

export interface TermsPage {
  /** The page/paragraph ordinal, every viewer's deep-link address. */
  readonly p: number;
  /** Space-separated terms, already folded by the server's tokenizer. */
  readonly t: string;
}

export interface TermsDocument {
  readonly md5: string;
  /** The record's own `v`, the other half of the cache key. */
  readonly indexVersion: number;
  /** `n`, the address space; not `pages.length`. */
  readonly pageCount: number;
  readonly pages: readonly TermsPage[];
}

const MD5_HEX = /^[0-9a-f]{32}$/;

/** `fatal`: terms are valid UTF-8 by construction, and U+FFFD would match nothing silently. */
export async function* textChunks(body: ReadableStream<BufferSource>): AsyncGenerator<string> {
  const reader = body.pipeThrough(new TextDecoderStream("utf-8", { fatal: true })).getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value) yield value;
    }
  } finally {
    // Unlock so an early-stopping consumer does not hold the connection.
    reader.releaseLock();
  }
}

/**
 * Yields each document once its next header or the stream end arrives.
 * @throws SearchWireError on an unreadable line, a page before any header, or
 * a body ending mid-line (truncation). Documents already yielded stay yielded.
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

  // Leftover text is half a line: truncation, even if `fetch` resolved.
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

/** A header, a page, or null for a blank line. Missing fields are refused, never defaulted. */
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
