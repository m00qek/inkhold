import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { sha256Hex } from "../../src/api/sha256";

// SHA-256 is the outer half of the login challenge
// (`sha256_hex(md5_hex(pw) + randomCode)`). A wrong digest breaks login for
// every device with no obvious symptom, so it is pinned against the published
// FIPS 180-2 / NIST vectors as well as against Node's crypto.
const NIST: Record<string, string> = {
  "": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  abc: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  // 56 bytes — the two-block vector from the FIPS 180-2 appendix.
  "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq":
    "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
  // 112 bytes — the FIPS 180-2 multi-block vector.
  "abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu":
    "cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1",
};

describe("sha256Hex", () => {
  for (const [input, expected] of Object.entries(NIST)) {
    const label = input.length > 24 ? `${JSON.stringify(input.slice(0, 24))}… (${input.length} bytes)` : JSON.stringify(input);
    it(`matches the NIST vector for ${label}`, () => {
      expect(sha256Hex(input)).toBe(expected);
    });
  }

  // A million 'a's — the third FIPS 180-2 vector. Exercises the block loop hard.
  it("matches the NIST vector for one million 'a' characters", () => {
    expect(sha256Hex("a".repeat(1_000_000))).toBe(
      "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0",
    );
  });

  it("returns a lowercase 64-char hex digest", () => {
    expect(sha256Hex("supernote")).toMatch(/^[0-9a-f]{64}$/);
  });

  // The padding boundary is the single most common place a hand-written SHA-256
  // is wrong: at 56 bytes the 0x80 marker plus the 8-byte length no longer fit
  // in the block, so an extra block must be emitted. 55 is the last length that
  // fits; 64 is an exact block; 65 starts a fresh one.
  describe("padding boundaries", () => {
    for (const len of [0, 1, 54, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129, 1000]) {
      it(`is correct for a ${len}-byte message`, () => {
        const s = "x".repeat(len);
        expect(sha256Hex(s)).toBe(createHash("sha256").update(s, "utf8").digest("hex"));
      });
    }
  });

  // The password may contain any Unicode; we must hash its UTF-8 bytes.
  it("hashes UTF-8 (multi-byte) input like Node's crypto", () => {
    for (const s of ["café", "λ-notebook", "日本語のパスワード", "🔑🔒", "ünïcode-λ".repeat(37)]) {
      expect(sha256Hex(s)).toBe(createHash("sha256").update(s, "utf8").digest("hex"));
    }
  });

  // Every byte-length from 0 to 200 against Node, so no offset in the block
  // loop or the padding arithmetic can hide.
  it("agrees with Node's crypto for every length from 0 to 200", () => {
    let s = "";
    for (let i = 0; i <= 200; i++) {
      expect(sha256Hex(s)).toBe(createHash("sha256").update(s, "utf8").digest("hex"));
      s += String.fromCharCode(0x41 + (i % 26));
    }
  });
});
