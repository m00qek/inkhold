import { describe, it, expect, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { md5Hex, sha256Hex, challengeHash } from "../../src/api/crypto";

describe("sha256Hex", () => {
  it("matches Node's crypto for UTF-8 inputs", async () => {
    for (const s of ["", "abc", "café-λ", "The quick brown fox jumps over the lazy dog"]) {
      expect(await sha256Hex(s)).toBe(createHash("sha256").update(s, "utf8").digest("hex"));
    }
  });

  it("matches Node's crypto across the padding boundary (55..65 bytes)", async () => {
    for (let n = 55; n <= 65; n++) {
      const s = "x".repeat(n);
      expect(await sha256Hex(s)).toBe(createHash("sha256").update(s, "utf8").digest("hex"));
    }
  });

  it("returns a lowercase 64-char hex digest", async () => {
    expect(await sha256Hex("supernote")).toMatch(/^[0-9a-f]{64}$/);
  });
});

// `sha256_hex(md5_hex(pw) + randomCode)`, checked against Node's crypto.
describe("challengeHash", () => {
  it("equals sha256_hex(md5_hex(pw) + randomCode)", async () => {
    const pw = "hunter2";
    const rc = "0011aabb";

    const md5Node = createHash("md5").update(pw, "utf8").digest("hex");
    const expected = createHash("sha256").update(md5Node + rc, "utf8").digest("hex");

    expect(md5Hex(pw)).toBe(md5Node);
    expect(await challengeHash(pw, rc)).toBe(expected);
  });

  it("is deterministic for a fixed (password, randomCode)", async () => {
    const a = await challengeHash("pw", "abcd1234");
    const b = await challengeHash("pw", "abcd1234");
    expect(a).toBe(b);
  });

  it("changes when the randomCode changes (challenge is single-use)", async () => {
    const a = await challengeHash("pw", "code-one");
    const b = await challengeHash("pw", "code-two");
    expect(a).not.toBe(b);
  });
});

// Regression: the phone loads over plain HTTP, where `crypto.subtle` (or `crypto`)
// is missing, so nothing on the credential path may depend on it.
describe("challengeHash without Web Crypto (insecure context, e.g. a phone on http://<lan-ip>)", () => {
  const realCrypto = globalThis.crypto;
  afterEach(() => {
    Object.defineProperty(globalThis, "crypto", {
      value: realCrypto,
      configurable: true,
      writable: true,
    });
  });

  function removeWebCrypto(): void {
    Object.defineProperty(globalThis, "crypto", {
      value: undefined,
      configurable: true,
      writable: true,
    });
  }

  it("still computes the right challenge with `crypto` absent", async () => {
    const pw = "correct horse";
    const rc = "0011aabb2233ccdd";
    const expected = createHash("sha256")
      .update(createHash("md5").update(pw, "utf8").digest("hex") + rc, "utf8")
      .digest("hex");

    removeWebCrypto();
    expect(globalThis.crypto).toBeUndefined();
    expect(await challengeHash(pw, rc)).toBe(expected);
  });

  it("still hashes non-ASCII passwords with `crypto` absent", async () => {
    const pw = "sênha-λ-日本語";
    const rc = "deadbeef";
    const expected = createHash("sha256")
      .update(createHash("md5").update(pw, "utf8").digest("hex") + rc, "utf8")
      .digest("hex");

    removeWebCrypto();
    expect(await challengeHash(pw, rc)).toBe(expected);
  });

  it("computes an identical challenge with and without `crypto` present", async () => {
    const secure = await challengeHash("hunter2", "abcd1234");
    removeWebCrypto();
    const insecure = await challengeHash("hunter2", "abcd1234");
    expect(insecure).toBe(secure);
  });
});
