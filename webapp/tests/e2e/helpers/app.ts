import type { Page, Locator } from "@playwright/test";
import { mockApi } from "./mockApi";

// The library/reader run against the in-memory fake `Api` (no HTTP), so the only
// backend call to mock is the boot guard's `/api/user/me`. This puts the app in a
// signed-in state so a test can land straight on the library.
export async function signedIn(page: Page): Promise<void> {
  await mockApi(page, {
    "user/me": { json: { success: true, email: "ana@household.lan", isAdmin: false, mustChangePassword: false } },
  });
}

/**
 * Parse a computed colour into 0-255 channels.
 *
 * Handles `rgb()`/`rgba()` **and** `color(srgb r g b)` — which is what Chromium
 * returns for anything produced by `color-mix()`, as the reader toolbar's
 * background is. Its components are 0–1, not 0–255, so reading them raw yields
 * ~0.94 instead of ~241 and every contrast check against such a surface silently
 * reports a near-black backdrop. That is what made the outlined Export button
 * score 3.69 when its real ratio against the toolbar is 4.93.
 */
function parseRgb(value: string): [number, number, number] {
  const nums = value.match(/[\d.]+/g);
  if (!nums || nums.length < 3) throw new Error(`not a parseable colour: ${value}`);
  const scale = /^color\(\s*srgb\b/i.test(value.trim()) ? 255 : 1;
  return [Number(nums[0]) * scale, Number(nums[1]) * scale, Number(nums[2]) * scale];
}

/** WCAG relative luminance. */
function luminance(rgb: [number, number, number]): number {
  const [r, g, b] = rgb.map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * WCAG contrast ratio (1 = identical, 21 = black on white) between two computed
 * colour strings. A filled button whose label is the same colour as its own
 * background scores 1 — which is exactly how the Export button rendered as a
 * solid block.
 */
export function contrastRatio(a: string, b: string): number {
  const la = luminance(parseRgb(a));
  const lb = luminance(parseRgb(b));
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Computed foreground (and SVG stroke) of the element a locator resolves to,
 * plus the background it is actually **painted against**.
 *
 * The background walks up to the first ancestor with a non-transparent
 * `background-color`. Reading the element's own is wrong for anything
 * transparent-backed — which is most controls here — because a computed
 * `rgba(0, 0, 0, 0)` reads as *black* to a contrast function, so a perfectly
 * legible dark-on-cream label scores as though it were dark-on-black. That
 * produced a bogus 3.71 for the outlined Export button whose real ratio against
 * the toolbar is 4.93.
 */
export async function paintedColours(
  locator: Locator,
): Promise<{ color: string; background: string; stroke: string | null }> {
  // RETRIED, because the thing being measured lives in a list that repaints
  // underneath it: a listing lands, the tree walk finishes, a category resolves.
  // A node detached between resolving the locator and reading it reports EMPTY
  // computed styles — `getComputedStyle` on an orphan returns "" for every
  // property — which reaches `parseRgb` as "not a parseable colour: " and fails
  // the test for a reason that has nothing to do with colour. Re-resolving is
  // the fix; the value itself is stable once the DOM is.
  for (let attempt = 0; ; attempt++) {
    const read = await readPaintedColours(locator);
    if (read !== null) return read;
    if (attempt >= 20) throw new Error("paintedColours: element kept detaching (20 attempts)");
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function readPaintedColours(
  locator: Locator,
): Promise<{ color: string; background: string; stroke: string | null } | null> {
  return locator.evaluate((el: HTMLElement) => {
    const transparent = (c: string) => !c || c === "transparent" || /,\s*0\s*\)$/.test(c);
    let node: Element | null = el;
    let background = "rgb(255, 255, 255)"; // canvas fallback if nothing opaque is found
    while (node) {
      const c = getComputedStyle(node).backgroundColor;
      if (!transparent(c)) {
        background = c;
        break;
      }
      node = node.parentElement;
    }
    const cs = getComputedStyle(el);
    // An orphaned node has an empty computed style for everything. That is the
    // signal to re-resolve rather than to parse "" as a colour.
    if (!cs.color) return null;
    const svg = el.querySelector("svg");
    return {
      color: cs.color,
      background,
      stroke: svg ? getComputedStyle(svg).stroke : null,
    };
  });
}

/**
 * Fraction of "ink" pixels on a canvas — pixels whose luminance deviates strongly
 * from the paper background (sampled from the top-left corner). Theme-agnostic:
 * it catches high-contrast handwriting (dark-on-light OR light-on-dark) but not
 * the faint ruled lines, so a blank placeholder reads ≈0 in either theme while a
 * rendered page reads clearly higher. This is the pixel-probe the mockup used to
 * prove lazy rendering. Returns 0 for an unsized/blank canvas.
 */
export async function inkFraction(canvas: Locator): Promise<number> {
  // Retried for the same reason as `paintedColours`: the gallery repaints under
  // this read, and a canvas detached mid-read has width/height 0 — which would
  // report as "no ink" and fail (or falsely pass) an ink assertion.
  for (let attempt = 0; ; attempt++) {
    const v = await readInkFraction(canvas);
    if (v !== null) return v;
    if (attempt >= 20) throw new Error("inkFraction: canvas kept detaching (20 attempts)");
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function readInkFraction(canvas: Locator): Promise<number | null> {
  return canvas.evaluate((el: HTMLCanvasElement) => {
    const ctx = el.getContext("2d");
    // A detached canvas reports 0×0. That is "unreadable", not "blank" — the
    // caller retries rather than recording a bogus 0.
    if (!el.isConnected || el.width === 0 || el.height === 0) return null;
    if (!ctx) return null;
    const { data } = ctx.getImageData(0, 0, el.width, el.height);
    const lum = (i: number) => 0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!;
    const bg = lum(0); // corner = paper
    let marks = 0;
    const pixels = data.length / 4;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3]! > 10 && Math.abs(lum(i) - bg) > 90) marks++;
    }
    return marks / pixels;
  });
}

/**
 * Fraction of "ink" pixels on an `<img>`, by drawing it to an offscreen canvas and
 * running the SAME probe as {@link inkFraction}. This is the gallery's probe now
 * that its tiles are `<img src="blob:…">` rather than on-screen canvases: an
 * unpainted tile has no `src` (returns null → the caller retries or asserts
 * unpainted), a painted one exposes its decoded pixels through the canvas.
 *
 * The blob URL is same-origin, so `drawImage` does not taint the canvas and
 * `getImageData` is readable — the same guarantee the canvas probe relied on.
 */
export async function imgInkFraction(img: Locator): Promise<number> {
  for (let attempt = 0; ; attempt++) {
    const v = await readImgInkFraction(img);
    if (v !== null) return v;
    if (attempt >= 25) throw new Error("imgInkFraction: image never painted/decoded (25 attempts)");
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function readImgInkFraction(img: Locator): Promise<number | null> {
  return img.evaluate(async (el: HTMLImageElement) => {
    // Not painted (no src) or mid-decode → "unreadable", so the caller retries
    // rather than recording a bogus 0. An <img> the engine has not reached yet
    // shows the tile's sheet background, not ink.
    if (!el.isConnected || !el.src) return null;
    if (!el.complete || el.naturalWidth === 0) {
      try {
        await el.decode();
      } catch {
        return null;
      }
    }
    const w = el.naturalWidth;
    const h = el.naturalHeight;
    if (w === 0 || h === 0) return null;
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(el, 0, 0);
    let data: Uint8ClampedArray;
    try {
      data = ctx.getImageData(0, 0, w, h).data;
    } catch {
      return null; // tainted (should not happen for a same-origin blob)
    }
    const lum = (i: number) => 0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!;
    const bg = lum(0); // corner = paper
    let marks = 0;
    const pixels = data.length / 4;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3]! > 10 && Math.abs(lum(i) - bg) > 90) marks++;
    }
    return marks / pixels;
  });
}

/**
 * Whether an engine-managed gallery `<img>` has been PAINTED — i.e. the lazy
 * engine has swapped in an object URL. An off-screen tile has an empty `src` (it
 * shows the tile's sheet background), which is how "blank placeholder" reads now
 * that the gallery is `<img>`-backed rather than a drawn canvas.
 */
export async function imgPainted(img: Locator): Promise<boolean> {
  return img.evaluate((el: HTMLImageElement) => el.src.startsWith("blob:"));
}

/**
 * A 2x2 PNG, as base64. Small enough to inline, real enough that the browser
 * decodes it — so `naturalWidth > 0` is a genuine "the preview loaded", not just
 * "the element exists".
 */
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP8z8DAwMDAwMTAwMAAAA8EAQFa0S3fAAAAAElFTkSuQmCC";

/**
 * Serve the raw-file endpoint (`GET /file/:id`) in e2e.
 *
 * The library and reader run against the in-memory fake `Api`, which has no HTTP
 * behind it — but the image preview and the download link are REAL URLs the
 * browser fetches itself, not `Api` calls, so they need a real response. Images
 * get PNG bytes; anything else gets `Content-Disposition: attachment`, exactly as
 * the server does, so a download click behaves like a download.
 */
export async function mockRawFiles(page: Page): Promise<void> {
  await page.route(
    (url) => url.pathname.startsWith("/file/"),
    async (route) => {
      const download = route.request().url().includes("download=1");
      await route.fulfill({
        status: 200,
        contentType: download ? "application/octet-stream" : "image/png",
        headers: {
          "content-disposition": download ? 'attachment; filename="preview.bin"' : "inline",
          "x-content-type-options": "nosniff",
        },
        body: Buffer.from(TINY_PNG_BASE64, "base64"),
      });
    },
  );
}

/**
 * A 120×160 grayscale PNG with a large black band (~36% of the pixels), served
 * as the extracted embedded thumbnail — a `.spd`'s preview and a `.note`'s
 * cover alike. Real raster bytes are load-bearing twice over: the band gives
 * the pixel-probe REAL ink to see (a flat image would read as blank and prove
 * nothing), and it must be a PNG rather than an SVG because the facade
 * transcodes through `createImageBitmap`, which cannot decode SVG blobs — an
 * SVG here silently exercises the FALLBACK path instead of the fetch path.
 */
const THUMB_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAHgAAACgCAAAAADiYvdMAAAAZElEQVR42u3aAQ0AMAgEsfdvmqkAktEzUAOXWipgMBgMBoPBR+E0" +
  "BwaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAyegS03YDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAZ/Cz+nJdLCphXs6QAAAABJ" +
  "RU5ErkJggg==";

/** A short, legible text body so a `.txt` snippet rasterises to readable ink. */
const TEXT_BODY =
  "Reading list\n\n- The Left Hand of Darkness\n- Piranesi\n- A Canticle for Leibowitz\n\nReturn the library books on Friday.";

/**
 * The hit tallies {@link mockThumbnailBackend} keeps, so a test can assert not
 * just WHAT painted but WHICH route (and how often) produced it — e.g. that a
 * trashed image's raw bytes were fetched off the BIN route exactly once, or
 * that a `.spd` tile really came off its `/thumbnail/{hash}` extraction.
 */
export interface ThumbnailBackendHits {
  /** `/thumbnail/{hash}` requests — all of them, or only those for `hash`. */
  thumbnailHits(hash?: string): number;
  /** Live `/file/:id` requests — all of them, or only those for `id`. */
  fileHits(id?: string): number;
  /** Bin-scoped `/api/controlplane/bin/file/:id` requests — all, or per `id`. */
  binFileHits(id?: string): number;
}

/**
 * Serve the endpoints the thumbnail facade fetches from, in e2e.
 *
 * The library runs against the in-memory fake `Api`, but the facade's `.spd`,
 * `.note`-cover and `.txt` strategies make REAL browser fetches
 * (`/thumbnail/{hash}`, `/file/:id` — and, for a TRASHED file, the bin-scoped
 * `/api/controlplane/bin/file/:id` twin), so they need real responses. Every
 * `/thumbnail/{hash}` serves an extractable embedded thumbnail (the PNG above)
 * — a `.spd`'s embedded preview and a `.note`'s device-rendered cover come
 * through the same route on the real server too — EXCEPT hashes listed in
 * `coverless`, which 404 the way the server answers a `.note` with no user-set
 * cover (compute them with `fakeFileHash` from `src/api/fake`). A file id in
 * `textIds` serves `text/plain` so its snippet is legible, every other file id
 * a PNG — the same split `mockRawFiles` makes, folded in here so one mock owns
 * the raw-file surface. Both raw routes share the one split, exactly as the
 * real server serves the same blob from either scope.
 *
 * Returns the per-route hit tallies; callers that only need the serving can
 * ignore them.
 */
export async function mockThumbnailBackend(
  page: Page,
  opts: { textIds?: string[]; coverless?: string[]; delayMs?: number } = {},
): Promise<ThumbnailBackendHits> {
  const textIds = new Set(opts.textIds ?? []);
  const coverless = new Set(opts.coverless ?? []);
  // Optional held response on `/thumbnail/` only. The masonry reflow tests use
  // it to open a window in which a tile is provably UNPAINTED, so "the box was
  // final before the bytes arrived" is a real observation rather than a race.
  const delay = opts.delayMs ?? 0;

  const thumbHits: string[] = [];
  const fileHits: string[] = [];
  const binHits: string[] = [];
  const tally = (log: string[]) => (key?: string) => (key === undefined ? log.length : log.filter((k) => k === key).length);

  await page.route(
    (url) => url.pathname.startsWith("/thumbnail/"),
    async (route) => {
      const hash = decodeURIComponent(new URL(route.request().url()).pathname.slice("/thumbnail/".length));
      thumbHits.push(hash);
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      if (coverless.has(hash)) {
        await route.fulfill({ status: 404, body: "" });
        return;
      }
      await route.fulfill({ status: 200, contentType: "image/png", body: Buffer.from(THUMB_PNG_BASE64, "base64") });
    },
  );

  /** The raw-file split, shared by the live route and its bin-scoped twin. */
  const serveRawFile = async (route: Parameters<Parameters<Page["route"]>[1]>[0], id: string): Promise<void> => {
    if (textIds.has(id)) {
      await route.fulfill({ status: 200, contentType: "text/plain; charset=utf-8", body: TEXT_BODY });
      return;
    }
    const download = route.request().url().includes("download=1");
    await route.fulfill({
      status: 200,
      contentType: download ? "application/octet-stream" : "image/png",
      headers: {
        "content-disposition": download ? 'attachment; filename="preview.bin"' : "inline",
        "x-content-type-options": "nosniff",
      },
      body: Buffer.from(TINY_PNG_BASE64, "base64"),
    });
  };

  await page.route(
    (url) => url.pathname.startsWith("/file/"),
    async (route) => {
      const id = decodeURIComponent(route.request().url().split("/file/")[1]!.split("?")[0]!);
      fileHits.push(id);
      await serveRawFile(route, id);
    },
  );

  // Registered AFTER any `/api/` catch-all a scenario mock installed (Playwright
  // matches routes newest-first), so the bin's raw-bytes route answers with real
  // image/text bytes rather than the catch-all's bland JSON.
  await page.route(
    (url) => url.pathname.startsWith("/api/controlplane/bin/file/"),
    async (route) => {
      const id = decodeURIComponent(new URL(route.request().url()).pathname.split("/bin/file/")[1] ?? "");
      binHits.push(id);
      await serveRawFile(route, id);
    },
  );

  return { thumbnailHits: tally(thumbHits), fileHits: tally(fileHits), binFileHits: tally(binHits) };
}

/**
 * A gallery card's OPENING button, located by the note/folder name it shows.
 *
 * Use this instead of `getByRole("button", { name: /X/ })` for a card. A card now
 * holds two buttons that both carry the item's name — the opening button and the
 * overflow trigger, whose accessible name is "Actions for X" (deliberately: a
 * screen reader meeting a grid of identical "Actions" buttons learns nothing
 * about which card it is on). A bare name regex therefore matches both and trips
 * Playwright's strict mode.
 */
export function cardButton(page: Page, name: string | RegExp): Locator {
  return page.getByRole("button", { name }).and(page.locator(".card__open"));
}

/**
 * Wait until the folder rail has finished its tree walk.
 *
 * Until then the rail's categories are PROVISIONAL — all six are pinned from the
 * first paint, but which of them resolve to a real folder is not known yet, so
 * clicking one takes the "not resolved" path and the shell re-navigates once the
 * walk lands. That produces a second, delayed repaint of the gallery, and a test
 * that measured a card across it would read a detached node.
 *
 * Use this before clicking a category in any test that then MEASURES something
 * (computed style, bounding box). It is also what a real user waits for.
 */
export async function railSettled(page: Page): Promise<void> {
  await page.getByRole("navigation", { name: "Folders" }).and(page.locator('[aria-busy="false"]')).waitFor();
}

/**
 * Kill every transition and animation on the page, then wait a frame.
 *
 * MEASURE ONLY AFTER THIS. An automated tab is `visibilityState: hidden`, which
 * freezes transitions mid-flight — `getBoundingClientRect` and
 * `getComputedStyle` then hand back an INTERMEDIATE value that is neither the
 * before nor the after, and an assertion written against either one flakes.
 */
export async function freezeMotion(page: Page): Promise<void> {
  await page.addStyleTag({
    content: `*, *::before, *::after {
      transition: none !important;
      animation: none !important;
    }`,
  });
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
}
