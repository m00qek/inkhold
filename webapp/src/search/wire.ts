// The primitives BOTH search-index decoders are built on — the cursor, the
// varint, the bounds checks and the one error class. `termCodec.ts` reads the
// term payload (`TIDX`) and `manifestCodec.ts` reads the manifest (`SMAN`); the
// two formats are different but they are spelt the same way, by the same encoder
// (`backend/services/search/index_export.zig`), and their readers must fail the
// same way too.
//
// Extracted when the manifest decoder landed, rather than copied. A second
// hand-written varint reader is not a style problem: it is a second set of
// bounds checks to get right, on payloads whose corruption modes are silent by
// construction — a truncated stream that merely ran out of records decodes as a
// shorter, perfectly valid answer, and for the manifest a shorter answer is read
// by the client as DELETIONS.

/**
 * A payload this build refuses to read. Distinct from a generic `Error` so a
 * caller can tell "the server speaks a format I do not" — which wants a reload,
 * not a retry — from a transport failure, which wants a retry.
 *
 * ONE class across both payloads, deliberately. A caller's reaction is the same
 * whichever of them came apart, and two classes would invite a `catch` that
 * handled one and let the other escape as an unhandled rejection.
 */
export class SearchWireError extends Error {
  override readonly name = "SearchWireError";
}

/** A varint wider than this cannot be a length, a count, an id or an ordinal. */
const MAX_VARINT_BYTES = 5;

// `fatal` on purpose. Terms reach the browser having been folded by SQLite's
// tokenizer, so they are always valid UTF-8; a replacement character would mean
// the stream has come apart, and an index quietly full of U+FFFD matches nothing
// a user can type and reports no error.
export const UTF8 = new TextDecoder("utf-8", { fatal: true });

/** A bounds-checked forward reader over one payload. */
export class Cursor {
  offset = 0;
  constructor(readonly bytes: Uint8Array) {}

  byte(): number {
    const b = this.bytes[this.offset];
    if (b === undefined) throw new SearchWireError("search index payload ends mid-record");
    this.offset += 1;
    return b;
  }

  slice(length: number): Uint8Array {
    const end = this.offset + length;
    if (end > this.bytes.length) {
      throw new SearchWireError("search index payload ends mid-record");
    }
    const out = this.bytes.subarray(this.offset, end);
    this.offset = end;
    return out;
  }

  /** Unsigned LEB128, bounded so a corrupt stream cannot spin. */
  varint(): number {
    let value = 0;
    let shift = 0;
    for (let i = 0; i < MAX_VARINT_BYTES; i += 1) {
      const b = this.byte();
      value += (b & 0x7f) * 2 ** shift;
      if ((b & 0x80) === 0) {
        if (value > 0xffffffff) {
          throw new SearchWireError("search index payload carries an implausible length");
        }
        return value;
      }
      shift += 7;
    }
    throw new SearchWireError("search index payload carries an over-long varint");
  }

  /** u32 little-endian, the fixed-width counts both headers carry. */
  u32(): number {
    const view = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);
    const value = view.getUint32(this.offset, true);
    this.offset += 4;
    return value;
  }

  /** 16 raw bytes as 32 lowercase hex characters — the md5 both payloads key on. */
  md5(): string {
    let hex = "";
    for (const byte of this.slice(16)) hex += byte.toString(16).padStart(2, "0");
    return hex;
  }
}

/**
 * Check the magic and the version byte, or throw.
 *
 * The version is named in full in the message because the obvious fix — "bump
 * `index_version` and re-derive" — is the expensive wrong one. This is the WIRE
 * SPELLING, not `index_version`: the terms have not changed, only how they are
 * written down, and conflating the two is how a client throws away a household's
 * whole index to pick up a codec change.
 */
export function readMagic(cursor: Cursor, magic: readonly number[], version: number): void {
  if (cursor.bytes.length < magic.length + 1) {
    throw new SearchWireError("search index payload is shorter than its header");
  }
  for (const expected of magic) {
    if (cursor.byte() !== expected) {
      throw new SearchWireError("not a search index payload (bad magic)");
    }
  }
  const got = cursor.byte();
  if (got !== version) {
    throw new SearchWireError(
      `unsupported search index format version ${got}; this build decodes ${version}. ` +
        "This is the wire spelling, not index_version: the terms have not changed.",
    );
  }
}
