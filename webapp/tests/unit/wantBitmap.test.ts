import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { encodeWant } from "../../src/search/wantBitmap";
import { SearchWireError } from "../../src/search/manifestCodec";

// The golden vector, read from `backend/` on purpose: this side encodes,
// `want_bitmap.zig` decodes. Neither test can pass by editing the other.
const GOLDEN = readFileSync(
  fileURLToPath(
    new URL("../../../backend/services/search/testdata/want_golden.txt", import.meta.url),
  ),
  "utf8",
);

// Positions cover a byte boundary, an MSB-trap gap at 8, an interior zero byte and
// the manifest's last position at 33.
const GOLDEN_POSITIONS = [0, 1, 2, 3, 4, 5, 6, 7, 13, 14, 15, 16, 17, 33];
const GOLDEN_MANIFEST_LENGTH = 34;

describe("the want bitmap encoder, against the checked-in golden vector", () => {
  it("spells the golden positions as the golden characters", () => {
    expect(encodeWant(GOLDEN_POSITIONS, GOLDEN_MANIFEST_LENGTH)).toBe(GOLDEN);
  });

  it("is base64URL and not base64", () => {
    // `_-` are sextets 63 and 62; plain `btoa` would write valid but wrong `/+`.
    expect(GOLDEN).toBe("_-ADAAI");
    expect(GOLDEN).not.toMatch(/[+/=]/);
  });

  it("orders bits LSB-first, which position 8 is here to prove", () => {
    // Byte 1 is 0xe0 = positions 13, 14, 15; MSB-first would read 8, 9, 10.
    expect(GOLDEN_POSITIONS).not.toContain(8);
    expect(encodeWant([...GOLDEN_POSITIONS, 8], GOLDEN_MANIFEST_LENGTH)).not.toBe(GOLDEN);
  });
});

describe("the sets a client actually sends", () => {
  it("encodes the empty set as the empty string", () => {
    expect(encodeWant([], 1222)).toBe("");
    expect(encodeWant([], 0)).toBe("");
  });

  it("encodes a single bit, at either end of its byte", () => {
    expect(encodeWant([0], 64)).toBe("AQ"); // 0x01
    expect(encodeWant([7], 64)).toBe("gA"); // 0x80
    expect(encodeWant([8], 64)).toBe("AAE"); // 0x00 0x01 — the byte boundary
  });

  it("drops trailing zero bytes, which is what keeps the usual request small", () => {
    expect(encodeWant([0, 2], 1222)).toBe("BQ"); // 0x05, and nothing after it
    expect(encodeWant([0, 2], 1222).length).toBe(2);
    expect(encodeWant([0, 20], 64)).toBe("AQAQ"); // 0x01 0x00 0x10
  });

  it("encodes a sparse set spread across several groups", () => {
    // Bytes 0, 3, 5 and 9 of a ten-byte bitmap: 0x04 00 00 02 00 03 00 00 00 80.
    expect(encodeWant([2, 25, 40, 41, 79], 80)).toBe("BAAAAgADAAAAgA");
  });

  it("encodes every bit set without spilling past the manifest's last position", () => {
    // 34 documents end two bits into byte 4; setting the other six is a server 412.
    expect(encodeWant(range(34), 34)).toBe("_____wM");
  });

  it("is 153 bytes and 204 characters at 1,222 documents, which is §3.3's whole claim", () => {
    // 200 md5s in a URL is 6.6 KB; as a bitmap, 204 characters.
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
  // Caller bugs, but the same disagreement the server 412s, so caught here.
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
    expect(encodeWant([0, 0, 2, 2], 64)).toBe("BQ");
  });
});

function range(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i);
}
