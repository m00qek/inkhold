import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  FORMAT_VERSION,
  HEADER_LEN,
  TermCodecError,
  decodeTermIndex,
  readTermIndex,
} from "../../src/search/termCodec";

// THE golden vector — one artifact, two implementations. The encoder
// (`backend/services/search/index_export.zig`) asserts it produces these exact
// bytes; this file asserts what they decode to, written out by hand HERE rather
// than derived from anything the Zig side says. Neither test can be made to pass
// by editing the other's code, and regenerating the file to satisfy the encoder
// turns this suite red — which is the whole reason the file is checked in rather
// than generated at test time.
//
// Reaching across into `backend/` is deliberate. A copy under `webapp/` would be
// a second artifact, and two copies of a golden vector is how the format drifts
// on one side without anything noticing.
const GOLDEN = new Uint8Array(
  readFileSync(
    fileURLToPath(
      new URL("../../../backend/services/search/testdata/term_index_golden.bin", import.meta.url),
    ),
  ),
);

// The four documents, in ordinal order. Ordinal 3 is the md5 of the EMPTY string
// and is the document with no terms — chosen so the intent is legible in a hex
// dump without consulting anything.
const DOC0 = "0123456789abcdef0123456789abcdef";
const DOC1 = "fedcba9876543210fedcba9876543210";
const DOC2 = "00112233445566778899aabbccddeeff";
const DOC3_EMPTY = "d41d8cd98f00b204e9800998ecf8427e";

// The seven terms and their holders, in the ascending BYTE order the format
// demands — which is not alphabetical order: `ágil` sorts last because `á` is
// `C3 A1`, and `agua` sorts before `ação` because `g` (0x67) precedes `ç`'s
// leading `C3`.
const EXPECTED: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["agua", [DOC0, DOC1, DOC2]],
  ["ação", [DOC0, DOC2]],
  ["açúcar", [DOC2]],
  ["nota", [DOC0, DOC1, DOC2]],
  ["notas", [DOC0]],
  ["notação", [DOC1, DOC2]],
  ["ágil", [DOC0]],
];

/** A copy of the golden with one byte replaced — for the refusal tests. */
function corrupt(at: number, value: number): Uint8Array {
  const bytes = GOLDEN.slice();
  bytes[at] = value;
  return bytes;
}

describe("the term index decoder, against the checked-in golden vector", () => {
  it("names every document the payload carries, in ordinal order", () => {
    const index = decodeTermIndex(GOLDEN);
    expect(index.documents).toEqual([DOC0, DOC1, DOC2, DOC3_EMPTY]);
  });

  it("decodes every term in the order the payload stores them", () => {
    const seen: Array<readonly [string, readonly string[]]> = [];
    readTermIndex(GOLDEN, (term, documents) => seen.push([term, documents]));
    expect(seen).toEqual(EXPECTED);
  });

  it("surfaces md5s and never ordinals, because an ordinal means nothing in the next payload", () => {
    const index = decodeTermIndex(GOLDEN);
    for (const holders of index.postings.values()) {
      for (const md5 of holders) expect(md5).toMatch(/^[0-9a-f]{32}$/);
    }
  });

  it("reports a document with an empty term set as present, not as missing", () => {
    // §4's derived-and-EMPTY. It is in the document table and in no posting list.
    // A store that read this as ABSENT would re-request it on every visit forever.
    const index = decodeTermIndex(GOLDEN);
    expect(index.documents).toContain(DOC3_EMPTY);
    for (const holders of index.postings.values()) {
      expect(holders).not.toContain(DOC3_EMPTY);
    }
  });

  it("reconstructs a term that shares its whole predecessor as a prefix", () => {
    // `nota` -> `notas`: shared === predecessor length, suffix "s". The
    // front-coding boundary an off-by-one in either direction lands on.
    const index = decodeTermIndex(GOLDEN);
    expect(index.postings.get("nota")).toEqual([DOC0, DOC1, DOC2]);
    expect(index.postings.get("notas")).toEqual([DOC0]);
  });

  it("reconstructs a shared prefix that ends inside a multi-byte codepoint", () => {
    // `ação` and `açúcar` share `61 C3 A7 C3` — four bytes ending mid-codepoint,
    // so `açúcar`'s stored suffix `BA 63 61 72` is not valid UTF-8 by itself. A
    // decoder that ran the suffix through TextDecoder alone would produce
    // "�car" and index a term nobody can type, with no error anywhere.
    const index = decodeTermIndex(GOLDEN);
    expect([...index.postings.keys()]).toContain("açúcar");
    expect(index.postings.get("açúcar")).toEqual([DOC2]);
    expect(index.postings.get("ação")).toEqual([DOC0, DOC2]);
  });

  it("reads a posting gap wider than one document", () => {
    // `ação` holds ordinals 0 and 2 — stored as deltas 0 and 2, so a decoder that
    // treated every delta as +1 would name the wrong document and still succeed.
    const index = decodeTermIndex(GOLDEN);
    expect(index.postings.get("ação")).toEqual([DOC0, DOC2]);
  });

  it("agrees with the encoder about where the header ends", () => {
    expect(HEADER_LEN).toBe(13);
    expect(GOLDEN.length).toBe(139);
    expect(GOLDEN[4]).toBe(FORMAT_VERSION);
  });
});

