// The ENCODER for the `want=` parameter of the search-index stream — "these
// are the manifest positions I am missing" (`golden-search.md` §3.3). The
// decoder is `backend/services/search/want_bitmap.zig`; the two are pinned by
// ONE checked-in artifact, `testdata/want_golden.txt`, whose meaning is
// written out by hand on both sides.
//
// Positions, not md5s: 200 md5s is a 6.6 KB URL, 1,222 positions are 204
// base64url characters. A position means nothing except against the exact row
// order the server emitted, which is what the ETag beside it (`m=`) and the
// 412 on a mismatch make structural.
//
// Layout (mirrors `want_bitmap.zig`; change both or neither):
//
//     bit `n & 7` of byte `n >> 3`    manifest position n — LSB-FIRST, so
//                                     position 0 is the LOW bit of byte 0
//     trailing zero bytes             dropped, see below
//     base64url, UNPADDED             `-` and `_`, never `+` `/` `=`

import { SearchWireError } from "./manifestCodec";

/** base64url. The two characters at the end are the whole difference from base64. */
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/**
 * Spell a set of manifest positions as the `want=` parameter.
 *
 * `manifestLength` bounds the bitmap; the server refuses anything longer with
 * a 412. Trailing zero bytes are dropped: tier order puts the newest notes
 * FIRST, so a client missing two of them sends a couple of characters instead
 * of 204, and the server reads any position past the end as unset.
 *
 * @throws SearchWireError if a position is not an integer in `[0,
 * manifestLength)` — a caller bug, but the SAME bug the 412 catches on the
 * wire, so it wears the one error class the callers already handle.
 */
export function encodeWant(positions: Iterable<number>, manifestLength: number): string {
  if (!Number.isInteger(manifestLength) || manifestLength < 0) {
    throw new SearchWireError(`want bitmap needs a real manifest length, got ${manifestLength}`);
  }
  const bytes = new Uint8Array(Math.ceil(manifestLength / 8));
  for (const position of positions) {
    if (!Number.isInteger(position) || position < 0 || position >= manifestLength) {
      throw new SearchWireError(
        `want bitmap position ${position} is outside a manifest of ${manifestLength} documents`,
      );
    }
    // LSB-first. Reversing this produces a perfectly valid bitmap naming the
    // wrong documents, and nothing downstream would report an error.
    bytes[position >> 3]! |= 1 << (position & 7);
  }

  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end -= 1;
  return base64url(bytes.subarray(0, end));
}

/**
 * base64url, unpadded, written out rather than reached for: `btoa` wants a
 * binary string, then a `replace` for `+/` and a strip for `=` — three
 * conversions, with `+` or `/` surviving a slip and decoding on the server as
 * a document set nobody chose.
 */
function base64url(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out += ALPHABET[n >> 18]! + ALPHABET[(n >> 12) & 63]! + ALPHABET[(n >> 6) & 63]! + ALPHABET[n & 63]!;
  }
  // The leftover low bits of the final character are ZERO, not arbitrary
  // padding: the server refuses a non-canonical group.
  const left = bytes.length - i;
  if (left === 1) {
    const n = bytes[i]!;
    out += ALPHABET[n >> 2]! + ALPHABET[(n & 3) << 4]!;
  } else if (left === 2) {
    const n = (bytes[i]! << 8) | bytes[i + 1]!;
    out += ALPHABET[n >> 10]! + ALPHABET[(n >> 4) & 63]! + ALPHABET[(n & 15) << 2]!;
  }
  return out;
}
