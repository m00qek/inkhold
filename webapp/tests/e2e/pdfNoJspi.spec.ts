import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { FIXTURE, openPageOne } from "./helpers/pdfRange";

// Exercises the whole-file fallback for browsers without JSPI. Chromium's flags
// cannot disable JSPI and detection runs in the worker, so the worker module is
// intercepted and patched on its way to the browser.
test.beforeEach(async ({ page }) => {
  await page.route(
    (url) => url.pathname.includes("pdfWorker"),
    async (route) => {
      const res = await route.fetch();
      const body = await res.text();
      await route.fulfill({
        response: res,
        body: `WebAssembly.Suspending = undefined; WebAssembly.promising = undefined;\n${body}`,
      });
    },
  );
});

test("without JSPI the viewer falls back to the whole file, and still paints", async ({ page }) => {
  const { served, stats } = await openPageOne(page, readFileSync(FIXTURE));
  expect(stats.mode).toBe("whole");
  expect(stats.cache).toBeNull();
  expect(served.count()).toBe(1);
});
