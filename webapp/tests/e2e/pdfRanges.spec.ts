import { test, expect } from "@playwright/test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { FIXTURE, REAL, openPageOne, report } from "./helpers/pdfRange";

// RANGE-SERVED PDFs, end to end —
//
// The acceptance is not "it renders", which `pdfViewer.spec.ts` already proves.
// It is an ARITHMETIC claim: page 1 of a 76 MB document must cost a handful of
// requests and a few megabytes, because on a 3G link the alternative to that is
// seven minutes. So this file counts requests and bytes, and asserts about them.
//
// The two real documents are a deliberately CONTRASTING PAIR and they are not in
// the repo — 76 MB in git would be worse than the test is worth. They are read
// from an absolute path and the test skips itself when they are absent, so a
// clean checkout still runs the suite green; the committed 688-byte fixture
// covers what always has to work.

test.describe("range-served PDFs", () => {
  test("the committed fixture opens over the stream path, not the whole-file one", async ({ page }) => {
    // Always runs. It proves the JSPI transport is the one that was TAKEN —
    // everything below could pass on the fallback path and mean nothing.
    const { served, stats } = await openPageOne(page, readFileSync(FIXTURE));
    expect(stats.mode).toBe("stream");
    expect(stats.cache).not.toBeNull();
    // 688 bytes is one block, so the whole document is one request.
    expect(served.count()).toBe(1);
    expect(stats.cache!.reads).toBeGreaterThan(0);
    // EVERY read is a hit — `prime()` fetched block 0 before the open, so
    // nothing MuPDF asks for ever suspends. That is the coalescing the design
    // rests on, at the smallest scale where it is still visible.
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
      // THE ACCEPTANCE (§7): page 1 without downloading the document. Measured
      // at 3.8 MB of 79.5 MB (4.8%) and 3.5 MB of 27.0 MB (12.8%); a quarter is
      // the loose bound that would still catch a regression to whole-file.
      expect(served.bytes()).toBeLessThan(size / 4);
      // And bounded requests — the failure mode §1 is written against is one
      // request per read. Measured at 65 and 58 against ~100 and ~77 reads.
      expect(served.count()).toBeLessThan(150);
      expect(stats.cache!.hits).toBeGreaterThan(0);
    });
  }
});
