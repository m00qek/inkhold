// The DECODER for the server's term-index payload — the inverted `term -> documents`
// index the browser searches instead of asking the server (`client-side-search.md`
// §2.1, `client-side-search-impl.md` §2.3). The encoder is
// `backend/services/search/index_export.zig`, and the two are pinned to each other
// by ONE checked-in artifact, `backend/services/search/testdata/term_index_golden.bin`,
// which this module's test decodes against expectations written out by hand HERE.
// Regenerating that file to make the Zig test pass turns this side red, which is
// the only arrangement that catches a format change made on one side only.
//
// Pure: no wasm, no network, no DOM. It lives in `search/` rather than `pages/`
// for the same reason `render/spdDecode.ts` lives outside it — the search route
// is one consumer and the engine that loads the index is another.
//
// ## The version byte is NOT `index_version`
//
// `FORMAT_VERSION` says how these bytes are SPELT. `index_version` says what the
// terms MEAN — a new server-side parser over the same blob yields different text
// and therefore a different term set, and every client has to re-derive its whole
// library. They move for unrelated reasons and at wildly different costs.
// Conflating them is how a client throws away a household's index to pick up a
// codec change that would not have altered a single term. So an unknown version
// here THROWS: mis-decoding a dictionary produces terms that match nothing and no
// error, which is the failure this whole design is trying not to introduce.
//
// ## md5s, never ordinals
//
// Postings on the wire are ordinals into the payload's own document table, and an
// ordinal is meaningful only inside ONE payload — the next bundle covers a
// different document set and renumbers everything. This module never surfaces one.
// Everything it returns is keyed by md5, which is what sync, the local store and
// the live file listing all key on.
//
// ## Layout (mirrors `index_export.zig`'s header; change both or neither)
//
//     "TIDX"                     magic, 4 bytes
//     FORMAT_VERSION             u8
//     docCount                   u32 LE
//     termCount                  u32 LE
//     docCount x md5             16 RAW bytes each, ordinal order
//     termCount x term record:
//       shared                   varint  bytes shared with the PREVIOUS term
//       suffixLen                varint
//       suffix                   suffixLen bytes
//       postingCount             varint  >= 1
//       delta[0]                 varint  = the first ordinal
//       delta[i]                 varint  = ordinal[i] - ordinal[i-1], >= 1

import { Cursor, SearchWireError, UTF8, readMagic } from "./wire";

/** The wire spelling this build understands. NOT `index_version` — see above. */
export const FORMAT_VERSION = 1;

/** magic + version + docCount + termCount. */
export const HEADER_LEN = 13;

/** "TIDX". Four bytes so an error page or a truncated body fails on byte 0. */
const MAGIC = [0x54, 0x49, 0x44, 0x58];

/**
 * A payload this build refuses to read.
 *
 * **An alias, not a class of its own.** It was one until the manifest decoder
 * landed beside this file and needed the same behaviour from the same cursor;
 * two classes would have invited a `catch` that handled one and let the other
 * escape. The name is kept because it is what every caller already imports, and
 * the distinction that mattered — "the server speaks a format I do not", which
 * wants a reload rather than a retry — is unchanged.
 */
export { SearchWireError as TermCodecError } from "./wire";

/** One decoded payload, entirely in md5 terms. */
export interface TermIndex {
  /**
   * Every md5 the payload covers, in ordinal order.
   *
   * A document listed here that appears in NO posting list is derived-and-EMPTY
   * — a final answer (`client-side-search.md` §4). It is not the same as a
   * document absent from the payload altogether, and a store that cannot tell
   * the two apart re-requests the empty one on every visit, forever.
   */
  readonly documents: readonly string[];
  /** term -> the md5s holding it, in the payload's document order. */
  readonly postings: ReadonlyMap<string, readonly string[]>;
}

/** Called once per term, in the payload's ascending term order. */
export type TermVisitor = (term: string, documents: readonly string[]) => void;

function readHeader(cursor: Cursor): { docCount: number; termCount: number } {
  if (cursor.bytes.length < HEADER_LEN) {
    throw new SearchWireError("term index payload is shorter than its header");
  }
  readMagic(cursor, MAGIC, FORMAT_VERSION);
  const docCount = cursor.u32();
  const termCount = cursor.u32();
  // Checked BEFORE the table is allocated: a corrupt `docCount` is four bytes
  // that would otherwise ask the browser for an array of four billion strings.
  if (HEADER_LEN + docCount * 16 > cursor.bytes.length) {
    throw new SearchWireError("term index payload is too short for the document table it declares");
  }
  return { docCount, termCount };
}