describe("the term index decoder refuses rather than mis-decodes", () => {
  it("refuses an unknown format version, and says it is not index_version", () => {
    // §2.3: the codec's spelling and the terms' meaning are different versions
    // moving for different reasons, and the expensive wrong fix for a codec bump
    // is to re-derive a whole library.
    let thrown: unknown;
    try {
      decodeTermIndex(corrupt(4, FORMAT_VERSION + 1));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(TermCodecError);
    expect(String(thrown)).toContain("index_version");
  });

  it("refuses a body that is not a term index at all", () => {
    // A proxy's error page, a login redirect, a half-written cache entry.
    expect(() => decodeTermIndex(corrupt(0, 0x3c))).toThrow(TermCodecError);
    expect(() => decodeTermIndex(new Uint8Array(0))).toThrow(TermCodecError);
  });

  it("refuses a truncated payload instead of returning the terms that did arrive", () => {
    // The loudness that matters most: a short read that decoded cleanly would be
    // fewer results and no error — §8's silent failure, exactly.
    expect(() => decodeTermIndex(GOLDEN.slice(0, GOLDEN.length - 1))).toThrow(TermCodecError);
    expect(() => decodeTermIndex(GOLDEN.slice(0, HEADER_LEN + 40))).toThrow(TermCodecError);
  });

  it("refuses trailing bytes after the last term it was told to expect", () => {
    const padded = new Uint8Array(GOLDEN.length + 1);
    padded.set(GOLDEN, 0);
    expect(() => decodeTermIndex(padded)).toThrow(TermCodecError);
  });

  it("refuses a term count that does not match the terms present", () => {
    // termCount lives at byte 9. Claiming six terms leaves the seventh's bytes
    // trailing; claiming eight runs off the end.
    expect(() => decodeTermIndex(corrupt(9, 6))).toThrow(TermCodecError);
    expect(() => decodeTermIndex(corrupt(9, 8))).toThrow(TermCodecError);
  });

  it("refuses a document table larger than the payload could hold", () => {
    expect(() => decodeTermIndex(corrupt(5, 0xff))).toThrow(TermCodecError);
  });

  it("refuses terms that arrive out of order", () => {
    // `ação`'s stored suffix begins `C3`, one byte past the `a` it shares with
    // `agua`; `41` there would make the term sort BEFORE its predecessor. The
    // consumer merges payloads assuming both are sorted, so an unsorted one has
    // to stop here rather than three steps later.
    const bytes = GOLDEN.slice();
    bytes[HEADER_LEN + 64 + 12] = 0x41; // 'A', below `agua`'s 'g'
    expect(() => decodeTermIndex(bytes)).toThrow(TermCodecError);
  });

  it("refuses a shared-prefix length its predecessor cannot supply", () => {
    // The second term claims 9 shared bytes against a 4-byte predecessor.
    const bytes = GOLDEN.slice();
    bytes[HEADER_LEN + 64 + 10] = 9;
    expect(() => decodeTermIndex(bytes)).toThrow(TermCodecError);
  });

  it("refuses a posting that names a document the payload does not carry", () => {
    // `agua`'s first ordinal, 0, becomes 9 against a four-document table. The
    // ordinal table is the only thing that gives a posting a stable identity.
    const bytes = GOLDEN.slice();
    bytes[HEADER_LEN + 64 + 7] = 9;
    expect(() => decodeTermIndex(bytes)).toThrow(TermCodecError);
  });

  it("refuses a repeated document inside one posting list", () => {
    // `agua`'s second delta, 1, becomes 0 — which would read back as ordinal 0
    // twice and quietly double a document's weight in whatever ranks these.
    const bytes = GOLDEN.slice();
    bytes[HEADER_LEN + 64 + 8] = 0;
    expect(() => decodeTermIndex(bytes)).toThrow(TermCodecError);
  });

  it("refuses a term no document holds", () => {
    // `agua`'s posting count, 3, becomes 0. An inverted index has no room for it,
    // so a zero means the reader is misaligned rather than that the term is odd.
    const bytes = GOLDEN.slice();
    bytes[HEADER_LEN + 64 + 6] = 0;
    expect(() => decodeTermIndex(bytes)).toThrow(TermCodecError);
  });
});
