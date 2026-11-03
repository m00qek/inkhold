import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  encodeManifest,
  decodeWant,
  foldTerms,
  encodeTermsRecord,
  noteTermsDocument,
  type FixtureManifestRow,
} from "../e2e/helpers/searchIndex";
import { decodeManifest } from "../../src/search/manifestCodec";
import { encodeWant } from "../../src/search/wantBitmap";
import { parseTermsJsonl } from "../../src/search/termsStream";
import { noteTranscript } from "../e2e/helpers/docText";

// The e2e `SMAN` encoder (`tests/e2e/helpers/searchIndex.ts`) is a third
// implementation of the format, so it re-encodes the golden rows and must match bytes.
const GOLDEN = new Uint8Array(
  readFileSync(
    fileURLToPath(
      new URL("../../../backend/services/search/testdata/manifest_golden.bin", import.meta.url),
    ),
  ),
);

// Retyped, not imported from `manifestCodec.test.ts`: two copies that must agree.
const GOLDEN_ROWS: readonly FixtureManifestRow[] = [
  { md5: "0123456789abcdef0123456789abcdef", fileId: 7, tier: "note", updatedAt: 1_700_000_000, indexVersion: 15, derivation: "derived" },
  { md5: "fedcba9876543210fedcba9876543210", fileId: 8, tier: "note", updatedAt: 1_699_990_000, indexVersion: 15, derivation: "pending" },
  { md5: "00112233445566778899aabbccddeeff", fileId: 300, tier: "marked", updatedAt: 1_600_000_000, indexVersion: null, derivation: "pending" },
  { md5: "d41d8cd98f00b204e9800998ecf8427e", fileId: 301, tier: "other", updatedAt: 1_599_999_999, indexVersion: 3, derivation: "derived" },
  { md5: "ffffffffffffffffffffffffffffffff", fileId: 302, tier: "other", updatedAt: 1_500_000_000, indexVersion: 0, derivation: "derived" },
];

describe("the e2e manifest encoder, against the checked-in golden vector", () => {
  it("re-encodes the golden manifest byte for byte", () => {
    const bytes = encodeManifest(GOLDEN_ROWS, { notes: 3, unsearchable: 1 });
    expect([...bytes]).toEqual([...GOLDEN]);
  });

  it("round-trips through the production decoder", () => {
    const manifest = decodeManifest(encodeManifest(GOLDEN_ROWS, { notes: 3, unsearchable: 1 }));
    expect(manifest.rows).toEqual(GOLDEN_ROWS);
    expect(manifest.coverage).toEqual({ notes: 3, unsearchable: 1 });
  });

  it("refuses rows that break the delta rule instead of writing a wrong anchor", () => {
    // Within a tier the gap is `previous - current`; a newer row has no representation.
    const ascending: FixtureManifestRow[] = [
      { ...GOLDEN_ROWS[0]!, updatedAt: 1_000 },
      { ...GOLDEN_ROWS[1]!, updatedAt: 2_000 },
    ];
    expect(() => encodeManifest(ascending, { notes: 2, unsearchable: 0 })).toThrow(/descend/);
  });

  it("refuses a tier that is interrupted and resumed", () => {
    const split: FixtureManifestRow[] = [
      GOLDEN_ROWS[0]!,
      GOLDEN_ROWS[2]!,
      { ...GOLDEN_ROWS[1]!, updatedAt: 1_699_000_000 },
    ];
    expect(() => encodeManifest(split, { notes: 2, unsearchable: 0 })).toThrow(/contiguous/);
  });
});

describe("the e2e want-bitmap reader, against the production encoder", () => {
  it("reads back exactly the positions the client asked for", () => {
    // LSB-first; reversed, a valid bitmap names the wrong documents.
    const cases = [[0], [7], [8], [0, 1, 2, 3, 4], [5, 12, 39], []];
    for (const positions of cases) {
      expect(decodeWant(encodeWant(positions, 40), 40)).toEqual(positions);
    }
  });

  it("reads a position past the end of a short bitmap as unset", () => {
    // `encodeWant` drops trailing zero bytes; a short bitmap is not malformed.
    expect(decodeWant(encodeWant([0], 1024), 1024)).toEqual([0]);
  });
});

describe("the e2e terms fixture", () => {
  it("folds a transcript into terms FTS5's own tokenizer would leave alone", () => {
    // Folded terms cannot contain punctuation, so `derive_search.zig` writes them unescaped.
    const folded = foldTerms(noteTranscript("Project Aurora — kickoff", 1));
    expect(folded).toMatch(/^[a-z0-9 ]+$/);
    expect(folded.split(" ")).toContain("aurora");
    expect(folded.split(" ")).toContain("endor");
    expect(folded).toContain("budget");
  });

  it("keeps `n` the address space and not the row count", async () => {
    // Six pages, two unrecognised: four lines under a header saying six.
    const doc = noteTermsDocument("a".repeat(32), "Project Aurora — kickoff", 6);
    expect(doc.pageCount).toBe(6);
    expect(doc.pages.map((p) => p.p)).toEqual([0, 1, 3, 4]);

    const parsed = [];
    for await (const d of parseTermsJsonl((async function* () {
      yield encodeTermsRecord(doc);
    })())) {
      parsed.push(d);
    }
    expect(parsed).toEqual([{ md5: doc.md5, indexVersion: 1, pageCount: 6, pages: doc.pages }]);
  });

  it("puts Endor on the odd pages only, which is what a page-count assertion rests on", () => {
    // A transcript-only term, so a match can only come from the index.
    const doc = noteTermsDocument("a".repeat(32), "Project Aurora — kickoff", 6);
    const withEndor = doc.pages.filter((p) => p.t.split(" ").includes("endor")).map((p) => p.p);
    expect(withEndor).toEqual([1, 3]);
  });
});
