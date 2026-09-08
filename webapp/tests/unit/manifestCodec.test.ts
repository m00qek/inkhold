import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  MANIFEST_FORMAT_VERSION,
  MANIFEST_HEADER_LEN,
  decodeManifest,
  type ManifestRow,
} from "../../src/search/manifestCodec";
import { SearchWireError } from "../../src/search/wire";

// THE golden vector — one artifact, two implementations. The encoder
// (`backend/services/search/index_export.zig`'s `writeManifest`) asserts it
// produces these exact bytes; this file asserts what they decode to, written out
// by hand HERE rather than derived from anything the Zig side says. Neither test
// can be made to pass by editing the other's code, and regenerating the file to
// satisfy the encoder turns this suite red — which is the whole reason the file
// is checked in rather than generated at test time.
//
// Reaching across into `backend/` is deliberate, exactly as `termCodec.test.ts`
// does. A copy under `webapp/` would be a second artifact, and two copies of a
// golden vector is how a format drifts on one side without anything noticing.
const GOLDEN = new Uint8Array(
  readFileSync(
    fileURLToPath(
      new URL("../../../backend/services/search/testdata/manifest_golden.bin", import.meta.url),
    ),
  ),
);

// The five rows, written out by hand from the annotated dump in the encoder.
// Between them they cover: both derivation states, all three tiers, a gap inside
// a tier and an absolute anchor at each tier boundary, a file id that needs two
// varint bytes, an ABSENT index version and a ZERO one.
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
    // Two numbers, two sentences: `notes` is the denominator and `unsearchable`
    // is PERMANENT — a note whose OCR is absent. Neither is the pending count,
    // which is transient and arrives on the live channel.
    expect(decodeManifest(GOLDEN).coverage).toEqual({ notes: 3, unsearchable: 1 });
  });

  it("reconstructs absolute timestamps across tier boundaries, not only within a tier", () => {
    // The delta encoding's one sharp edge. Inside a tier a row carries the GAP
    // to the row before it; at a tier boundary it carries a fresh ABSOLUTE
    // anchor, because the gap would otherwise be negative — and an earlier draft
    // wrote a zero there, which decoded every later row as an offset from an
    // origin the client could not know. That failure throws nothing: it produces
    // a plausible, wrongly-ordered result list.
    const rows = decodeManifest(GOLDEN).rows;
    expect(rows[0]!.updatedAt).toBe(1_700_000_000); // anchor
    expect(rows[1]!.updatedAt).toBe(1_699_990_000); // anchor - 10,000
    expect(rows[2]!.updatedAt).toBe(1_600_000_000); // tier changed: a new anchor
    expect(rows[3]!.updatedAt).toBe(1_599_999_999); // tier changed again
    expect(rows[4]!.updatedAt).toBe(1_500_000_000); // same tier: anchor - 99,999,999

    // And the ordering the server promised survives decoding: tier ascending,
    // and `updatedAt` DESCENDING inside a tier. The client fetches in the order
    // it receives, so this IS the fill order.
    const order = ["note", "note", "marked", "other", "other"];
    expect(rows.map((r) => r.tier)).toEqual(order);
    expect(rows[0]!.updatedAt).toBeGreaterThan(rows[1]!.updatedAt);
    expect(rows[3]!.updatedAt).toBeGreaterThan(rows[4]!.updatedAt);
  });

  it("tells an index version of ZERO from an ABSENT one", () => {
    // The `+1` on the wire exists for exactly this. A blob indexed at version 0
    // is cacheable under `(md5, 0)`; a blob with no index row at all cannot be
    // cached under anything. Merging them hands the store a key it must not use,
    // and the document it belongs to is then never refetched.
    const rows = decodeManifest(GOLDEN).rows;
    expect(rows[2]!.indexVersion).toBeNull();
    expect(rows[4]!.indexVersion).toBe(0);
    expect(rows[4]!.indexVersion).not.toBeNull();
  });

  it("surfaces md5s in lowercase hex, which is the key everything else meets on", () => {
    // The store, the term payload and the live file listing all key on this
    // string. A payload decoded to a different case would read as a document the
    // client has never seen, and be fetched again on every visit.
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
    // Magic first, so an error page, a login redirect or a proxy's courtesy HTML
    // fails on byte 0 instead of being parsed as a row count.
    expect(() => decodeManifest(corrupt(0, 0x3c))).toThrow(SearchWireError);
    expect(() => decodeManifest(new Uint8Array(0))).toThrow(SearchWireError);
    // Including the TERM payload, which is the mix-up a client can actually make:
    // both are opaque bytes from the same origin, and swapping the two URLs must
    // not decode as an empty manifest — which the client would read as "every
    // document you hold has been deleted".
    expect(() => decodeManifest(new Uint8Array([0x54, 0x49, 0x44, 0x58, 1, 0, 0, 0, 0]))).toThrow(
      SearchWireError,
    );
  });

  it("refuses an unknown format version instead of mis-decoding it", () => {
    // A codec change, not an `index_version` change: the documents are the same,
    // only their spelling moved. Decoding it anyway would produce a manifest of
    // plausible-looking rows, and the client would diff its whole index against
    // it.
    expect(() => decodeManifest(corrupt(4, 2))).toThrow(SearchWireError);
  });

  it("refuses a TRUNCATED manifest, because a short one reads as deletions", () => {
    // THE CORRECTNESS PROPERTY, and the reason `rowCount` is in the header at
    // all. Sync is additive and there are no tombstones: a document stops
    // matching in the browser because it is ABSENT from the next COMPLETE
    // manifest. So a body that merely ran out of rows would decode as a shorter,
    // entirely well-formed answer, and every missing row would be read as a
    // deletion of a document that is still there.
    expect(() => decodeManifest(GOLDEN.slice(0, GOLDEN.length - 1))).toThrow(SearchWireError);
    expect(() => decodeManifest(GOLDEN.slice(0, MANIFEST_HEADER_LEN + 20))).toThrow(SearchWireError);
    // A declared row count larger than the body can hold is refused BEFORE
    // anything is allocated — four corrupt bytes must not ask the browser for an
    // array of four billion rows.
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
    // Both fallbacks LOOK conservative and neither is. Defaulting a tier to
    // `other` reorders a fill the server decided; defaulting a derivation to
    // `derived` is a licence to cache an empty term set for ever, which is how a
    // document becomes permanently unsearchable with no error anywhere.
    const firstFlags = MANIFEST_HEADER_LEN + 2 + 16;
    expect(() => decodeManifest(corrupt(firstFlags, 0x04))).toThrow(SearchWireError); // tier 4
    expect(() => decodeManifest(corrupt(firstFlags, 0x31))).toThrow(SearchWireError); // derivation 3
  });

  it("treats `unknown` as a value it can carry, because the client must read it as pending", () => {
    // The server no longer emits it, but it stays in the vocabulary and the
    // reading has to stay the conservative one: refusing to cache costs a
    // request, caching a false empty costs a document. A decoder that rejected it
    // would turn a manifest this server may one day send into a hard failure.
    const firstFlags = MANIFEST_HEADER_LEN + 2 + 16;
    const rows = decodeManifest(corrupt(firstFlags, 0x21)).rows;
    expect(rows[0]!.derivation).toBe("unknown");
  });
});
