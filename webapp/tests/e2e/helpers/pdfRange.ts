import { expect, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { signedIn, freezeMotion } from "./app";

// Shared machinery for the range-served PDF specs: a Range-honouring route,
// the ink probe, and the diagnostic the worker publishes.
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

export const REAL = {
  /** 76 MB, 77 pages, A4, LINEARIZED — page 1 sits at the front. */
  linearized: "/home/rock-cavy/Downloads/2022-03 Plano diretor de Natal.pdf",
  /** 26 MB, the same document, NOT linearized — the opposite access pattern. */
  compressed: "/home/rock-cavy/Downloads/2022-03 Plano diretor de Natal_compressed.pdf",
};

export const FIXTURE = fileURLToPath(new URL("../../../wasm/tests/fixtures/two-page.pdf", import.meta.url));

export interface CacheStats {
  requests: number;
  bytesFetched: number;
  reads: number;
  bytesRead: number;
  hits: number;
  misses: number;
  blockSize: number;
  readAhead: number;
  blocksResident: number;
  bytesResident: number;
  evictions: number;
  wholeResponses: number;
  ranges: Array<[number, number]>;
  readPattern: Array<[number, number]>;
  logTruncated: boolean;
}
export interface SessionStats {
  mode: "stream" | "whole" | null;
  cache: CacheStats | null;
}

/**
 * Serve `body` the way the Zig raw route does since `d464895`: `206` with a
 * `content-range` for a satisfiable range, `416` when it is not, and
 * `accept-ranges` on everything.
 *
 * Playwright's `page.route` DOES intercept a dedicated worker's `fetch`,
 * `Range` header and all — checked before this design was committed to, because
 * the whole point is that the requests come from the worker and not the page.
 */
export interface LinkShape {
  /** Round trip, in ms, charged once per request. */
  latencyMs: number;
  /** Download throughput, in bytes per second. */
  bytesPerSecond: number;
}

/** Chrome DevTools' "Fast 3G": 400 ms RTT, 1.6 Mbit/s down. */
export const FAST_3G: LinkShape = { latencyMs: 400, bytesPerSecond: (1.6 * 1024 * 1024) / 8 };

export async function serveRanges(
  page: Page,
  body: Buffer,
  shape?: LinkShape,
  /**
   * Which raw-file requests this serves. Defaults to EVERY `/file/…`, which is
   * what a viewer spec wants (one document on screen, nothing else asking for
   * bytes). A GALLERY spec needs the narrow form: the folder around the PDF is
   * full of images and `.txt` files whose tiles fetch the same route, and
   * handing them PDF bytes would break every other tile in the grid.
   */
  match: (url: URL) => boolean = (url) => url.pathname.startsWith("/file/"),
): Promise<{ count: () => number; bytes: () => number }> {
  let count = 0;
  let bytes = 0;
  /**
   * Charge the response what the link would charge it.
   *
   * NOT what CDP's `Network.emulateNetworkConditions` does, because it does not
   * reach here: a route fulfilled by Playwright never touches the browser's
   * network stack, so the emulation applies to nothing. MEASURED — with Fast 3G
   * conditions set, a fulfilled 5 MB body arrived in 233 ms and a 1-byte one in
   * 6 ms, where the profile says ~25 s and ~400 ms. A "throttled" number taken
   * that way is a CPU number wearing a network label. So the shaping is done
   * here, where the bytes actually are.
   */
  const charge = async (n: number): Promise<void> => {
    if (!shape) return;
    const ms = shape.latencyMs + (n / shape.bytesPerSecond) * 1000;
    await new Promise((r) => setTimeout(r, ms));
  };
  await page.route(
    (url) => match(url),
    async (route) => {
      count++;
      const header = route.request().headers()["range"];
      const m = header ? /^bytes=(\d*)-(\d*)$/.exec(header.trim()) : null;
      const headers: Record<string, string> = {
        "accept-ranges": "bytes",
        "x-content-type-options": "nosniff",
      };
      if (!m) {
        bytes += body.length;
        await charge(body.length);
        await route.fulfill({ status: 200, contentType: "application/pdf", headers, body });
        return;
      }
      const [, a, b] = m;
      let start: number;
      let end: number;
      if (a === "") {
        // `bytes=-N`: the LAST N bytes.
        start = Math.max(0, body.length - Number(b));
        end = body.length - 1;
      } else {
        start = Number(a);
        end = b === "" ? body.length - 1 : Math.min(Number(b), body.length - 1);
      }
      if (start >= body.length || start > end) {
        await charge(0);
        await route.fulfill({
          status: 416,
          headers: { ...headers, "content-range": `bytes */${body.length}` },
          body: "",
        });
        return;
      }
      const slice = body.subarray(start, end + 1);
      bytes += slice.length;
      await charge(slice.length);
      await route.fulfill({
        status: 206,
        contentType: "application/pdf",
        headers: { ...headers, "content-range": `bytes ${start}-${end}/${body.length}` },
        body: slice,
      });
    },
  );
  return { count: () => count, bytes: () => bytes };
}

/** The fraction of pixels that differ from the page's background. */
export async function inkFraction(page: Page): Promise<number> {
  return page.evaluate(() => {
    const c = document.querySelector(".pdf-page") as HTMLCanvasElement | null;
    if (!c || !c.width || !c.height) return -1;
    const ctx = c.getContext("2d");
    if (!ctx) return -1;
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    const lum = (i: number) => 0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!;
    const bg = lum(0);
    let marks = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3]! > 10 && Math.abs(lum(i) - bg) > 90) marks++;
    }
    return marks / (data.length / 4);
  });
}

