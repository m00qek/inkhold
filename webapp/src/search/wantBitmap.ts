// The ENCODER for the `want=` parameter of the search-index stream — "these are
// the manifest positions I am missing" (`golden-search.md` §3.3). The decoder is
// `backend/services/search/want_bitmap.zig`, and the two are pinned to each
// other by ONE checked-in artifact,
// `backend/services/search/testdata/want_golden.txt`, whose meaning is written
// out by hand on BOTH sides. Regenerating it to make one side pass turns the
// other red.
//
// The direction is the mirror image of `manifestCodec.ts`: there the server
// encodes and the browser decodes, here the browser encodes and the server
// decodes. Same discipline either way.
//
// ## Why positions and not md5s
//
// "The documents I do not have" is potentially hundreds of hashes, and 200 md5s
// is a 6.6 KB URL — past what proxies tolerate. The manifest is already ordered
// and already has an ETag, so a position is a legitimate name for a document:
// 1,222 documents become 153 bytes, 204 base64url characters, a URL that fits
// anywhere. The ETag travels beside it (`&m=`) so the server can refuse — 412 —
// rather than read the bitmap against an ordering the client never saw.
//
// ## Layout (mirrors `want_bitmap.zig`; change both or neither)
//
//     bit `n & 7` of byte `n >> 3`    manifest position n — LSB-FIRST, so
//                                     position 0 is the LOW bit of byte 0
//     trailing zero bytes             dropped, see below
//     base64url, UNPADDED             `-` and `_`, never `+` `/` `=`

import { SearchWireError } from "./wire";

/** base64url. The two characters at the end are the whole difference from base64. */
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/**
 * Spell a set of manifest positions as the `want=` parameter.
 *
 * `manifestLength` is the row count of the manifest the positions came from —
 * the same manifest whose ETag goes into `m=`. It is not decoration: it bounds
 * the bitmap, and the server refuses anything longer with a 412 rather than
 * guessing which document a position past the end meant.
 *
 * **Trailing zero bytes are dropped**, which is what keeps the common request
 * small. Tier order puts the household's newest notes FIRST, so a client that
 * refetched after a sync and is missing two of them sets two low bits and sends
 * a couple of characters instead of 204. The server reads any position past the
 * end of a short bitmap as unset.
 *
 * @throws SearchWireError if a position is not an integer in `[0,
 * manifestLength)`. That is a caller bug rather than a corrupt payload, but it
 * is the SAME bug the 412 catches on the wire — the positions and the manifest
 * disagreeing — so it is worth the one error class the callers already handle.
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
    // wrong documents, and nothing downstream would report an error — the server
    // would just stream a set the client did not ask for.
    bytes[position >> 3]! |= 1 << (position & 7);
  }

  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end -= 1;
  return base64url(bytes.subarray(0, end));
}

/**
 * base64url, unpadded, written out rather than reached for.
 *
 * `btoa` wants a binary string, which for a 153-byte array means either a spread
 * (a stack hazard once anyone reuses this) or a loop that builds the string
 * anyway — and then a `replace` pass for `+/` and a strip for `=`. Three
 * conversions to get one, with `+` or `/` surviving a slip and decoding on the
 * server as a document set nobody chose.
 */
function base64url(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out += ALPHABET[n >> 18]! + ALPHABET[(n >> 12) & 63]! + ALPHABET[(n >> 6) & 63]! + ALPHABET[n & 63]!;
  }
  // The last one or two bytes. The leftover low bits of the final character are
  // ZERO, not arbitrary padding: the server refuses a non-canonical group,
  // because two spellings of one bitmap mean the sender is not this encoder.
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
