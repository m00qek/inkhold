import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { FIXTURE, openPageOne } from "./helpers/pdfRange";

// The FALLBACK, exercised rather than assumed.
//
// `docs/scratch/pdf-ranges.md` §6.1 leaves Firefox's and Safari's JSPI status
// open, so "download the whole file and open it from a buffer" is not a legacy
// branch kept for politeness — it is what some real browser is on today, and a
// path that is never run is a path that is broken.
//
// HOW JSPI IS TAKEN AWAY, and why it is done like this. Chromium 149 ships JSPI
// as a stable feature: `--js-flags=--no-wasm-jspi`, `--no-experimental-wasm-jspi`
// and `--disable-features=WebAssemblyJSPI` were all tried and all left
// `WebAssembly.Suspending` present. `addInitScript` is no use either, because the
// decision is made inside the WORKER, which has a global scope of its own. So the
// worker's own module is intercepted on its way to the browser and a line is put
// in front of it. That is the real detection running against a real absence.
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
  // No block cache at all on this path — there is nothing to cache blocks for.
  expect(stats.cache).toBeNull();
  // One plain GET, and no `Range` on it. That the page is PAINTED at the end of
  // it is already asserted inside `openPageOne`.
  expect(served.count()).toBe(1);
});
