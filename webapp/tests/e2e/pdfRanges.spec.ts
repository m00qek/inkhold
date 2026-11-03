import { test, expect } from "@playwright/test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { FIXTURE, REAL, openPageOne, report } from "./helpers/pdfRange";

// Asserts request and byte counts for range-served PDFs. The two large documents
// are not in the repo; those tests skip when the files are absent.

test.describe("range-served PDFs", () => {
  test("the committed fixture opens over the stream path, not the whole-file one", async ({ page }) => {
    // Proves the JSPI transport was taken, else the rest could pass on the fallback.
    const { served, stats } = await openPageOne(page, readFileSync(FIXTURE));
    expect(stats.mode).toBe("stream");
    expect(stats.cache).not.toBeNull();
    expect(served.count()).toBe(1);
    expect(stats.cache!.reads).toBeGreaterThan(0);
    // `prime()` fetched block 0 before the open, so no read ever suspends.
    expect(stats.cache!.misses).toBe(0);
  });

  for (const [name, path] of Object.entries(REAL)) {
    test(`page 1 of the real ${name} document costs a handful of requests`, async ({ page }) => {
      test.skip(!existsSync(path), `${path} is not on this machine`);
      test.setTimeout(180_000);
      const size = statSync(path).size;
      const { served, stats } = await openPageOne(page, readFileSync(path));
      report(name, size, served, stats);

      expect(stats.mode).toBe("stream");
      // Measured 4.8% and 12.8% of the file; a quarter still catches a whole-file regression.
      expect(served.bytes()).toBeLessThan(size / 4);
      // Guards against one request per read (measured 65 and 58 for ~100 and ~77 reads).
      expect(served.count()).toBeLessThan(150);
      expect(stats.cache!.hits).toBeGreaterThan(0);
    });
  }
});
