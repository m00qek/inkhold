import { defineConfig, devices } from "@playwright/test";

// E2E in Chromium against a mocked backend (tests/e2e/helpers/mockApi.ts).
// The port is overridable so several worktrees can run at once.
const PORT = Number(process.env.E2E_PORT ?? 4319);

export default defineConfig({
  testDir: "./tests/e2e",
  // Needs a production build: `npx playwright test -c playwright.pwa.config.ts`.
  testIgnore: "pwa.spec.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "on-first-retry",
  },
  // Chromium by default; E2E_BROWSER=webkit runs Safari's engine (what every
  // iPhone browser uses). WebKit needs Debian/Ubuntu libraries: run it on
  // devlab's inkhold-ci, not on an Arch laptop.
  projects:
    process.env.E2E_BROWSER === "webkit"
      ? [{ name: "webkit", use: { ...devices["Desktop Safari"] } }]
      : [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `npm run dev -- --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    // Off by default: with a fixed port, another worktree's server would be
    // silently reused and the suite would pass against the wrong code.
    // E2E_REUSE=1 opts in.
    reuseExistingServer: process.env.E2E_REUSE === "1",
    timeout: 60_000,
  },
});
