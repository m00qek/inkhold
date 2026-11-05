import { defineConfig } from "vitest/config";

// Measurements, not tests: run on demand with `npm run bench:search`.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/bench/**/*.bench.test.ts"],
    testTimeout: 600_000,
  },
});
