import { defineConfig, devices } from "@playwright/test";

// Layer 2: real-Chromium E2E against the built app with a fully mocked backend
// (see tests/e2e/helpers/mockApi.ts). `webServer` boots the Vite dev server on a
// fixed port; `reuseExistingServer` lets you keep one running while iterating.
// OVERRIDABLE, because the port is how a run picks its app. Two worktrees of
// this repo running e2e at once is normal now, and both would want 4319.
const PORT = Number(process.env.E2E_PORT ?? 4319);

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `npm run dev -- --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    // OFF unless explicitly asked for. It used to be `!process.env.CI`, which
    // reads as a convenience and behaves as a correctness hazard: with a fixed
    // port, a server left running by ANOTHER worktree is silently reused, and
    // the whole suite then runs against that worktree's app. That is not a
    // failure — it is a full green run against code the branch does not contain,
    // which is worse than a red one. It happened: a run reported 166/166 passed
    // against a checkout missing every change under test, and only a screenshot
    // caught it.
    //
    // Set E2E_REUSE=1 to opt back in while iterating on a single worktree.
    reuseExistingServer: process.env.E2E_REUSE === "1",
    timeout: 60_000,
  },
});
