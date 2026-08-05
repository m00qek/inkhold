import { test, expect, type Page } from "@playwright/test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { FAST_3G, REAL, openPageOne, serveRanges, statsOf, inkFraction } from "./helpers/pdfRange";
import { signedIn, freezeMotion } from "./helpers/app";

// THE ACCEPTANCE, UNDER THE PROFILE IT IS JUDGED BY — `pdf-ranges.md` §7.
//
// 20x CPU slowdown + Fast 3G, driven over CDP exactly as the doc records it. An
// unthrottled dev box makes almost any implementation of this look fine,
// including the whole-file one, so a number taken there proves nothing about the
// thing being designed for.
//
// WHY IT IS OPT-IN (`PDF_THROTTLE=1`) rather than part of every run. The doc's
// second discipline is "measure on an idle machine", and the default suite is
// four Chromium workers in parallel — the one condition under which a 20x
// throttled number is noise. It is also minutes long BY CONSTRUCTION: that is
// what 3G means. So it is a spec, reproducible with one command, that does not
// pretend a busy laptop is a measurement rig:
//
//     PDF_THROTTLE=1 npx playwright test pdfThrottled --workers=1
//
// It takes a BEFORE as well as an after, on the same profile in the same run:
// the whole-file path is still in the tree as the no-JSPI fallback, so "what
// this used to cost" is not a memory, it is a measurement.

const RUN = process.env.PDF_THROTTLE === "1";

/**
 * The 20x CPU slowdown, over CDP exactly as §7 records it.
 *
 * The NETWORK half of the profile is not set here, and that is the correction
 * this file exists to record. `Network.emulateNetworkConditions` does not reach
 * a route Playwright fulfils — measured: with Fast 3G conditions applied, a
 * fulfilled 5 MB body arrived in 233 ms and a 1-byte one in 6 ms, against the
 * ~25 s and ~400 ms the profile describes. Setting it and believing it yields a
 * pure CPU measurement wearing a network label, which is exactly the kind of
 * number §7 says not to take. So the link is shaped where the bytes are, in the
 * route handler — `FAST_3G` in `helpers/pdfRange.ts`, the same 400 ms / 1.6 Mbit.
 */
async function throttle(page: Page): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 20 });
}

/**
 * Force the WHOLE-FILE path by taking JSPI away from the worker.
 *
 * The same trick `pdfNoJspi.spec.ts` explains: Chromium 149 ships JSPI as a
 * stable feature and no flag turns it off, and an init script cannot reach a
 * worker's global scope, so the worker's module is patched in transit. Here it
 * is not testing the fallback — it is the BEFORE measurement.
 */
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
    // The 26 MB sibling, NOT the 76 MB one. At Fast 3G's ~200 KB/s the big file
    // is ~7 minutes of pure transfer before a pixel — which is the finding, not
    // a number worth spending seven minutes of every measurement re-confirming.
    const body = readFileSync(REAL.compressed);
    const size = statSync(REAL.compressed).size;

    await throttle(page);
    await withoutJspi(page);
    await signedIn(page);
    const served = await serveRanges(page, body, FAST_3G);
    const started = Date.now();
    await page.goto("/#/note/n-files-manual");
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
