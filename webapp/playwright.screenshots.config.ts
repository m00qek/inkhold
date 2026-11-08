import { defineConfig, devices } from "@playwright/test";
import base from "./playwright.config";

// The docs' screenshots (docs/static/screenshots/), taken from the app itself on
// its fake data: `npm run screenshots`. Never by hand: they never go stale and
// never show anyone's notes (docs/content/contributor/documentation-rules.md).
export default defineConfig({
  ...base,
  testDir: "./tests/screenshots",
  testIgnore: [],
  retries: 0,
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