export async function statsOf(page: Page): Promise<SessionStats> {
  await expect
    .poll(
      () =>
        page.evaluate(
          () => (globalThis as unknown as { __inkholdPdfStats?: SessionStats }).__inkholdPdfStats?.mode ?? null,
        ),
      { timeout: 20_000 },
    )
    .not.toBeNull();
  return page.evaluate(
    () => (globalThis as unknown as { __inkholdPdfStats?: SessionStats }).__inkholdPdfStats!,
  );
}

export async function openPageOne(page: Page, body: Buffer, shape?: LinkShape) {
  await signedIn(page);
  const served = await serveRanges(page, body, shape);
  await page.goto("/#/note/n-files-manual");
  await freezeMotion(page);
  await expect(page.getByRole("region", { name: "PDF viewer" })).toBeVisible();
  await expect.poll(() => inkFraction(page), { timeout: 120_000 }).toBeGreaterThan(0.001);
  return { served, stats: await statsOf(page) };
}

export function report(label: string, fileBytes: number, served: { count: () => number; bytes: () => number }, s: SessionStats): void {
  const c = s.cache!;
  const pattern = c.readPattern;
  const spans = pattern.map(([, len]) => len).sort((x, y) => x - y);
  const median = spans[Math.floor(spans.length / 2)] ?? 0;
  console.log(
    [
      ``,
      `=== ${label} (${(fileBytes / 1e6).toFixed(1)} MB on disk) ===`,
      `  mode                ${s.mode}`,
      `  HTTP requests       ${served.count()}  (cache says ${c.requests})`,
      `  bytes over the wire ${served.bytes()}  (${((served.bytes() / fileBytes) * 100).toFixed(1)}% of the file)`,
      `  block size          ${c.blockSize}   read-ahead ${c.readAhead}`,
      `  ranges              ${JSON.stringify(c.ranges)}`,
      `  host reads          ${c.reads}  (${c.hits} hits, ${c.misses} misses)`,
      `  bytes MuPDF asked   ${c.bytesRead}   median read ${median} B` + (c.logTruncated ? ` (over the first ${pattern.length} reads only — log truncated)` : ""),
      `  resident            ${c.blocksResident} blocks / ${c.bytesResident} B, ${c.evictions} evictions`,
      `  first 40 reads      ${JSON.stringify(pattern.slice(0, 40))}`,
      ``,
    ].join("\n"),
  );
}

