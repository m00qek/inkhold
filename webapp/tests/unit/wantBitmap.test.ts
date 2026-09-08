import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { encodeWant } from "../../src/search/wantBitmap";
import { SearchWireError } from "../../src/search/wire";

// THE golden vector — one artifact, two implementations, exactly as
// `manifestCodec.test.ts` and `manifest_golden.bin` do it, with the directions
// swapped: this side ENCODES and asserts the characters, and
// `backend/services/search/want_bitmap.zig` decodes them and asserts the
// positions, from a list written out by hand there. Neither test can be made to
// pass by editing the other's code.
//
// Reaching across into `backend/` is deliberate. A copy under `webapp/` would be
// a second artifact, and two copies of a golden vector is how a format drifts on
// one side without anything noticing.
const GOLDEN = readFileSync(
  fileURLToPath(
    new URL("../../../backend/services/search/testdata/want_golden.txt", import.meta.url),
  ),
  "utf8",
);

// The golden's positions, written out by hand HERE. Between them they cover: a
// full first byte (so bits 7 and 8 straddle a byte boundary), a gap at position
// 8 that an MSB-first encoder would fill instead, an INTERIOR zero byte at byte
// 3 which must not be mistaken for a trimmable trailing one, and the manifest's
// very last position at 33 — six bits below the end of its byte, so the server's
// "no bits past the manifest" check has something to look at.
const GOLDEN_POSITIONS = [0, 1, 2, 3, 4, 5, 6, 7, 13, 14, 15, 16, 17, 33];
const GOLDEN_MANIFEST_LENGTH = 34;

describe("the want bitmap encoder, against the checked-in golden vector", () => {
  it("spells the golden positions as the golden characters", () => {
    expect(encodeWant(GOLDEN_POSITIONS, GOLDEN_MANIFEST_LENGTH)).toBe(GOLDEN);
  });

  it("is base64URL and not base64", () => {
    // `_-` are sextets 63 and 62 — the two characters the two alphabets spell
    // differently. An encoder built on `btoa` without the `replace` pass writes
    // `/+ADAAI` here, which is valid base64, decodes to different bytes on the
    // server, and names a different set of documents with no error anywhere.
    expect(GOLDEN).toBe("_-ADAAI");
    expect(GOLDEN).not.toMatch(/[+/=]/);
  });

  it("orders bits LSB-first, which position 8 is here to prove", () => {
    // Byte 1 of the golden is 0xe0 — positions 13, 14, 15. Read MSB-first the
    // same byte is positions 8, 9, 10, so the deliberate hole at 8 is what makes
    // the two orderings produce different strings.
    expect(GOLDEN_POSITIONS).not.toContain(8);
    expect(encodeWant([...GOLDEN_POSITIONS, 8], GOLDEN_MANIFEST_LENGTH)).not.toBe(GOLDEN);
  });
});

describe("the sets a client actually sends", () => {
  it("encodes the empty set as the empty string", () => {
    // A client that already holds everything. The server reads it as an empty
    // set rather than a refusal, so this needs no special case at either end.
    expect(encodeWant([], 1222)).toBe("");
    expect(encodeWant([], 0)).toBe("");
  });

  it("encodes a single bit, at either end of its byte", () => {
    expect(encodeWant([0], 64)).toBe("AQ"); // 0x01
    expect(encodeWant([7], 64)).toBe("gA"); // 0x80
    expect(encodeWant([8], 64)).toBe("AAE"); // 0x00 0x01 — the byte boundary
  });

  it("drops trailing zero bytes, which is what keeps the usual request small", () => {
    // The common case after a coalesced refetch: tier order puts the newest
    // notes first, so "the two I am missing" is two characters against a library
    // of 1,222 — not the 204 a full-width bitmap would cost.
    expect(encodeWant([0, 2], 1222)).toBe("BQ"); // 0x05, and nothing after it
    expect(encodeWant([0, 2], 1222).length).toBe(2);
    // Interior zeros survive; only the tail is trimmed.
    expect(encodeWant([0, 20], 64)).toBe("AQAQ"); // 0x01 0x00 0x10
  });

  it("encodes a sparse set spread across several groups", () => {
    // Bytes 0, 3, 5 and 9 of a ten-byte bitmap: 0x04 00 00 02 00 03 00 00 00 80.
    expect(encodeWant([2, 25, 40, 41, 79], 80)).toBe("BAAAAgADAAAAgA");
  });

  it("encodes every bit set without spilling past the manifest's last position", () => {
    // 34 documents end two bits into byte 4, so a full set's last byte is 0x03
    // and not 0xff. Setting the other six would be a 412 on the server.
    expect(encodeWant(range(34), 34)).toBe("_____wM");
  });

  it("is 153 bytes and 204 characters at 1,222 documents, which is §3.3's whole claim", () => {
    // The measurement the design rests on. 200 md5s in a URL is 6.6 KB; the same
    // question as a bitmap is 204 characters — and 153 divides by 3, so it needs
    // no padding either and there is nothing to strip.
    const want = encodeWant(range(1222), 1222);
    expect(want.length).toBe(204);
    expect(Math.ceil(1222 / 8)).toBe(153);
    expect(want).not.toMatch(/[+/=]/);
    // 152 full bytes then 0x3f: positions 1216..1221 and the two bits above them
    // left clear, which is exactly what the server's overhang check demands.
    expect(want).toBe("_".repeat(202) + "8_");
  });
});

describe("what the encoder refuses", () => {
  // These are caller bugs rather than corrupt payloads, but they are the SAME
  // disagreement the server answers with a 412 — positions that do not belong to
  // the manifest being addressed — so they are caught here, before a request
  // goes out that cannot be served.
  it("refuses a position past the manifest's last document", () => {
    expect(() => encodeWant([34], 34)).toThrow(SearchWireError);
    expect(() => encodeWant([0, 1, 1222], 1222)).toThrow(SearchWireError);
    expect(() => encodeWant([0], 0)).toThrow(SearchWireError);
  });

  it("refuses a position that is not a whole non-negative number", () => {
    expect(() => encodeWant([-1], 34)).toThrow(SearchWireError);
    expect(() => encodeWant([1.5], 34)).toThrow(SearchWireError);
    expect(() => encodeWant([Number.NaN], 34)).toThrow(SearchWireError);
  });

  it("refuses a manifest length that is not a count", () => {
    expect(() => encodeWant([], -1)).toThrow(SearchWireError);
    expect(() => encodeWant([], 1.5)).toThrow(SearchWireError);
  });

  it("tolerates a repeated position, because a set is a set", () => {
    // `|=` is idempotent, and a caller deduplicating first would be ceremony.
    expect(encodeWant([0, 0, 2, 2], 64)).toBe("BQ");
  });
});

function range(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i);
}
