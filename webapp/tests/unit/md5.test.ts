import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { md5Hex } from "../../src/api/md5";

// RFC 1321 reference vectors; MD5 is half of the stored credential and login challenge.
const RFC1321: Record<string, string> = {
  "": "d41d8cd98f00b204e9800998ecf8427e",
  a: "0cc175b9c0f1b6a831c399e269772661",
  abc: "900150983cd24fb0d6963f7d28e17f72",
  "message digest": "f96b697d7cb7938d525a2f31aaf161d0",
  abcdefghijklmnopqrstuvwxyz: "c3fcd3d76192e4007dfb496cca67e13b",
  ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789:
    "d174ab98d277d9f5a5611c2c9f419d9f",
  "12345678901234567890123456789012345678901234567890123456789012345678901234567890":
    "57edf4a22be3c955ac49da2e2107b67a",
};

describe("md5Hex", () => {
  for (const [input, expected] of Object.entries(RFC1321)) {
    it(`matches the RFC 1321 vector for ${JSON.stringify(input)}`, () => {
      expect(md5Hex(input)).toBe(expected);
    });
  }

  it("returns a lowercase 32-char hex digest", () => {
    expect(md5Hex("supernote")).toMatch(/^[0-9a-f]{32}$/);
  });

  it("hashes UTF-8 (multi-byte) input like Node's crypto", () => {
    for (const s of ["café", "λ-notebook", "x".repeat(1000) + "ünïcode-λ"]) {
      expect(md5Hex(s)).toBe(createHash("md5").update(s, "utf8").digest("hex"));
    }
  });
});
