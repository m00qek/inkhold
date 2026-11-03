import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  MANIFEST_FORMAT_VERSION,
  MANIFEST_HEADER_LEN,
  SearchWireError,
  decodeManifest,
  type ManifestRow,
} from "../../src/search/manifestCodec";

// The golden vector, read from `backend/` on purpose: the Zig encoder asserts these
// bytes, this asserts hand-written decodings. One artifact, never regenerated.
const GOLDEN = new Uint8Array(
  readFileSync(
    fileURLToPath(
      new URL("../../../backend/services/search/testdata/manifest_golden.bin", import.meta.url),
    ),
  ),
);

// Written out by hand from the encoder's annotated dump.
const EXPECTED: readonly ManifestRow[] = [
  {
    md5: "0123456789abcdef0123456789abcdef",
    fileId: 7,
    tier: "note",
    updatedAt: 1_700_000_000,
    indexVersion: 15,
    derivation: "derived",
  },
  {
    md5: "fedcba9876543210fedcba9876543210",
    fileId: 8,
    tier: "note",
    updatedAt: 1_699_990_000,
    indexVersion: 15,
    derivation: "pending",
  },
  {
    md5: "00112233445566778899aabbccddeeff",
    fileId: 300,
    tier: "marked",
    updatedAt: 1_600_000_000,
    indexVersion: null,
    derivation: "pending",
  },
  {
    md5: "d41d8cd98f00b204e9800998ecf8427e",
    fileId: 301,
    tier: "other",
    updatedAt: 1_599_999_999,
    indexVersion: 3,
    derivation: "derived",
  },
  {
    md5: "ffffffffffffffffffffffffffffffff",
    fileId: 302,
    tier: "other",
    updatedAt: 1_500_000_000,
    indexVersion: 0,
    derivation: "derived",
  },
];

/** A copy of the golden with one byte replaced — for the refusal tests. */
function corrupt(at: number, value: number): Uint8Array {
  const bytes = GOLDEN.slice();
  bytes[at] = value;
  return bytes;
}

describe("the manifest decoder, against the checked-in golden vector", () => {
  it("decodes every row the encoder wrote", () => {
    const manifest = decodeManifest(GOLDEN);
    expect(manifest.rows).toEqual(EXPECTED);
  });

  it("carries the coverage counts the zero-hit sentence renders", () => {
    expect(decodeManifest(GOLDEN).coverage).toEqual({ notes: 3, unsearchable: 1 });
  });

  it("reconstructs absolute timestamps across tier boundaries, not only within a tier", () => {
    // Within a tier rows carry the gap; at a tier boundary, a fresh absolute anchor.
    const rows = decodeManifest(GOLDEN).rows;
    expect(rows[0]!.updatedAt).toBe(1_700_000_000);
    expect(rows[1]!.updatedAt).toBe(1_699_990_000);
    expect(rows[2]!.updatedAt).toBe(1_600_000_000);
    expect(rows[3]!.updatedAt).toBe(1_599_999_999);
    expect(rows[4]!.updatedAt).toBe(1_500_000_000);

    const order = ["note", "note", "marked", "other", "other"];
    expect(rows.map((r) => r.tier)).toEqual(order);
    expect(rows[0]!.updatedAt).toBeGreaterThan(rows[1]!.updatedAt);
    expect(rows[3]!.updatedAt).toBeGreaterThan(rows[4]!.updatedAt);
  });

  it("tells an index version of ZERO from an ABSENT one", () => {
    // The wire `+1` separates version 0 (cacheable) from no index row (not cacheable).
    const rows = decodeManifest(GOLDEN).rows;
    expect(rows[2]!.indexVersion).toBeNull();
    expect(rows[4]!.indexVersion).toBe(0);
    expect(rows[4]!.indexVersion).not.toBeNull();
  });

  it("surfaces md5s in lowercase hex, which is the key everything else meets on", () => {
    for (const row of decodeManifest(GOLDEN).rows) {
      expect(row.md5).toMatch(/^[0-9a-f]{32}$/);
    }
  });

  it("puts the version byte where the encoder does", () => {
    expect(GOLDEN[4]).toBe(MANIFEST_FORMAT_VERSION);
    expect(MANIFEST_HEADER_LEN).toBe(9);
    expect(GOLDEN.length).toBe(130);
  });

  it("refuses a payload that is not a manifest, rather than reading one out of it", () => {
    // Magic first, so an HTML error page fails on byte 0.
    expect(() => decodeManifest(corrupt(0, 0x3c))).toThrow(SearchWireError);
    expect(() => decodeManifest(new Uint8Array(0))).toThrow(SearchWireError);
    // Swapping manifest and terms URLs must not decode as an empty manifest.
    expect(() => decodeManifest(new Uint8Array([0x54, 0x49, 0x44, 0x58, 1, 0, 0, 0, 0]))).toThrow(
      SearchWireError,
    );
  });

  it("refuses an unknown format version instead of mis-decoding it", () => {
    expect(() => decodeManifest(corrupt(4, 2))).toThrow(SearchWireError);
  });

  it("refuses a TRUNCATED manifest, because a short one reads as deletions", () => {
    // No tombstones: absence from a complete manifest is deletion, so truncation must throw.
    expect(() => decodeManifest(GOLDEN.slice(0, GOLDEN.length - 1))).toThrow(SearchWireError);
    expect(() => decodeManifest(GOLDEN.slice(0, MANIFEST_HEADER_LEN + 20))).toThrow(SearchWireError);
    // Refused before allocating: corrupt bytes must not request four billion rows.
    const inflated = GOLDEN.slice();
    inflated[5] = 0xff;
    inflated[6] = 0xff;
    expect(() => decodeManifest(inflated)).toThrow(SearchWireError);
  });

  it("refuses trailing bytes after the last row", () => {
    const padded = new Uint8Array(GOLDEN.length + 1);
    padded.set(GOLDEN);
    expect(() => decodeManifest(padded)).toThrow(SearchWireError);
  });

  it("refuses an unknown tier or derivation rather than coercing it to a safe-looking default", () => {
    // Neither fallback is conservative: refuse unknown tiers and derivations.
    const firstFlags = MANIFEST_HEADER_LEN + 2 + 16;
    expect(() => decodeManifest(corrupt(firstFlags, 0x04))).toThrow(SearchWireError);
    expect(() => decodeManifest(corrupt(firstFlags, 0x31))).toThrow(SearchWireError);
  });

  it("treats `unknown` as a value it can carry, because the client must read it as pending", () => {
    // No longer emitted, but must still decode as not-cacheable.
    const firstFlags = MANIFEST_HEADER_LEN + 2 + 16;
    const rows = decodeManifest(corrupt(firstFlags, 0x21)).rows;
    expect(rows[0]!.derivation).toBe("unknown");
  });
});
