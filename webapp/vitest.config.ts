import { defineConfig } from "vitest/config";

// Unit tests in Node (which has `crypto.subtle`); a DOM-shaped file opts into
// happy-dom with a `// @vitest-environment happy-dom` pragma.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/unit/**/*.test.ts"],
  },
});
