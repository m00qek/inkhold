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

// PINNING THE E2E FIXTURE'S ENCODER, because an encoder that is merely plausible
// is worse than none.
//
// `tests/e2e/helpers/searchIndex.ts` writes `SMAN` bytes so an e2e run can
// exercise the real sync — decode, diff, want bitmap, stream, IndexedDB, wasm
// FTS5 — instead of stubbing the answer. That makes it a THIRD implementation of
// a format that already has two (`index_export.zig` writes it, `manifestCodec.ts`
// reads it), and the format's one dangerous mistake throws nothing: get the
// per-tier delta backwards and every timestamp after the first tier change is
// silently wrong, which surfaces as a plausible, wrongly-ordered result list.
//
// So it is pinned to the SAME checked-in artifact both other sides are pinned
// to. `manifestCodec.test.ts` decodes that file and asserts the five rows by
// hand; this re-ENCODES those rows and asserts the bytes come back identical. A
// fixture encoder that drifts from the wire cannot make an e2e sweep green over
// a format neither the server nor the client speaks.
const GOLDEN = new Uint8Array(
  readFileSync(
    fileURLToPath(
      new URL("../../../backend/services/search/testdata/manifest_golden.bin", import.meta.url),
    ),
  ),
);

// The same five rows `manifestCodec.test.ts` writes out by hand, deliberately
// retyped rather than imported: two copies that must agree is the whole point of
// a golden vector, and importing one into the other would collapse them into one
// opinion. Between them they cover both derivation states, all three tiers, a
// gap inside a tier and an absolute anchor at each tier boundary, a file id that
// needs two varint bytes, an ABSENT index version and a ZERO one.
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
    // Belt and braces, and it is the assertion that survives a golden
    // regeneration: whatever bytes this writes, `decodeManifest` must read the
    // rows back unchanged.
    const manifest = decodeManifest(encodeManifest(GOLDEN_ROWS, { notes: 3, unsearchable: 1 }));
    expect(manifest.rows).toEqual(GOLDEN_ROWS);
    expect(manifest.coverage).toEqual({ notes: 3, unsearchable: 1 });
  });

  it("refuses rows that break the delta rule instead of writing a wrong anchor", () => {
    // The failure the golden vector exists to catch, asked of the encoder
    // directly: inside one tier the gap is `previous - current`, so a row that
    // is NEWER than the one before it has no representation. Writing the
    // negative as a varint would produce a manifest that decodes cleanly into
    // timestamps nobody chose.
    const ascending: FixtureManifestRow[] = [
      { ...GOLDEN_ROWS[0]!, updatedAt: 1_000 },
      { ...GOLDEN_ROWS[1]!, updatedAt: 2_000 },
    ];
    expect(() => encodeManifest(ascending, { notes: 2, unsearchable: 0 })).toThrow(/descend/);
  });

  it("refuses a tier that is interrupted and resumed", () => {
    // Tier order IS fill order (`manifestCodec.ts`), and the anchor rule only
    // works because a tier is contiguous: a second run of `note` rows would take
    // a fresh absolute anchor and decode fine, while meaning something the
    // server never sends.
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
    // The mock serves what the bitmap names, so this is the server half of
    // `wantBitmap.ts`'s contract. LSB-first is the bit that fails silently:
    // reverse it and you get a valid bitmap naming the wrong documents.
    const cases = [[0], [7], [8], [0, 1, 2, 3, 4], [5, 12, 39], []];
    for (const positions of cases) {
      expect(decodeWant(encodeWant(positions, 40), 40)).toEqual(positions);
    }
  });

  it("reads a position past the end of a short bitmap as unset", () => {
    // `encodeWant` drops trailing zero bytes, which is what keeps the common
    // request a couple of characters. A reader that treated a short bitmap as
    // malformed would 412 every ordinary sync.
    expect(decodeWant(encodeWant([0], 1024), 1024)).toEqual([0]);
  });
});

describe("the e2e terms fixture", () => {
  it("folds a transcript into terms FTS5's own tokenizer would leave alone", () => {
    // `unicode61` treats every non-alphanumeric as a separator, so a folded term
    // cannot contain one — which is what lets `derive_search.zig` write bare
    // strings into JSON without escaping. A fixture that left punctuation in
    // would still WORK (the engine re-tokenizes) and would be lying about the
    // wire.
    const folded = foldTerms(noteTranscript("Project Aurora — kickoff", 1));
    expect(folded).toMatch(/^[a-z0-9 ]+$/);
    expect(folded.split(" ")).toContain("aurora");
    expect(folded.split(" ")).toContain("endor");
    expect(folded).toContain("budget");
  });

  it("keeps `n` the address space and not the row count", async () => {
    // Six pages, indices 2 and 5 unrecognised, so four lines under a header that
    // says six. `termsStream.ts` refuses to default `n` to `pages.length` for
    // exactly this reason, and a fixture that conflated them would make that
    // refusal untestable.
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
    // The one term that lives ONLY in a transcript — no file name carries it —
    // so a row that matches it can only have come from the index. Odd pages of
    // six, minus the unrecognised ones: 1, 3, 5 → 1 and 3 have records, 5 does
    // not (`recognisedPages` drops every third).
    const doc = noteTermsDocument("a".repeat(32), "Project Aurora — kickoff", 6);
    const withEndor = doc.pages.filter((p) => p.t.split(" ").includes("endor")).map((p) => p.p);
    expect(withEndor).toEqual([1, 3]);
  });
});
