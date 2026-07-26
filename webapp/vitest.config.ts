import { defineConfig } from "vitest/config";

// Layer 1: fast unit tests for the pure, security-critical logic (MD5, the
// login challenge, the API client's envelope/error handling). Node environment
// with real Web Crypto (Node exposes `crypto.subtle` globally) — the DEFAULT is
// no DOM, since almost none of this touches it, and heavy DOM behaviour stays in
// the Playwright layer. The exception is a genuinely DOM-shaped UNIT — the shared
// toolbar's semantics and roving tabindex (`toolbar.test.ts`) — which opts a
// single file into happy-dom with a `// @vitest-environment happy-dom` pragma,
// rather than paying for a DOM in every crypto test.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/unit/**/*.test.ts"],
  },
});
