import { defineConfig, devices } from "@playwright/test";

// The smoke suite: the built server binary serving the built SPA, nothing
// mocked (tests/smoke/server.ts starts it). `make smoke` runs it; CI runs it
// on the x86_64 binary that ships.
const PORT = Number(process.env.SMOKE_PORT ?? 4339);

export default defineConfig({
  testDir: "./tests/smoke",
  globalSetup: "./tests/smoke/server.ts",
  // One server, one household: the steps build on each other.
  workers: 1,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? "github" : "list",
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: "retain-on-failure", ...devices["Desktop Chrome"] },
});