function readDocuments(cursor: Cursor, docCount: number): string[] {
  const documents: string[] = new Array<string>(docCount);
  // Lowercase hex, always — `Cursor.md5` is shared with the manifest decoder for
  // exactly this reason. The md5 is the key the store, the manifest and the live
  // listing all meet on; a payload that spelt it differently would read as a
  // document the client has never seen and be fetched again on every visit.
  for (let i = 0; i < docCount; i += 1) documents[i] = cursor.md5();
  return documents;
}

/**
 * Decode without materialising the index — `visit` is called once per term and
 * nothing accumulates. Returns the ordinal -> md5 table.
 *
 * This is the shape the engine wants: the dev corpus is 63,578 terms and a
 * `Map` of them with an array each is tens of megabytes of JS heap against a
 * wasm instance that already costs 17.4 MB (`wasm-search-bench.md` §8), so the
 * consumer that pipes terms straight into FTS5 must never be forced to build one.
 */
export function readTermIndex(payload: Uint8Array, visit: TermVisitor): string[] {
  const cursor = new Cursor(payload);
  const { docCount, termCount } = readHeader(cursor);
  const documents = readDocuments(cursor, docCount);

  let previous = new Uint8Array(0);
  for (let t = 0; t < termCount; t += 1) {
    const shared = cursor.varint();
    const suffixLen = cursor.varint();
    if (shared > previous.length) {
      throw new SearchWireError("term index shares more bytes than its predecessor has");
    }
    const suffix = cursor.slice(suffixLen);

    // Ascending order, checked in O(1) because the encoder always shares the
    // LONGEST common prefix: the suffix's first byte therefore differs from the
    // predecessor's byte at that position, and one comparison settles it. An
    // out-of-order term means the stream has come apart — and the consumer merges
    // payloads on the assumption that both are sorted.
    if (shared === previous.length) {
      if (suffixLen === 0) throw new SearchWireError("term index repeats a term");
    } else {
      const here = suffix[0];
      const there = previous[shared];
      if (here === undefined || there === undefined || here <= there) {
        throw new SearchWireError("term index terms are not in ascending order");
      }
    }

    // Concatenate BYTES, then decode. The shared prefix is counted in bytes and
    // can end INSIDE a multi-byte codepoint — `ação` and `açúcar` share
    // `61 C3 A7 C3`, leaving a suffix that is not valid UTF-8 on its own.
    // Decoding the suffix by itself would substitute U+FFFD and index a term
    // nobody can type. The golden vector pins exactly this case.
    const termBytes = new Uint8Array(shared + suffixLen);
    termBytes.set(previous.subarray(0, shared), 0);
    termBytes.set(suffix, shared);
    previous = termBytes;

    let term: string;
    try {
      term = UTF8.decode(termBytes);
    } catch {
      throw new SearchWireError("term index carries a term that is not valid UTF-8");
    }

    const postingCount = cursor.varint();
    if (postingCount === 0) {
      // An inverted index has no room for a term nothing holds; a zero here means
      // the reader is misaligned rather than that the server sent an odd term.
      throw new SearchWireError("term index carries a term with no documents");
    }
    const holders: string[] = new Array<string>(postingCount);
    let ordinal = 0;
    for (let p = 0; p < postingCount; p += 1) {
      const delta = cursor.varint();
      // Gaps after the first are at least 1, because the ordinals ascend
      // strictly. A zero would read back as a repeated document.
      if (p > 0 && delta === 0) {
        throw new SearchWireError("term index repeats a document in one posting list");
      }
      ordinal += delta;
      const md5 = documents[ordinal];
      if (md5 === undefined) {
        throw new SearchWireError("term index posting names a document it does not carry");
      }
      holders[p] = md5;
    }
    visit(term, holders);
  }

  // The counts are in the header precisely so that this can be checked. A
  // truncated body that merely ran out of terms would otherwise decode as a
  // shorter, entirely well-formed index — fewer results, no error, which §8 names
  // as the failure mode client-side search introduces.
  if (cursor.offset !== payload.length) {
    throw new SearchWireError("term index payload has trailing bytes after its last term");
  }
  return documents;
}

/** Decode the whole payload into memory. Built on {@link readTermIndex}. */
export function decodeTermIndex(payload: Uint8Array): TermIndex {
  const postings = new Map<string, readonly string[]>();
  const documents = readTermIndex(payload, (term, holders) => {
    postings.set(term, holders);
  });
  return { documents, postings };
}
