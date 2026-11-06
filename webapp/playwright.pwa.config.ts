import { defineConfig, devices } from "@playwright/test";

// The installable app (manifest, service worker) exists only in a production
// build, so this suite builds one and serves it with `vite preview`. The
// backend is mocked per test at the context level: a service worker's own
// fetches are seen by `context.route`, not `page.route`. Chromium only.
const PORT = Number(process.env.E2E_PWA_PORT ?? 4329);

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "pwa.spec.ts",
  reporter: process.env.CI ? "github" : "list",
  use: { baseURL: `http://localhost:${PORT}`, ...devices["Desktop Chrome"] },
  webServer: {
    command: `npx vite build --outDir dist-e2e --emptyOutDir && npx vite preview --outDir dist-e2e --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
