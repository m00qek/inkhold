import { test, expect, type Page } from "@playwright/test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { FAST_3G, REAL, openPageOne, serveRanges, statsOf, inkFraction } from "./helpers/pdfRange";
import { signedIn, freezeMotion } from "./helpers/app";

// Opt-in (`PDF_THROTTLE=1 npx playwright test pdfThrottled --workers=1`): a 20x
// throttled number is noise beside parallel workers. Measures the whole-file
// fallback as the before and the range path as the after.

const RUN = process.env.PDF_THROTTLE === "1";

/**
 * CPU only: CDP network emulation does not reach routes Playwright fulfils, so
 * the link is shaped in the route handler (`FAST_3G` in helpers/pdfRange.ts).
 */
async function throttle(page: Page): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 20 });
}

/** Patches the worker module in transit to remove JSPI (see pdfNoJspi.spec.ts). */
async function withoutJspi(page: Page): Promise<void> {
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
}

test.describe("page 1 on a throttled link (20x CPU + Fast 3G)", () => {
  test.describe.configure({ mode: "serial", timeout: 900_000 });

  for (const [name, path] of Object.entries(REAL)) {
    test(`${name}: streamed blocks vs the whole file`, async ({ page }) => {
      test.skip(!RUN, "set PDF_THROTTLE=1 and run --workers=1 on an idle machine");
      test.skip(!existsSync(path), `${path} is not on this machine`);
      const body = readFileSync(path);
      const size = statSync(path).size;

      await throttle(page);
      const started = Date.now();
      const { served, stats } = await openPageOne(page, body, FAST_3G);
      const after = Date.now() - started;

      console.log(
        `\n### ${name} — ${(size / 1e6).toFixed(1)} MB, 20x CPU + Fast 3G\n` +
          `  AFTER  (${stats.mode}): ${(after / 1000).toFixed(1)} s, ` +
          `${served.count()} requests, ${(served.bytes() / 1e6).toFixed(1)} MB ` +
          `(${((served.bytes() / size) * 100).toFixed(1)}% of the file)`,
      );
      expect(stats.mode).toBe("stream");
      expect(served.bytes()).toBeLessThan(size / 4);
    });
  }

  test("the BEFORE: the whole-file path on the smaller document", async ({ page }) => {
    test.skip(!RUN, "set PDF_THROTTLE=1 and run --workers=1 on an idle machine");
    test.skip(!existsSync(REAL.compressed), "the 26 MB document is not on this machine");
    // The 26 MB file, not the 76 MB one: that is ~7 minutes of transfer at Fast 3G.
    const body = readFileSync(REAL.compressed);
    const size = statSync(REAL.compressed).size;

    await throttle(page);
    await withoutJspi(page);
    await signedIn(page);
    const served = await serveRanges(page, body, FAST_3G);
    const started = Date.now();
    await page.goto("/#/note/178");
    await freezeMotion(page);
    await expect.poll(() => inkFraction(page), { timeout: 880_000 }).toBeGreaterThan(0.001);
    const before = Date.now() - started;
    const stats = await statsOf(page);

    console.log(
      `\n### BEFORE — ${(size / 1e6).toFixed(1)} MB whole-file, 20x CPU + Fast 3G\n` +
        `  ${(before / 1000).toFixed(1)} s, ${served.count()} request(s), ` +
        `${(served.bytes() / 1e6).toFixed(1)} MB (100% of the file)`,
    );
    expect(stats.mode).toBe("whole");
    expect(served.bytes()).toBe(size);
  });
});
