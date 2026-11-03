// Encoder for the stream's `want=` parameter: the manifest positions the
// client is missing. Decoder: `backend/services/search/want_bitmap.zig`,
// pinned by `testdata/want_golden.txt`. Positions are meaningful only against
// the exact manifest named by `m=`; a mismatch is a 412.
//
// Layout (change both sides or neither):
//
//     bit `n & 7` of byte `n >> 3`    manifest position n — LSB-FIRST, so
//                                     position 0 is the LOW bit of byte 0
//     trailing zero bytes             dropped, see below
//     base64url, UNPADDED             `-` and `_`, never `+` `/` `=`

import { SearchWireError } from "./manifestCodec";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/**
 * Trailing zero bytes are dropped (newest notes come first, so the usual URL
 * is short); the server reads positions past the end as unset.
 * @throws SearchWireError for a position outside `[0, manifestLength)`.
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
    // LSB-first; reversed bits would name the wrong documents without error.
    bytes[position >> 3]! |= 1 << (position & 7);
  }

  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end -= 1;
  return base64url(bytes.subarray(0, end));
}

/** Hand-written: `btoa` plus replaces risks a stray `+` or `/` naming the wrong set. */
function base64url(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out += ALPHABET[n >> 18]! + ALPHABET[(n >> 12) & 63]! + ALPHABET[(n >> 6) & 63]! + ALPHABET[n & 63]!;
  }
  // Leftover low bits must be zero; the server refuses non-canonical groups.
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
